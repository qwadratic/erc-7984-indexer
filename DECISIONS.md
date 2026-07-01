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
- On every transfer/wrap/unwrap: upsert a `balances` row for each non-zero `from`/`to`, advancing `lastActivityBlock = event.block.number` (the signal the worker uses to re-capture a stale balance handle)

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

**`balances`** — `(address, token) PK → lastActivityBlock`. Indexer-owned: the handler only advances `lastActivityBlock`. The captured balance handle lives in the worker-owned side table `app.balance_handle`, kept off any Ponder-triggered table so worker writes can't pollute the reorg log (Ponder snapshots every write to its tables via an `AFTER INSERT/UPDATE/DELETE` row trigger). Staleness is derived: a captured handle is current iff `handle_block ≥ lastActivityBlock`.

**`app.balance_handle`** — `(token, address) PK → handle, handle_block, captured_at`. Worker-owned HEAD capture of each delegated holder's current balance handle. Sibling to `app.cleartext`: outside Ponder's schema so the worker never writes a reorg-triggered table, and it survives a Ponder schema redeploy. Joined back in the balance API.

**`app.cleartext`** — `cleartext(handle PK, value numeric, status text, decrypted_at timestamptz, claimed_by text, claimed_at timestamptz)`. The decrypt worker writes via `INSERT … ON CONFLICT DO UPDATE`. API reads via a separate `pg` pool (`src/cleartext-store.ts`). It is a **content-addressed index** — one row per *distinct* ciphertext, with `token_event.amount_handle` / `app.balance_handle.handle` as references into it. The claim columns are the parallel-worker split authority (see § Decrypt Worker Design).

## Decrypt Worker Design

The decryption pipeline is the hard part, not the indexing.

### Per-delegator pass: balance gate → batch transfers

One loop, per readable delegator each tick:

**(1) Current balance** — if the worker has no captured handle for the holder, or its `handle_block` predates the holder's `lastActivityBlock`, read `confidentialBalanceOf(addr)` at HEAD (one RPC) and upsert `app.balance_handle` (`handle` + `handle_block`). Decrypt the balance handle first — a successful decrypt doubles as the **propagation gate**. On `DelegationNotPropagatedError`, skip the delegator this tick (handles stay pending, retry next tick).

**(2) Transfer amounts** — if propagated, batch-decrypt the delegator's undecrypted transfer `amountHandle`s via `delegatedBatchDecryptValues` (per-entry error isolation: one bad/unpropagated handle doesn't sink the chunk).

**Balance history**: NOT decrypted/reconstructed. Deferred.

### Counterparty-dedup, generalized to a distinct-handle index gate

Before decrypting any handle, skip it if it already exists in `app.cleartext`. A shared transfer-amount handle decrypted via one party is reused for the counterparty — never decrypt the same handle twice. Checked explicitly via `getExistingHandles` before every decrypt batch.

The load-bearing generalization: **a handle is a content identifier — identical ciphertext ⇒ identical `bytes32`.** So the worker's unit of work is the *distinct unseen ciphertext*, not the handle count. Counterparty-dedup is just the two-party case. The worker drains a **distinct-handle frontier**: per tick it collapses (a) repeats already in `app.cleartext`, (b) duplicates within one delegator's list, and (c) the same handle shared across delegators in that tick — into one decrypt. This is the single change that makes the decrypt rate depend on how much *distinct* cleartext exists, not on how many handles the chain emits. See *Break-even* below for why that is the only defense that scales.

### Relay parallelism

Relay concurrency is bounded by `delegatedBatchDecryptValues`' own `maxConcurrency` (= `DECRYPT_RELAY_CONCURRENCY`, default 10), so the worker manages no concurrency of its own. The balance gate uses `delegatedDecryptValues` (single handle); transfer amounts use the batch variant.

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

