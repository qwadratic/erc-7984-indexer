# DECISIONS

## Thesis

A wallet partner wants ERC-20-style reads over ERC-7984 confidential tokens. This indexer sits at the seam: FHE handles come in from the chain, cleartext rows go out through the API. The hard part isn't indexing events — it's that a transfer or balance can be **seen on-chain but not yet decryptable** (no delegation to us yet). We retain it, surface it honestly as `pending_rights`, and backfill cleartext the moment delegation lands. Because only our own accounts delegate to us, load is **spiky** — handles pile up, then accounts delegate near-simultaneously — so **decryption throughput under that spike is the core performance concern**.

## Boundary & framing

Three load-bearing choices that shape everything else.

### Cleartext grinder, not an app

We don't build auth or product logic. The boundary is deliberate: given capped relay resources, the complexity of the decryption algorithm, and what decryption physically depends on (a set of handles and the identities they're bound to), we grind cleartext. Auth, sessions, and revocation-UX belong to the wallet partner; staying agnostic to that is the design.

### Decryption decoupled from indexing — for product reasons, not just SSR

A technical blocker originally forced a separate process — the SDK's `node()` transport used `import.meta.resolve`, which Ponder's Vite SSR rewrote to a non-existent symbol. As of `@zama-fhe/sdk` 3.3.0-alpha.2 (SDK-235 / #490) that blocker is **gone** (it now resolves via `createRequire(import.meta.url)`), so the separation is no longer technically required — fine, because that was always the *small* reason. The real one: all future value is in the decryption *scheduling* strategy — an almost-entirely offchain problem the indexing framework can't help with, except via cross-schema queries, which Ponder gives us. So indexer code never calls the SDK directly; it produces reorg-stable onchain tables (`token_event`, `balances`, `delegation_event`) that the offchain grinder reads to schedule and execute cleartext backfill. Indexing and decryption evolve independently.

### Foundational, non-opinionated scheduling

A working hypothesis, **not** baked into code: one decrypt primitive (batch or non-batch) for everything; never decrypt outdated balance handles — only HEAD; prioritize tail (latest) txs over historical, but still run historical backfill at a measurable, predictable completion rate we hold direct levers on. That rate is a *product lever* that changes with what users need from the API. The code keeps the strategy pivotable — the worker's per-delegator loop (balance gate → batch transfers, newest-first) is the current instantiation, not a hard-coded policy. The designed (not built) next step — since the SDK does **no** implicit cross-call batching (verified) — is a **decrypt scheduler**: one queue per delegator, flushing on batch-full (2048-bit) **or** a configurable SLA deadline, coalescing across delegators and honoring relayer back-pressure. See `IDEAS.md`.

## Crucial decisions

Supporting detail — each reinforces the framing above.

1. **Access via a delegated indexer identity** — not per-user, per-request decrypt. The load-bearing product decision; see *Access model* below.
2. **Retain the un-decryptable.** On-chain but not yet decryptable → kept as `pending_rights`, backfilled to cleartext the instant delegation lands. Never dropped.
3. **Log-only, zero-RPC indexing.** Handlers capture every handle on initial sync; backfill is pure log-fetch, no archive-RPC bottleneck.
4. **Throughput-first decrypt worker.** Separate process, right ordering — balance/current first, transfers newest-first — to survive the real load profile: handles accumulate, accounts delegate near-simultaneously, and we must decrypt + paginate fast.
5. **Counterparty-dedup (FHE nuance).** A transfer amount handle is shared by both parties; once decrypted via either delegation it's reused. `pending_rights` applies to *balance* handles (per-user), not shared amounts.

## Access model: indexer identity vs per-user decrypt

Today's Zama apps decrypt **interactively**: a user signs a permit and decrypts their own handles, per-user and per-handle, at read time. That fits a UI with the user present; it does **not** fit an indexer that must serve ERC-20-style cleartext reads to a wallet backend with no user in the loop.

Our decision: introduce a dedicated **indexer identity** (one EOA) that holds **delegated** decryption rights. Users delegate decryption for the token to the indexer via one `ACL.DelegatedForUserDecryption` event, and the indexer decrypts on their behalf *ahead of read time*, serving cleartext straight from Postgres — the partner calls us and never touches FHE.

The one unusual requirement this puts on wallet integration: **keep the user's delegation active.** A delegation carries a TTL (`newExpirationDate`); to keep seeing cleartext the wallet re-asks the user to sign a delegation on some cadence. That renewal period is deliberately **left open until we measure realistic backfill/decryption speed** — the refresh cadence should follow from how fast we re-decrypt after a delegation lands, not a guess.

Delegations can be granted **forever** (max-uint64 expiry, `18446744073709551615`) — once delegated and we're fast enough, the user effectively has permanent cleartext access through us.

**Revocation ≠ erasure**: revoking (`ACL.RevokedDelegationForUserDecryption`) kills *live* access, not already-indexed cleartext. The `app.cleartext` table persists; the API continues to return previously-decrypted amounts while new balance reads fail (`pending_rights`). This is *why we ship no auth* — it surfaces, rather than papers over, the unsolved product questions (full onchain-twin reveal semantics? reveal A↔B amounts to B when only A delegated?).

**Identity-leak risk**: the indexer key is a single point of compromise. Leak → mint a new identity + ask ALL users to revoke + re-delegate — hard to coordinate. Systematic mitigations (out of 4h scope, real-product depth): rotating identities, or per-user indexing identities.

## Architecture

### Why Ponder

- **Many indexers, one database.** Ponder runs multiple indexing instances in the same Postgres across separate schemas — a fresh re-index can run alongside the live one, no second DB.
- **Smart RPC caching.** Fetched blocks/logs/receipts are cached in the `ponder_sync` schema and reused across restarts and re-deploys, so re-syncing an already-seen range costs zero RPC. (We never drop `ponder_sync` on redeploy.)
- **Less glue.** Typed event handlers, automatic reorg handling, and a built-in HTTP server for the API — versus hand-rolling a log poller + reorg logic.

### Single Postgres

One Postgres instance hosts everything: Ponder's indexed tables in `public` and the decrypt worker's cleartext in `app.cleartext`. Two OS processes share the database — Ponder (event handlers + API) and the decrypt worker (SDK + Zama relay). The decrypt worker runs as a separate `tsx` process — a **product choice** (offchain decrypt scheduling, independent crash domain, polling loop). This was *also* once technically forced by the SDK's `node()` transport using `import.meta.resolve` (broken under Ponder's Vite SSR), but that blocker was fixed in `@zama-fhe/sdk` 3.3.0-alpha.2 (#490). Separate processes, shared database.

### Log-only handlers (zero RPC)

Event handlers do NO `confidentialBalanceOf` / no `context.client.readContract`. They index logs only:
- `Underlying:Transfer(to=TOKEN)` → wrap row with public cleartextAmount
- `ConfidentialTransfer` → transfer/wrap/unwrap row with amountHandle
- `UnwrapFinalized` → fill unwrap cleartextAmount
- `ACL.DelegatedForUserDecryption` / `ACL.RevokedDelegationForUserDecryption` → delegation_event
- On every transfer/wrap/unwrap: upsert a `balances` row for each non-zero `from`/`to` with `lastActivityBlock = event.block.number`, `stale = true`

This makes backfill pure log fetching — fast, no archive RPC bottleneck.

### Per-contract start blocks

Each contract has its own env-driven start block (`ponder.config.ts`):
- `ERC7984ERC20Wrapper` ← `START_BLOCK` (token deploy block)
- `Underlying` ← `UNDERLYING_START_BLOCK` (defaults to `START_BLOCK`)
- `ACL` ← `ACL_START_BLOCK` (recent — network-wide busy; we only want our delegations)

Combined with indexed-arg filters (`Underlying.Transfer to=TOKEN`, `ACL delegate=INDEXER_ADDRESS`), this keeps log volume minimal.

## Data Model

**`token_event`** — One row per `ConfidentialTransfer`. Covers transfer, wrap (from=0x0), and unwrap (to=0x0). Stores `amountHandle` + `cleartextAmount` (non-null for wrap/unwrap since those amounts are public). PK = `event.id`.

**`delegation_event`** — Append-only log of ACL delegation events where `delegate == INDEXER_ADDRESS`. One row per grant/revoke. **No `active` column** — readability computed from latest event + expiration vs now. Event-sourced: can't drift.

**`balances`** — `(address, token) PK → balanceHandle, handleBlock, lastActivityBlock, stale`. Handler marks stale on every event; worker refreshes handle at HEAD for delegated holders.

**`app.cleartext`** — `cleartext(handle PK, value numeric, status text, decrypted_at timestamptz)`. The decrypt worker writes via `INSERT … ON CONFLICT DO UPDATE`. API reads via a separate `pg` pool (`src/cleartext-store.ts`).

## Decrypt Worker Design

The decryption pipeline is the hard part, not the indexing.

### Per-delegator pass: balance gate → batch transfers

One loop, per readable delegator each tick:

**(1) Current balance** — if the holder's `balances` row is `stale` or missing a handle, read `confidentialBalanceOf(addr)` at HEAD (one RPC), write `balanceHandle` + `handleBlock` + `stale=false`. Decrypt the balance handle first — a successful decrypt doubles as the **propagation gate**. On `DelegationNotPropagatedError`, skip the delegator this tick (handles stay pending, retry next tick).

**(2) Transfer amounts** — if propagated, batch-decrypt the delegator's undecrypted transfer `amountHandle`s via `delegatedBatchDecryptValues` (per-entry error isolation: one bad/unpropagated handle doesn't sink the chunk).

