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
