# IDEAS

Parking lot for beyond-scope ideas. **The feature set is frozen for this submission** —
these are explicitly *not* in scope, captured so the trade-offs stay visible.

## Access / wallet integration
- **Delegation-permit TTL + auto-renew.** Derive the re-sign cadence from *measured*
  backfill/decryption speed (don't guess). The wallet auto-prompts re-delegation
  before expiry for users who want continuous cleartext; an expired delegation
  degrades to `pending_rights` (honest), never an error.

## Decrypt pipeline
- **70/30 weighted scheduler** — ~70% latest/current, ~30% historical per cycle so
  pagination stays fast under deep history. (Current cut: balance/current first,
  transfers newest-first, no explicit split.)
- **Adaptive relay concurrency** — auto-tune `DECRYPT_RELAY_CONCURRENCY` / batch
  `maxConcurrency` from observed 429 rates instead of a static value.
- **Honest failure status** — persist `not_propagated` / `failed` in
  `app.cleartext.status` (currently always `decrypted`) so the API can distinguish
  "no rights yet" from "decrypt failed".
- **Dedicated relayer** — escape shared Sepolia relayer rate limits under load.

## Indexing performance
- TODO: research Ponder `setup` / factory / ordering / filtering / per-entity start blocks
  **with real web access** (exa) before relying on findings — prior offline-only research was
  discarded. Working assumption: current config (per-contract `startBlock` + indexed-arg
  filters + preserve `ponder_sync` schema on redeploy) is sound; ERC-20-style transfer
  indexing is the community-optimized common path, unlikely to be the bottleneck.

## Generalization
- **Multi-token** — drive the worker from `SELECT DISTINCT token FROM delegation_event`
  instead of a single env `TOKEN`; the tables are already token-keyed.

## Confidentiality
- **Shared-handle visibility** — a decrypted shared transfer amount is readable by a
  counterparty who never delegated. Options: per-user re-encryption, or scope
  cleartext exposure to the requesting (delegated) party only.

## Test methodology
- **Relayer caching is a feature, not a foe.** Historical handles are cache hits; each run
  only does real decrypt work on the *new* handles it mints. So throughput is measured on
  the fresh per-run delta — the realistic steady state (most history cached, only the new
  handles decrypted). Re-runs are cheap and repeatable.
- Recipients of test transfers are **unfunded accounts** (not delegating), so each amount
  handle is decryptable only via the sender — keeps the measurement clear of shared-handle
  counterparty interplay (the code is intentionally not aware of that distinction).

## Backlog — finalize local test plumbing (P3 prereq)
- **Real FHE inputs in `tests/runner.ts`** — Phase-1 `confidentialTransfer` currently passes a
  zero handle + empty proof placeholder; it cannot actually transfer. Generate real inputs via
  the Zama SDK (`createEncryptedInput(token,user).add64(amount).encrypt()` → `{handles,inputProof}`)
  so transfers execute and produce decryptable amount handles. **Blocks any spike run.**
- **Budget-gated preflight** — given live `cast gas-price` + measured per-op gas (see
  recordings/runbook.md), compute max-affordable `SPIKE_N` and ABORT if the config would exceed
  the remaining ETH budget. Prevents running dry mid-test.
- **anvil-fork harness** — fork at latest block for free/iterative gas measurement (validate that
  `FHE.fromExternal` input verification passes on a fork before relying on it for CT gas).
- **Runbook** — keep recording useful procedures as found (recordings/runbook.md).

## Future build — decrypt scheduler (validated by SDK grind)
The SDK (3.3.0-alpha.3) does **no implicit decrypt batching/queueing** — each
`decrypt*Values` call is an independent relayer round-trip (~2.5s warm / ~6s cold; measured).
WIP branches (`feat/batcher-utility`, credential-batching) batch *permits*, not decrypts;
`feat/sdk-236-relayer-back-pressure` only exposes 429 `retryAfterMs`. So the optimization is
ours to design — the "future build" the brief invites:
- **DecryptScheduler**: one queue per delegator/credential; flush on **batch-full (≤28)** OR a
  **configurable SLA deadline** (max wait before a lone request is sent); dedupe shared
  counterparty handles; bound in-flight per delegator via `maxConcurrency`. Amortizes the ~2.5s
  round-trip across up to 28 handles → ~11 handles/sec/delegator serial, ×concurrency parallel.
  Sketch in `recordings/sdk-batching-report.md` (c).
- When `sdk-236` ships, honor `RelayerRequestFailedError.retryAfterMs` (back-pressure).
- SDK gap: gateway handle-limit isn't exposed/auto-chunked — our `HANDLES_PER_REQUEST=28` is
  empirical; would break if the gateway limit changes.
