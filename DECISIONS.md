# DECISIONS

## Thesis

A wallet partner wants ERC-20-style reads over ERC-7984 confidential tokens. This indexer sits at the seam: FHE handles come in from the chain, cleartext rows go out through the API. The hard part isn't indexing events — it's that a transfer or balance can be **seen on-chain but not yet decryptable** (no delegation to us yet). We retain it, surface it honestly as `pending_rights`, and backfill cleartext the moment delegation lands. Because only our own accounts delegate to us, load is **spiky** — handles pile up, then accounts delegate near-simultaneously — so **decryption throughput under that spike is the core performance concern**.

## Boundary & framing

Three load-bearing choices.

**Cleartext grinder, not an app.** We ship no auth, sessions, or product logic. Given capped relay resources and what decryption physically needs (a set of handles and the identities they're bound to), we just grind cleartext. Auth and revocation-UX belong to the wallet partner; staying agnostic to that is the design.

**Decryption decoupled from indexing.** Indexer code never calls the SDK. It produces reorg-stable onchain tables (`token_event`, `balances`, `delegation_event`) that a separate offchain worker reads to schedule and execute cleartext backfill. The value is in the *scheduling* strategy — an almost-entirely offchain problem the indexing framework can't help with beyond cross-schema queries. (A now-fixed SDK/Vite-SSR blocker once *forced* the split; it's a product choice today — see *Single Postgres*.) Indexing and decryption evolve independently.

**Non-opinionated scheduling.** A working hypothesis, not baked into code: one decrypt primitive for everything; never decrypt outdated balance handles, only HEAD; prioritize tail (latest) txs, but run historical backfill at a predictable rate we hold levers on. The worker's per-delegator loop (balance gate → batch transfers, newest-first) is the current instantiation, not a hard-coded policy. The designed next step — since the SDK does no implicit cross-call batching (verified) — is a **decrypt scheduler**: one queue per delegator, flushing on batch-full (2048-bit) or an SLA deadline, coalescing across delegators. See `IDEAS.md`.

## Access model: indexer identity vs per-user decrypt

Today's Zama apps decrypt **interactively**: a user signs a permit and decrypts their own handles at read time. That fits a UI with the user present; it does not fit an indexer serving ERC-20-style reads to a wallet backend with no user in the loop.

So we introduce a dedicated **indexer identity** (one EOA) holding **delegated** decryption rights. A user delegates decryption for the token via one `ACL.DelegatedForUserDecryption` event; the indexer decrypts on their behalf *ahead of read time* and serves cleartext straight from Postgres — the partner never touches FHE.

The one unusual demand on wallet integration: **keep the delegation active.** A delegation carries a TTL (`newExpirationDate`); the wallet re-asks the user to sign on some cadence. That cadence is deliberately **left open until we measure real re-decrypt speed** — it should follow from the measurement, not a guess. Delegations can also be granted **forever** (max-uint64 expiry, `18446744073709551615`).

**Revocation ≠ erasure.** Revoking kills *live* access, not already-indexed cleartext: `app.cleartext` persists, so the API keeps returning previously-decrypted amounts while new balance reads go `pending_rights`. Shipping no auth surfaces (rather than papers over) the open product questions — full onchain-twin reveal semantics? reveal A↔B amounts to B when only A delegated?

**Identity-leak risk.** The indexer key is a single point of compromise: a leak means minting a new identity and asking ALL users to revoke + re-delegate. Systematic mitigations (out of scope here): rotating or per-user indexing identities.

## Architecture

**Why Ponder.** Many indexers share one Postgres across schemas (a fresh re-index runs alongside the live one, no second DB); RPC responses cache in `ponder_sync` and are reused across restarts/redeploys (we never drop it), so re-syncing a seen range costs zero RPC; and it brings typed handlers, automatic reorg handling, and a built-in HTTP server — no hand-rolled poller.

