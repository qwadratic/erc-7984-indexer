# ERC-7984 Confidential Token Indexer

Indexes one ERC-7984 confidential token, auto-decrypts transfer amounts via delegated decryption, exposes a cleartext REST API. A wallet partner calls it and never touches FHE.

Transfers seen but not yet decryptable are retained, not dropped. Cleartext backfills when delegation arrives. See `DECISIONS.md` for trade-offs.

Runs against **Sepolia** (real coprocessors, cWETHMock). Single-Postgres two-process design: Ponder indexes events (log-only, zero RPC in handlers), a separate decrypt worker decrypts FHE handles.

## Demo & live instance

- **Video walkthrough:** https://youtu.be/Nbf8xB8m720
- **Live indexer** (Sepolia, backfilling from the cWETHMock deploy block): **https://erc7984-indexer.exe.xyz** — REST API on port 80:
  - `GET /v1/health`
  - `GET /v1/accounts/:address/balance`
  - `GET /v1/accounts/:address/transfers?cursor=&limit=`

---

## Setup

```bash
pnpm install
cp .env.example .env.local        # fill in values
pnpm ponder codegen
```

### Postgres provisioning

Create the database:

```bash
createdb erc7984_indexer
```

That's it. The `app` schema and its tables (`cleartext`, `balance_handle`) are created automatically on first run by the decrypt worker and API; Ponder creates its own tables in `public`.

### Required environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PONDER_RPC_URL_11155111` | Sepolia archive RPC (`psst get SEPOLIA_RPC_URL`) | — |
| `TOKEN_ADDRESS` | ERC-7984 wrapper to index | — |
| `UNDERLYING_ADDRESS` | Underlying ERC-20 (wrap amount capture) | — |
| `ACL_ADDRESS` | Zama ACL contract (proxy) | — |
| `START_BLOCK` | Token deploy block | `0` |
| `UNDERLYING_START_BLOCK` | Underlying ERC-20 start block | `START_BLOCK` |
| `ACL_START_BLOCK` | ACL start block (recent — network-wide busy) | `START_BLOCK` |
| `MAX_RPS` | Ponder max RPC requests/sec | `5` |
| `DECRYPT_RELAY_CONCURRENCY` | Decrypt worker: max concurrent relay decryption requests | `10` |
| `PORT` | API port | `42069` |
| `INDEXER_PRIVATE_KEY` | Indexer identity — `INDEXER_ADDRESS` derived in code | — |
| `DATABASE_URL` | Postgres connection string (single DB for Ponder + cleartext) | — |

> **Note:** Full-history backfill from the deploy block (10162161) needs a higher-throughput RPC. On a free-tier key (~7 req/s) Ponder rate-limits; use a recent `START_BLOCK` for quick runs.

## Run

Two processes — start both:

```bash
# Terminal 1: Ponder (indexes events, serves API on :42069)
pnpm dev

# Terminal 2: Decrypt worker (decrypts FHE handles via delegated decryption)
pnpm decrypt
```

The preflight check (`pnpm preflight`) validates the token is ERC-7984 before Ponder starts. `pnpm dev` runs preflight automatically.

## API

Base URL: `http://localhost:42069` (default). Live instance: `https://erc7984-indexer.exe.xyz` (port 80).

### Primary endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/v1/accounts/:address/balance` | `{ address, handle, balance, status }` |
| `GET` | `/v1/accounts/:address/transfers?cursor=&limit=` | `{ items: [...], nextCursor }` |
| `GET` | `/v1/health` | `{ status, indexedBlock, lastEventBlock, pendingHandles, decryptedLast15m, readableUsers }` |

### Utility endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/v1/delegations` | `{ items: [...] }` — recent delegation events |
| `GET` | `/v1/economics` | `{ naiveDecryptAttempts, distinctHandles, dedupMultiplier, regime, ... }` — the decrypt dedup win, live. `regime: gas-bound` is normal (cWETH); `index-bound` means a structural token where the index is load-bearing. See [`ECONOMICS.md`](ECONOMICS.md). |
| `GET` | `/ready` | Ponder built-in: 200 caught up, 503 syncing |

**Status values:** `decrypted` · `pending` (delegated, decrypt in progress) · `pending_rights` (no delegation) · `no_ciphertext` (never wrapped)

## Test

One given/when/then flow test (`tests/flow.e2e.ts`) checks correctness and reports decryption throughput:

```bash
pnpm test            # CHAIN=local — anvil + cleartext FHE, reproducible, no spend
pnpm test:sepolia    # CHAIN=sepolia — live deployment + real relayer, yields a bytes/sec decryption-bandwidth readout
```

**GIVEN** a0 holds underlying, the indexed token is deployed, Ponder + worker are running.
**WHEN** randomized confidential transfers, 2 same-block delegations, and a short-window revoke.
**THEN** all events indexed (wrap, transfers, delegations, revocation), API correct (`pending_rights` for undelegated, `decrypted` for delegated, delegations/revocation/transfers served), worker resolves cleartext — with a decryption-bandwidth readout (bytes/sec on the fresh per-run delta) from delegation spike to resolution.

Transfer volume is env-parameterizable (`TRANSFER_COUNT`, `ACCOUNT_COUNT`) — small default locally (fast), scale up on Sepolia for a real throughput measurement.

Both envs need Ponder + the decrypt worker running and Postgres up. Local uses cleartext FHE (no KMS/relay); Sepolia exercises the real relayer.

## Architecture

```
Ponder (handlers)  ──→  Postgres (public schema: token_event, balances, delegation_event)
                                    ↕
Decrypt worker     ──→  Postgres (app schema: cleartext, balance_handle)
                                    ↕
Hono REST API      ←──  joins Ponder tables + app.cleartext + app.balance_handle
```

Handlers are zero-RPC (log-only). Per readable delegator, the decrypt worker decrypts the current balance handle at HEAD first (which doubles as a delegation-propagation gate — not propagated → skip the delegator), then batch-decrypts that delegator's transfer amounts via the Zama relay (`delegatedBatchDecryptValues`, per-entry error isolation). Counterparty-dedup ensures shared handles are never decrypted twice.

See `DECISIONS.md` for full rationale.