Premise: RPC with decent rate limits → fresh sync fast, resyncs cheap (Ponder cache + reindex strategies). ERC-20-style transfer-event indexing is the dominant, community-optimized path → assumed NOT the bottleneck. So the weakest link is decryption, deliberately made independent of indexing (it only needs handles + the identities they're bound to, treated as given). The throughput readout in the flow test (`tests/flow.e2e.ts`, delegation-spike → cleartext resolution) exists to prove exactly that boundary — what breaks first is relayer throughput / propagation under a simultaneous-delegation spike; the test measures decryption bandwidth (bytes/sec) on the fresh per-run delta to prove it.

**Measured (cold, funded Sepolia run — 190 fresh handles, ~0.10 ETH @ ~1.4 gwei):** the relayer round-trip is a fixed ~2.4–3.7s regardless of batch size, so a bigger batch amortizes it almost linearly. Cold per-handle latency: **2449 ms (B=1) → 581 (4) → 309 (8) → 150 (16) → 131 ms (28)** — 18× from batching alone (1 euint64 = 8 bytes). A single batch-28 request = **7.6 handles/s ≈ 61 B/s**; eight parallel batch-8 requests top out at **13.7 handles/s ≈ 110 cleartext bytes/s (0.107 KB/s)** — the measured ceiling. Concurrency scales **sublinearly** (P=8 only ~1.8× a single request): the shared Sepolia relayer serializes. No 429 even at 64 concurrent cached requests, so its hard rate wall was never reached. This **revises the earlier warm projection (~0.9 KB/s) down ~8×.** Reproduce: `recordings/stress.ts PHASE=all`; raw rows in `recordings/stress-result.json`.

### Break-even: how many transfers/sec before the worker can't keep up

The worker falls permanently behind when cleartext **arrives faster than it decrypts**. Two rates decide it:

- **Service rate S** — handles/sec the worker decrypts. **Measured cold: ~13.7 handles/s ≈ 110 bytes/s** ceiling (batch-28 × concurrency-8; a single batch-28 request is 7.6/s). See *Measured* above.
- **Arrival rate** — `transfers/sec × K`, where K = decryptable handles per transfer.

Break-even is just **`transfers/sec = S / K`**.

**cWETH (K=1) edges it out — barely.** Each transfer mints one fresh handle for ~460k gas, so the token's own arrival is capped at **~10.9 transfers/sec** (60M Sepolia block gas ÷ 460k ÷ 12s). Measured worker S ≈ **13.7/sec** — only **1.26×** the chain cap. So a single cWETH token can't be made to outrun the worker (gas throttles the producer first), but the margin is thin; on the shared testnet real arrival sits well under the cap, and a dedicated relayer or higher concurrency widens it.

**A structural token can.** `evm/src/ConfidentialBasketMock.sol` is the stressor: a K-slot position whose one `basketTransfer` fans out into K `ConfidentialTransfer` logs — 1 real new ciphertext (~460k gas) plus K-1 re-emits of a *shared* template handle, each just a LOG4 (the EVM event opcode with 4 indexed topics, ~1,875 gas). So K× the handles at ~1× the gas. Arrival climbs to `~10.9×K`/sec while gas stays flat, so break-even collapses to **`S/K`** — **K=64 → ~0.21 tx/s, K=256 → ~0.05 tx/s** (measured S). The chain clears that trivially, so a structural token drowns the worker almost immediately. Grow the structure, the worker drowns. It reuses the inherited event, so the existing indexer and ABI ingest the extra handles unchanged.

**The fix is structural, not constant-factor.** Bigger batches and more concurrency only raise S — they leave the `1/K` cliff intact. But the K-1 template handles are all the *same* ciphertext, so they decrypt once. The distinct-handle gate in `scripts/decrypt-worker.ts` folds them out, making break-even **flat in K** (≈ S) instead of `S/K`. That removes K from the denominator. It belongs in the indexer because indexing is ours to scale; the relayer is not. (`recordings/bigstruct-boundary.ts` models the 1/K-vs-flat shape; warm-bounded, but the shape holds regardless of the constants.)

**Does this apply to cWETH? The cliff is the basket's, not the wrapper's.** cWETH emits one fresh handle per transfer: `transferred = FHE.select(success, amount, 0)` (`ERC7984.sol:292`) is computed anew each time, so K=1 — no template, no cheap handle inflation. On cWETH the gate degrades to its honest floor, counterparty-dedup: an A→B transfer's amount handle is the same `bytes32` for both parties' queries, so when both delegate in a spike the gate collapses it to one decrypt (~2× ceiling, already mostly covered by the per-tick DB dedup). So on cWETH the change is correct, idempotent, and throughput-neutral; it only earns its keep when the indexer is pointed at a structurally-inflating token. The finding is real — it describes the instrument, and names what a token must look like (cheap per-transfer handle fan-out) before the worker can be drowned at all.

### Time sink

Most cognitive load went to finding the right way to attack the bottleneck: kept focus on decryption, stood up the detached `app.cleartext` schema early, then hunted (taste-guided) for the undocumented SDK methods that batch *pure* handle decryption — not envelopes like `confidentialBalanceOf` (great for a balance; no equivalent for handles embedded in events). The belief that a low-level batch decrypt exists (`delegatedBatchDecryptValues`) and can be scheduled cleverly was the journey; not certain the current solution is optimal. Also invested early in understanding propagation and pre-empting pitfalls before the first line of code.

### AI assistance

I used AI on three fronts — (1) ramping fast on protocol architecture and the undocumented SDK surface; (2) externalizing, ordering, and prioritizing a flood of ideas; (3) a first autonomous agentic coding session that produced a working demo but with mediocre code/doc taste, then a second iterative session to make implementation + docs coherent and sharp. Failure mode worth naming: LLMs confidently hallucinate event names and SDK methods for code not in their weights; the fix is to co-pilot — keep the agent grounded in the actual repo and point it at the load-bearing specifics. Two concrete catches: it fabricated ACL event names/args (corrected by reading the actual `ACLABI` — the real events are `DelegatedForUserDecryption` and `RevokedDelegationForUserDecryption`), and it omitted a local-dev stack entirely — which turned out correct, since real decryption needs Sepolia relays and a local fhEVM would have optimized the wrong thing.

## SDK Feedback

1. **Could the request-size cap guide the caller?** From `Decryption.sol:151` (`MAX_DECRYPTION_REQUEST_BITS = 2048`) and the relayer-sdk's `check2048EncryptedBits`, an oversized batch throws *"Cannot decrypt more than 2048 encrypted bits"* — but the SDK doesn't expose that budget or the safe chunk size, so consumers hardcode it (our `HANDLES_PER_REQUEST = 28`), a coupling that breaks if the protocol changes the constant. Would exposing `maxDecryptionBits` as a queryable value — or an optional auto-chunking mode on `delegatedDecryptValues` — be better for server-side workloads? (Feedback section to be refined later from `IDEAS.md`.)
2. **Propagation-readiness needs docs (not an API).** A universal `isPropagated()` can't exist — it needs an offchain source of truth, and the SDK correctly trusts onchain truth. That's the right call, but it should be surfaced/documented so integrators build a propagation gate instead of hitting `DelegationNotPropagatedError` blind.