**Single Postgres, two processes.** Ponder's indexed tables live in `public`; the worker's cleartext lives in `app.*`. Ponder (handlers + API) and the decrypt worker (SDK + Zama relay) are separate OS processes sharing one DB — separate crash domains, an independent polling loop. (This was once *forced* by the SDK's `node()` transport breaking under Ponder's Vite SSR; fixed in `@zama-fhe/sdk` 3.3.0-alpha.2, so it's now a product choice.)

**Log-only handlers (zero RPC).** Handlers do no `confidentialBalanceOf` / `readContract` — they index logs only:
- `Underlying:Transfer(to=TOKEN)` → wrap row with public `cleartextAmount`
- `ConfidentialTransfer` → transfer/wrap/unwrap row with `amountHandle`
- `UnwrapFinalized` → fill unwrap `cleartextAmount`
- `ACL.Delegated` / `RevokedForUserDecryption` → `delegation_event`

So backfill is pure log-fetch — no archive-RPC bottleneck. There's no `balances` table: a holder's last-activity block (the signal for re-capturing a stale balance handle) is derived on demand as `max(block_number)` over that address's `token_event` rows.

**Per-contract start blocks** (`ponder.config.ts`): `ERC7984ERC20Wrapper` ← `START_BLOCK`, `Underlying` ← `UNDERLYING_START_BLOCK`, `ACL` ← `ACL_START_BLOCK` (recent — network-wide busy; we only want our delegations). With indexed-arg filters (`Underlying.Transfer to=TOKEN`, `ACL delegate=INDEXER_ADDRESS`), log volume stays minimal.

## Data model

**`token_event`** — one row per `ConfidentialTransfer` (transfer / wrap from=0x0 / unwrap to=0x0). Holds `amountHandle` + `cleartextAmount` (non-null only for public wrap/unwrap amounts). PK = `event.id`.

**`delegation_event`** — append-only log of ACL events where `delegate == INDEXER_ADDRESS`, one row per grant/revoke. **No `active` column** — readability is computed from the latest event + expiration, so it can't drift.

*(No `balances` table.* A holder's last-activity block is derived from `token_event` — one onchain source of truth, no separate materialization, no per-transfer write. The only per-holder state is the worker-captured handle below.)

**`app.balance_handle`** — `(token, address) PK → handle, handle_block, captured_at`. The **one** balance-state table: the worker's HEAD capture of each delegated holder's current balance ciphertext (from a `confidentialBalanceOf` RPC — not present in any event, so it can't be derived). Sibling to `app.cleartext`, outside Ponder's schema so worker writes never hit a reorg-triggered table, and it survives a schema redeploy. Staleness is derived: the handle is current iff `handle_block ≥ max(block_number)` over the holder's `token_event` rows. Joined back in the balance API; the balance handle also serves the worker's propagation gate.

**`app.cleartext`** — `handle PK, value, status, decrypted_at, claimed_by, claimed_at`. A **content-addressed index**: one row per *distinct* ciphertext, referenced by `token_event.amount_handle` / `app.balance_handle.handle`. The worker writes via `INSERT … ON CONFLICT DO UPDATE`; the API reads via a separate `pg` pool (`src/cleartext-store.ts`). The claim columns are the parallel-worker split authority (below).

## Decrypt worker

The decryption pipeline is the hard part. One loop, per readable delegator each tick:

**(1) Balance gate.** If the worker has no captured handle, or its `handle_block` predates the holder's latest `token_event` activity block, read `confidentialBalanceOf(addr)` at HEAD (one RPC) and upsert `app.balance_handle`. Decrypt that balance handle first — a success doubles as the **propagation gate**; on `DelegationNotPropagatedError`, skip the delegator this tick.

**(2) Transfer amounts.** If propagated, batch-decrypt the delegator's undecrypted `amountHandle`s via `delegatedBatchDecryptValues` (per-entry error isolation: one bad handle doesn't sink the chunk). Balance *history* is not reconstructed — deferred.

**Distinct-handle index gate.** A handle is a content identifier — identical ciphertext ⇒ identical `bytes32` — so the worker's unit of work is the *distinct unseen ciphertext*, not the handle count. Before decrypting, skip any handle already in `app.cleartext`; within a tick, collapse (a) repeats already stored, (b) duplicates in one delegator's list, and (c) the same handle shared across delegators — into one decrypt. Counterparty-dedup (a shared A↔B amount decrypted once) is just the two-party case. This makes the decrypt rate depend on how much *distinct* cleartext exists, not how many handles the chain emits (see *Break-even*). Across parallel workers the claim columns are the authority: a Postgres-atomic per-handle claim ensures each distinct handle is decrypted by exactly one worker, with a TTL so a crashed claim is retried.

**Parallelism & limits.** Relay concurrency is bounded by `delegatedBatchDecryptValues`' own `maxConcurrency` (= `DECRYPT_RELAY_CONCURRENCY`, default 10). `HANDLES_PER_REQUEST = 28`: the gateway caps a request at **2048 total encrypted bits** (`Decryption.sol:151 MAX_DECRYPTION_REQUEST_BITS`, mirrored client-side by relayer-sdk's `check2048EncryptedBits`) — a bit budget, so euint64 = 64 bits → 32 max; we use 28, conservatively euint64-only. The batch method doesn't auto-chunk, so we do.

*Amount-handle ACL persistence (resolved, Sepolia 2026-06-27):* transfer amount handles are **not** transient-ACL — both historical amounts and current balances decrypt fine via `delegatedDecryptValues` after a delegation grant.

## Break-even: transfers/sec before the worker falls behind

The worker falls permanently behind when cleartext **arrives faster than it decrypts**. Break-even is **`transfers/sec = S / K`** — service rate `S` (handles/sec decrypted) over `K` (decryptable handles per transfer).

**Measured S (cold, funded Sepolia — 190 fresh handles, ~0.10 ETH @ ~1.4 gwei):** the relayer round-trip is a fixed ~2.4–3.7s regardless of batch size, so batching amortizes it almost linearly. Cold per-handle latency **2449 ms (B=1) → 581 (4) → 309 (8) → 150 (16) → 131 (28)** — 18× from batching alone. A single batch-28 request ≈ **7.6 handles/s**; eight parallel batch-8 requests top out at **~13.7 handles/s ≈ 110 cleartext bytes/s** — the ceiling. Concurrency scales **sublinearly** (P=8 ≈ 1.8× a single request): the shared Sepolia relayer serializes; no 429 even at 64 concurrent cached requests, so its hard wall was never hit. (This revises an earlier warm ~0.9 KB/s projection down ~8×.)

**cWETH (K=1) edges it out — barely.** Each transfer mints one fresh handle for ~460k gas, capping arrival at **~10.9 transfers/s** (60M block gas ÷ 460k ÷ 12s). Measured S ≈ 13.7/s — only **1.26×** the chain cap: gas throttles the producer before the worker drowns, but the margin is thin.

**A structural token can drown it.** `evm/src/ConfidentialBasketMock.sol` is the stressor: one `basketTransfer` fans out into K `ConfidentialTransfer` logs — 1 real new ciphertext (~460k gas) plus K-1 re-emits of a *shared* template handle, each a ~1,875-gas LOG4. K× handles at ~1× gas, so arrival climbs to `~10.9×K`/s while break-even collapses to `S/K` (**K=64 → ~0.21 tx/s, K=256 → ~0.05 tx/s**). The chain clears that trivially.

**The fix is structural, not constant-factor.** Bigger batches / more concurrency only raise `S` — they leave the `1/K` cliff intact. But the K-1 template handles are the *same* ciphertext, so they decrypt once: the distinct-handle gate folds them out, making break-even **flat in K (≈ S)**. It belongs in the indexer because indexing is ours to scale; the relayer is not.

**Does this touch cWETH? No — the cliff is the basket's, not the wrapper's.** cWETH computes `transferred = FHE.select(success, amount, 0)` fresh per transfer (`ERC7984.sol:292`), so K=1 — no template inflation. There the gate degrades to its honest floor (counterparty-dedup, ~2× under a delegation spike, mostly already covered by per-tick DB dedup): correct, idempotent, throughput-neutral. It earns its keep only against a structurally-inflating token — and names what such a token looks like: cheap per-transfer handle fan-out.

## Reflection

**Least confident under load.** Fresh sync is assumed fast and resyncs cheap (Ponder cache); ERC-20-style transfer indexing is the community-optimized common path, so it's assumed *not* the bottleneck. The weakest link is decryption — deliberately independent of indexing (it only needs handles + their bound identities). The flow test's throughput readout (delegation-spike → cleartext, `tests/flow.e2e.ts`) exists to probe exactly that boundary; the *Break-even* numbers above are what it found.

**Time sink.** Most effort went to *how* to attack the bottleneck: standing up the detached `app.cleartext` schema early, then hunting (taste-guided) for the undocumented SDK methods that batch *pure* handle decryption — not envelopes like `confidentialBalanceOf`. Betting that a low-level batch decrypt (`delegatedBatchDecryptValues`) existed and could be scheduled cleverly was the journey; not certain the current solution is optimal.

**AI assistance.** Used on three fronts: ramping on protocol/SDK surface; ordering a flood of ideas; and two agentic coding sessions (a first producing a working-but-mediocre demo, a second to sharpen code + docs). Failure mode worth naming: LLMs confidently hallucinate event names and SDK methods for code not in their weights — the fix is to keep the agent grounded in the actual repo. Two catches: fabricated ACL event names (corrected against the real `ACLABI` — `DelegatedForUserDecryption` / `RevokedDelegationForUserDecryption`), and an omitted local-dev stack that turned out *correct* to omit, since real decryption needs Sepolia relays.

## SDK feedback

1. **Expose the request-size cap.** An oversized batch throws *"Cannot decrypt more than 2048 encrypted bits"* (`Decryption.sol:151`, relayer-sdk `check2048EncryptedBits`), but the SDK exposes neither the budget nor a safe chunk size, so consumers hardcode it (`HANDLES_PER_REQUEST = 28`) — a coupling that breaks if the constant changes. A queryable `maxDecryptionBits`, or optional auto-chunking on `delegatedDecryptValues`, would fit server workloads better.
2. **Document propagation-readiness.** A universal `isPropagated()` can't exist — it needs an offchain source of truth, and the SDK rightly trusts onchain truth. Correct call, but it should be documented so integrators build a propagation gate instead of hitting `DelegationNotPropagatedError` blind.

## Key addresses (Sepolia)

| Contract | Address |
|----------|---------|
| cWETHMock (wrapper) | `0x46208622DA27d91db4f0393733C8BA082ed83158` |
| WETHMock (underlying) | `0xff54739b16576FA5402F211D0b938469Ab9A5f3F` |
| ACL (proxy) | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| Indexer (idx9) | `0xF2988048C7FE127b0a11E5BCD27557fcb445B133` |

Secrets via `psst`: `MNEMONIC`, `SEPOLIA_RPC_URL`.