**Balance history**: NOT decrypted/reconstructed. Deferred.

### Counterparty-dedup

Before decrypting any handle, skip it if it already exists in `app.cleartext`. A shared transfer-amount handle decrypted via one party is reused for the counterparty — never decrypt the same handle twice. Checked explicitly via `getExistingHandles` before every decrypt batch.

### Relay parallelism

Relay concurrency is bounded by `delegatedBatchDecryptValues`' own `maxConcurrency` (= `DECRYPT_RELAY_CONCURRENCY`, default 10) — no external `pLimit`. The balance gate uses `delegatedDecryptValues` (single handle); transfer amounts use the batch variant.

`HANDLES_PER_REQUEST = 28` — the gateway caps a request at **2048 total encrypted bits** (proven: `Decryption.sol:151 MAX_DECRYPTION_REQUEST_BITS` in zama-ai/fhevm; mirrored client-side by relayer-sdk's `check2048EncryptedBits`). It's a *bit* budget, not a handle count: euint64 = 64 bits → 32 max; we use 28 (conservative, euint64-only). The batch method does not auto-chunk, so we chunk.

## Amount-handle ACL persistence — RESOLVED ✓

Empirically tested on Sepolia (2026-06-27): **transfer amount handles ARE NOT transient-ACL.** Both historical transfer amount handles and current balance handles successfully decrypted via `sdk.decryption.delegatedDecryptValues` after granting delegation from account[0] to the indexer.

## Key Addresses

| | Sepolia |
|-|---------|
| cWETHMock (wrapper) | `0x46208622DA27d91db4f0393733C8BA082ed83158` |
| WETHMock (underlying) | `0xff54739b16576FA5402F211D0b938469Ab9A5f3F` |
| ACL (proxy) | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| Indexer (idx9) | `0xF2988048C7FE127b0a11E5BCD27557fcb445B133` |

Secrets via `psst` CLI: `MNEMONIC` (shared anvil + seed), `SEPOLIA_RPC_URL` (Alchemy archive).

## Reflection

### Least confident under load

Premise: RPC with decent rate limits → fresh sync fast, resyncs cheap (Ponder cache + reindex strategies). ERC-20-style transfer-event indexing is the dominant, community-optimized path → assumed NOT the bottleneck. So the weakest link is decryption, deliberately made independent of indexing (it only needs handles + the identities they're bound to, treated as given). The spiking-throughput test (`tests/runner.ts`, scenario `spiking-throughput`) exists to prove exactly that boundary — what breaks first is relayer throughput / propagation under a simultaneous-delegation spike; the test measures handles/sec on the fresh per-run delta to prove it.

**Measured so far (warm, n=12, cold start excluded):** the relayer round-trip is the fixed cost — ~2.4s/request whether it carries 1 or 3 handles — so batching amortizes (~2.9× at 3 handles; one request holds up to `HANDLES_PER_REQUEST=28`). The SDK does **no** implicit cross-call batching (verified in source), so that amortization is ours to drive. **Honest caveat:** every existing handle was decrypted before, so relayer-side caching can't be ruled out — true-cold latency, the batch-28 *saturation* curve, and concurrency scaling remain **hypotheses** pending a funded fresh-handle run.

### Time sink

Most cognitive load went to finding the right way to attack the bottleneck: kept focus on decryption, stood up the detached `app.cleartext` schema early, then hunted (taste-guided) for the undocumented SDK methods that batch *pure* handle decryption — not envelopes like `confidentialBalanceOf` (great for a balance; no equivalent for handles embedded in events). The belief that a low-level batch decrypt exists (`delegatedBatchDecryptValues`) and can be scheduled cleverly was the journey; not certain the current solution is optimal. Also invested early in understanding propagation and pre-empting pitfalls before the first line of code.

### AI assistance

I used AI on three fronts — (1) ramping fast on protocol architecture and the undocumented SDK surface; (2) externalizing, ordering, and prioritizing a flood of ideas; (3) a first autonomous agentic coding session that produced a working demo but with mediocre code/doc taste, then a second iterative session to make implementation + docs coherent and sharp. Failure mode worth naming: LLMs confidently hallucinate event names and SDK methods for code not in their weights; the fix is to co-pilot — keep the agent grounded in the actual repo and point it at the load-bearing specifics. Two concrete catches: it fabricated ACL event names/args (corrected by reading the actual `ACLABI` — the real events are `DelegatedForUserDecryption` and `RevokedDelegationForUserDecryption`), and it omitted a local-dev stack entirely — which turned out correct, since real decryption needs Sepolia relays and a local fhEVM would have optimized the wrong thing.

## SDK Feedback

1. **Could the request-size cap guide the caller?** From `Decryption.sol:151` (`MAX_DECRYPTION_REQUEST_BITS = 2048`) and the relayer-sdk's `check2048EncryptedBits`, an oversized batch throws *"Cannot decrypt more than 2048 encrypted bits"* — but the SDK doesn't expose that budget or the safe chunk size, so consumers hardcode it (our `HANDLES_PER_REQUEST = 28`), a coupling that breaks if the protocol changes the constant. Would exposing `maxDecryptionBits` as a queryable value — or an optional auto-chunking mode on `delegatedDecryptValues` — be better for server-side workloads? (Feedback section to be refined later from `IDEAS.md`.)
2. **Propagation-readiness needs docs (not an API).** A universal `isPropagated()` can't exist — it needs an offchain source of truth, and the SDK correctly trusts onchain truth. That's the right call, but it should be surfaced/documented so integrators build a propagation gate instead of hitting `DelegationNotPropagatedError` blind.
