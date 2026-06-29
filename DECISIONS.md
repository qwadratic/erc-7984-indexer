# DECISIONS

## Thesis

A wallet partner wants ERC-20-style reads over ERC-7984 confidential tokens. This indexer sits at the seam: FHE handles come in from the chain, cleartext rows go out through the API. The hard part isn't indexing events — it's that a transfer or balance can be **seen on-chain but not yet decryptable** (no delegation to us yet). We retain it, surface it honestly as `pending_rights`, and backfill cleartext the moment delegation lands. Because only our own accounts delegate to us, load is **spiky** — handles pile up, then accounts delegate near-simultaneously — so **decryption throughput under that spike is the core performance concern**.

## Crucial decisions

These few choices define the system; everything below is supporting detail.

1. **Access via a delegated indexer identity** — not per-user, per-request decrypt. The load-bearing product decision; see *Access model* below.
2. **Retain the un-decryptable.** A transfer/balance seen on-chain but not yet decryptable is kept and surfaced as `pending_rights`, then backfilled to cleartext the instant delegation lands. Never dropped.
3. **Log-only, zero-RPC indexing.** Handlers index logs only and capture *every* handle on the initial sync — backfill is pure log-fetch, nothing is missed, no archive-RPC bottleneck.
4. **Throughput-first decrypt worker.** A separate worker schedules decryption in the right order — ~70% latest/current, ~30% historical — to survive the real load profile: handles accumulate, then our accounts delegate near-simultaneously, and we must decrypt + paginate fast.
5. **Counterparty-dedup (FHE nuance).** A transfer amount handle is shared by both parties; once decrypted via either delegation it's reused, never re-decrypted — so a shared amount can read as `decrypted` for a counterparty who never delegated. `pending_rights` therefore applies to *balance* handles (per-user), not shared amounts.

## Access model: indexer identity vs per-user decrypt

Today's Zama apps decrypt **interactively**: a user signs a permit and decrypts their own handles, per-user and per-handle, at read time. That fits a UI with the user present; it does **not** fit an indexer that must serve ERC-20-style cleartext reads to a wallet backend with no user in the loop.

Our decision: introduce a dedicated **indexer identity** (one EOA) that holds **delegated** decryption rights. Users delegate decryption for the token to the indexer (one ACL delegation), and the indexer decrypts on their behalf *ahead of read time*, serving cleartext straight from Postgres — the partner calls us and never touches FHE.

The one unusual requirement this puts on wallet integration: **keep the user's delegation active.** A delegation carries a TTL; to keep seeing cleartext the wallet re-asks the user to sign a delegation permit on some cadence. That renewal period is deliberately **left open until we measure realistic backfill/decryption speed** — the refresh cadence should follow from how fast we re-decrypt after a delegation lands, not a guess. (See the spiking-throughput test and `IDEAS.md`.)

## Architecture

### Why Ponder

- **Many indexers, one database.** Ponder runs multiple indexing instances in the same Postgres across separate schemas — a fresh re-index can run alongside the live one, no second DB.
- **Smart RPC caching.** Fetched blocks/logs/receipts are cached in the `ponder_sync` schema and reused across restarts and re-deploys, so re-syncing an already-seen range costs zero RPC. (We never drop `ponder_sync` on redeploy.)
- **Less glue.** Typed event handlers, automatic reorg handling, and a built-in HTTP server for the API — versus hand-rolling a log poller + reorg logic.

### Single Postgres

One Postgres instance hosts everything: Ponder's indexed tables in `public` and the decrypt worker's cleartext in `app.cleartext`. Two OS processes share the database — Ponder (event handlers + API) and the decrypt worker (SDK + Zama relay). The decrypt worker runs as a separate `tsx` process because the Zama SDK's `node()` transport uses `import.meta.resolve`, which Ponder's Vite SSR context transforms into a non-existent symbol. Separate processes, shared database.

### Log-only handlers (zero RPC)

Event handlers do NO `confidentialBalanceOf` / no `context.client.readContract`. They index logs only:
- `Underlying:Transfer(to=TOKEN)` → wrap row with public cleartextAmount
- `ConfidentialTransfer` → transfer/wrap/unwrap row with amountHandle
- `UnwrapFinalized` → fill unwrap cleartextAmount
- ACL grant/revoke → delegation_event
- On every transfer/wrap/unwrap: upsert a `balances` row for each non-zero `from`/`to` with `lastActivityBlock = event.block.number`, `stale = true`

This makes backfill pure log fetching — fast, no archive RPC bottleneck.

### Per-contract start blocks

Each contract has its own env-driven start block:
- `ERC7984ERC20Wrapper` ← `START_BLOCK` (token deploy block)
- `Underlying` ← `UNDERLYING_START_BLOCK` (defaults to `START_BLOCK`)
- `ACL` ← `ACL_START_BLOCK` (recent — network-wide busy; we only want our delegations)

Combined with indexed-arg filters (`Underlying.Transfer to=TOKEN`, `ACL delegate=INDEXER`), this keeps log volume minimal.

### Balances table (replaces `balance_handle`)

**`balances`**: `(address, token) PK → balanceHandle (nullable), handleBlock (nullable), lastActivityBlock, stale`.

- **Handlers** upsert affected holders with `stale = true` on every event — zero RPC.
- **Decrypt worker** fills the current balance HANDLE at HEAD via ONE `confidentialBalanceOf(addr)` per stale delegated holder, then decrypts it.
- Balance HISTORY is not stored — reconstructable from a holder's token_events (deferred; no endpoint).

Rationale: backfill indexes only tx history (fast, log-only). Balances are a small derived table. Current balance handle is captured at HEAD. This separates the "what happened" (handlers, fast) from the "what is the current state" (worker, throttled).

## Data Model

