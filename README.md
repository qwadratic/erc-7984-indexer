# ERC-7984 Confidential Token Indexer

Indexes one ERC-7984 confidential token, auto-decrypts transfer amounts via delegated decryption, exposes a cleartext REST API. A wallet partner calls it and never touches FHE.

Transfers seen but not yet decryptable are **retained — never dropped**. Cleartext backfills when delegation arrives. See `DECISIONS.md` for trade-offs.

Runs against **Sepolia** (real coprocessors, cWETHMock). Single-Postgres two-process design: Ponder indexes events (log-only, zero RPC in handlers), a separate decrypt worker decrypts FHE handles.

## 📺 Demo & live instance

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

Create the database and `app` schema:

```bash
createdb erc7984_indexer
psql erc7984_indexer -c "CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE IF NOT EXISTS app.cleartext (handle text PRIMARY KEY, value numeric, status text NOT NULL);"
```

Ponder creates its tables in `public` on first run. The decrypt worker uses `app.cleartext`.

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
| `GET` | `/v1/health` | `{ status, headBlock, decryptedLast15m, readableUsers }` |

### Utility endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/v1/delegations` | `{ items: [...] }` — recent delegation events |
| `GET` | `/ready` | Ponder built-in: 200 caught up, 503 syncing |

**Status values:** `decrypted` · `pending` (delegated, decrypt in progress) · `pending_rights` (no delegation) · `no_ciphertext` (never wrapped)

## Test

```bash
pnpm test            # principal-flow e2e on a local anvil (cleartext FHE) — reproducible, no spend
pnpm test:sepolia    # same flow against the live Sepolia deployment (real relayer)
pnpm test:throughput # funded Sepolia decrypt-throughput benchmark (spiking-throughput)
```

`pnpm test` / `pnpm test:sepolia` run the **same** principal-flow e2e (`tests/flow.e2e.ts`) — wrap → randomized confidential transfers → two same-block delegations → short-window revocation → `pending_rights` — end-to-end (onchain tx → log → DB → API). Local uses cleartext FHE (no KMS/relay); Sepolia exercises the real relayer. Both need Ponder + the decrypt worker running and Postgres up.

`pnpm test:throughput` drives the `spiking-throughput` benchmark (`tests/runner.ts`) — bulk transfers then a delegation spike, measuring decrypt handles/sec. Needs a funded Sepolia account.

## Architecture

```
Ponder (handlers)  ──→  Postgres (public schema: token_event, balances, delegation_event)
                                    ↕
Decrypt worker     ──→  Postgres (app schema: cleartext)
                                    ↕
Hono REST API      ←──  joins Ponder tables + app.cleartext
```

Handlers are zero-RPC (log-only). Per readable delegator, the decrypt worker decrypts the current balance handle at HEAD first (which doubles as a delegation-propagation gate — not propagated → skip the delegator), then batch-decrypts that delegator's transfer amounts via the Zama relay (`delegatedBatchDecryptValues`, per-entry error isolation). Counterparty-dedup ensures shared handles are never decrypted twice.

See `DECISIONS.md` for full rationale.
