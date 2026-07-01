# IDEAS

Parking lot for beyond-scope ideas. **The feature set is frozen for this submission** — these are explicitly *not* in scope, captured so the trade-offs stay visible.

## Decrypt pipeline
- **Distinct-handle index gate (LANDED).** Decrypt work scales with *distinct unseen ciphertext*, not handle count — a per-tick frontier dedups within-list and cross-delegator repeats, generalizing counterparty-dedup. This is what keeps break-even flat under the big-structure stressor (`ConfidentialBasketMock`, K handles/transfer); see DECISIONS *Break-even*. Next: a persistent handle→cleartext index (survives restarts) and a structural-handle skip list so known-constant slots never enter a batch.
- **Decrypt scheduler (headline future build).** The SDK does **no** implicit decrypt batching — each `decrypt*Values` call is an independent relayer round-trip (~2.4s warm / ~6s cold), and the WIP SDK branches batch *permits*, not decrypts. So the scheduling is ours to design: one queue per delegator/credential, flushing on **batch-full (≤28)** or a **configurable SLA deadline**, deduping shared counterparty handles, bounding in-flight via `maxConcurrency`. Amortizes the round-trip across 28 handles → **measured ~7.6 handles/s/delegator at batch-28**, ~13.7/s at concurrency-8 (sublinear — the shared Sepolia relayer serializes). When `sdk-236` ships, honor `RelayerRequestFailedError.retryAfterMs` (back-pressure).
- **70/30 weighted scheduler** — ~70% latest/current, ~30% historical per cycle so pagination stays fast under deep history. (Current cut: balance/current first, transfers newest-first, no explicit split.)
- **Adaptive relay concurrency** — auto-tune `DECRYPT_RELAY_CONCURRENCY` from observed 429 rates instead of a static value.
- **Honest failure status** — persist `not_propagated` / `failed` in `app.cleartext.status` (currently effectively always `decrypted`) so the API can distinguish "no rights yet" from "decrypt failed".
- **Dedicated relayer** — escape shared Sepolia rate limits under load.

## Access / wallet integration
- **Delegation-permit TTL + auto-renew.** Derive the re-sign cadence from *measured* re-decrypt speed (don't guess). The wallet re-prompts before expiry; an expired delegation degrades to `pending_rights` (honest), never an error.

## Generalization
- **Multi-token** — drive the worker from `SELECT DISTINCT token FROM delegation_event` instead of a single env `TOKEN`; the tables are already token-keyed.

## Confidentiality
- **Shared-handle visibility** — a decrypted shared transfer amount is readable by a counterparty who never delegated. Options: per-user re-encryption, or scope cleartext to the requesting (delegated) party only.

## Indexing performance
- Current config (per-contract `startBlock` + indexed-arg filters + preserved `ponder_sync` on redeploy) is assumed sound; ERC-20-style transfer indexing is the community-optimized common path, unlikely to be the bottleneck. Verify Ponder factory / ordering / filtering options with real web access before relying on any finding.

## Test methodology
- **Relayer caching is a feature, not a foe.** Historical handles are cache hits; each run does real work only on the *new* handles it mints, so throughput is measured on the fresh per-run delta — the realistic steady state. Re-runs are cheap.
- Test-transfer recipients are **unfunded** (non-delegating), so each amount handle is decryptable only via the sender — keeps the measurement clear of shared-handle counterparty interplay.

## Test plumbing backlog
- **Real FHE inputs at scale** — the flow test uses the SDK's `cleartext()` transport locally; on Sepolia, scale `TRANSFER_COUNT` for a meaningful throughput number.
- **Budget-gated preflight** — extend the existing Sepolia budget dry-run (`tests/flow.e2e.ts`) to compute a max-affordable spike size from live `cast gas-price` + measured per-op gas, aborting before it runs the wallet dry.
- **anvil-fork harness** — fork at latest block for free/iterative gas measurement (validate `FHE.fromExternal` input verification passes on a fork).