**`token_event`** — One row per `ConfidentialTransfer`. Covers transfer, wrap (from=0x0), and unwrap (to=0x0). Stores `amountHandle` + `cleartextAmount` (non-null for wrap/unwrap since those amounts are public). PK = `event.id`.

**`delegation_event`** — Append-only log of ACL delegation events where `delegate == INDEXER_ADDRESS`. One row per grant/revoke. **No `active` column** — readability computed from latest event + expiration vs now. Event-sourced: can't drift.

**`balances`** — `(address, token) PK → balanceHandle, handleBlock, lastActivityBlock, stale`. Handler marks stale on every event; worker refreshes handle at HEAD for delegated holders.

**`app.cleartext`** — `cleartext(handle PK, value numeric, status text)`. The decrypt worker writes via `INSERT … ON CONFLICT DO UPDATE`. API reads via a separate `pg` pool.

## Decrypt Worker Design

The decryption pipeline is the hard part, not the indexing. **Premise:** keep every handle we can index on the initial sync, then immediately schedule decrypting all of them in the right order so the API can paginate as fast as possible. Ordering target: ~**70%** of each decrypt cycle on handles from the latest events / current balances, ~**30%** on historical backfill — newest-value-first, history catching up underneath. (Current cut: per-delegator balance/current first, then transfers newest-first; the explicit 70/30 weighting is a refinement — see Next priorities.)

### Per-delegator pass: balance gate → batch transfers

One loop, per readable delegator each tick:

**(1) Current balance** — if the holder's `balances` row is `stale` or missing a handle, read `confidentialBalanceOf(addr)` at HEAD (one RPC), write `balanceHandle` + `handleBlock` + `stale=false`. Decrypt the balance handle first — a successful decrypt doubles as the **propagation gate**. On `DelegationNotPropagatedError`, skip the delegator this tick (handles stay pending, retry next tick).

**(2) Transfer amounts** — if propagated, batch-decrypt the delegator's undecrypted transfer `amountHandle`s via `delegatedBatchDecryptValues` (per-entry error isolation: one bad/unpropagated handle doesn't sink the chunk).

**Balance history**: NOT decrypted/reconstructed. Deferred.

### Counterparty-dedup

Before decrypting any handle, skip it if it already exists in `app.cleartext`. A shared transfer-amount handle decrypted via one party is reused for the counterparty — never decrypt the same handle twice. This is checked explicitly before every decrypt batch.

### Relay parallelism

Relay concurrency is bounded by `delegatedBatchDecryptValues`' own `maxConcurrency` (= `DECRYPT_RELAY_CONCURRENCY`, default 10) — no external `pLimit`. The balance gate uses `delegatedDecryptValues` (single handle); transfer amounts use the batch variant.

`HANDLES_PER_REQUEST = 28` (gateway limit: 2048 bits; euint64 = 64 bits → max 32; use 28 for margin) — the batch method does not auto-chunk, so we chunk to stay under the gateway limit.

## Amount-handle ACL persistence — RESOLVED ✓

Empirically tested on Sepolia (2026-06-27): **transfer amount handles ARE NOT transient-ACL.** Both historical transfer amount handles and current balance handles successfully decrypted via `sdk.decryption.delegatedDecryptValues` after granting delegation from account[0] to the indexer.

## Amount-handle cross-user visibility

Transfer amount handles are shared between sender and receiver. Once decrypted via any delegator's access, the cleartext is globally available in `app.cleartext`. This means account[1]'s transfers may show `decrypted` amounts even without account[1]'s delegation — the handle was decrypted via account[0]'s delegation. The `pending_rights` status applies to **balance** handles, which are per-user and require that specific user's delegation.

## Revocation ≠ erasure

Already-decrypted cleartext persists after delegation revoke. The API continues to return previously-decrypted amounts. New balance reads fail (`pending_rights`), but historical data is retained.

## Key Addresses

| | Sepolia |
|-|---------|
| cWETHMock (wrapper) | `0x46208622DA27d91db4f0393733C8BA082ed83158` |
| WETHMock (underlying) | `0xff54739b16576FA5402F211D0b938469Ab9A5f3F` |
| ACL (proxy) | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| Indexer (idx9) | `0xF2988048C7FE127b0a11E5BCD27557fcb445B133` |

Secrets via `psst` CLI: `MNEMONIC` (shared anvil + seed), `SEPOLIA_RPC_URL` (Alchemy archive).

## Next priorities (next 4h)

1. **Weighted decrypt scheduler** — enforce the ~70/30 latest-vs-historical batch mix so pagination stays fast under deep history (current cut: balance/current first, transfers newest-first).
2. **Pending-decryption tracking** — track undecrypted handles per delegator (`cleartext_amount IS NULL`, absent from `app.cleartext`) to drive cleartext backfill scheduling/optimization.
3. **Adaptive relay parallelism** — auto-tune `maxConcurrency` based on 429 rates. Currently static `DECRYPT_RELAY_CONCURRENCY`.
4. **Full unwrap lifecycle** — `UnwrapRequested` tracking for in-progress visibility (currently only `UnwrapFinalized` indexed).
5. **Dedicated relayer** — escape shared Sepolia relayer rate limits if `429`s become frequent.
6. **Multi-token** — generalize config to index N wrappers with shared decrypt pipeline.

## SDK Feedback

1. **`delegatedBatchDecryptValues` is undiscoverable.** The delegated-decryption guide reads as balance-only. The generic batch method isn't cross-linked. **P1.**
2. **`DelegationNotPropagatedError` needs a readiness signal.** No `isPropagated()` or `waitForPropagation()`. **P1.**
3. **Cleartext relayer is a semantic cliff.** `cleartext()` transport decrypts instantly, silently skips ACL enforcement. **P2.**
