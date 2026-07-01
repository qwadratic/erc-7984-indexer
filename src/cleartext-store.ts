/**
 * Cleartext store — backed by Postgres table `app.cleartext`.
 * Shared between Ponder API (reads) and decrypt-worker (writes).
 */
import pg from "pg";
import type { Hex } from "viem";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Ensure schema + tables exist on first import.
// Both app.* tables are WORKER-OWNED side tables, deliberately OUTSIDE Ponder's
// versioned schema: they carry expensive-to-recompute, externally-sourced data
// (decrypted cleartext via relayer; balance handles via HEAD RPC) and must NOT
// be written into Ponder's reorg-triggered tables. Living in `app` also means
// they survive a Ponder schema redeploy.
const _init = pool.query(`
  CREATE SCHEMA IF NOT EXISTS app;
  CREATE TABLE IF NOT EXISTS app.cleartext (
    handle text PRIMARY KEY,
    value  numeric,
    status text NOT NULL,
    decrypted_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE app.cleartext ADD COLUMN IF NOT EXISTS decrypted_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE app.cleartext ADD COLUMN IF NOT EXISTS claimed_by text;
  ALTER TABLE app.cleartext ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
  CREATE TABLE IF NOT EXISTS app.balance_handle (
    token        text NOT NULL,
    address      text NOT NULL,
    handle       text,
    handle_block numeric,
    captured_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (token, address)
  );
`);

// Captured balance handle for (token, address). handleBlock is the HEAD block at
// which the worker captured it; compare against balances.lastActivityBlock to
// know if it's stale. Returns null when the worker hasn't captured one yet.
export async function getBalanceHandle(
  token: Hex,
  address: Hex,
): Promise<{ handle: Hex | null; handleBlock: bigint | null } | null> {
  await _init;
  const { rows } = await pool.query(
    `SELECT handle, handle_block FROM app.balance_handle WHERE token = $1 AND address = $2`,
    [token.toLowerCase(), address.toLowerCase()],
  );
  if (rows.length === 0) return null;
  return {
    handle: (rows[0].handle as Hex) ?? null,
    handleBlock: rows[0].handle_block != null ? BigInt(rows[0].handle_block) : null,
  };
}

export async function getCleartextBatch(
  handles: Hex[],
): Promise<Map<Hex, { value: bigint | null; status: string }>> {
  const result = new Map<Hex, { value: bigint | null; status: string }>();
  if (handles.length === 0) return result;
  await _init;
  const lowerHandles = handles.map((h) => h.toLowerCase());
  const { rows } = await pool.query(
    `SELECT handle, value, status FROM app.cleartext WHERE handle = ANY($1)`,
    [lowerHandles],
  );
  for (const row of rows) {
    result.set(row.handle as Hex, {
      value: row.value != null ? BigInt(row.value) : null,
      status: row.status,
    });
  }
  return result;
}

// Liveness signal: how many handles the worker decrypted in the last `minutes` minutes.
export async function getRecentDecryptCount(minutes: number): Promise<number> {
  await _init;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS cnt FROM app.cleartext
     WHERE status = 'decrypted' AND decrypted_at > now() - ($1 || ' minutes')::interval`,
    [String(minutes)],
  );
  return rows[0]?.cnt ?? 0;
}

// True indexer sync head (zero-RPC): Ponder's latest synced block, read from its
// _ponder_checkpoint table. The 75-char checkpoint encodes blockTimestamp(10) +
// chainId(16) + blockNumber(16) + …, so the block number is substring(27, 16). This is the
// number to compare against chain HEAD — NOT the last-event block (which only advances when
// the token sees activity, and is what made /v1/health look "behind" when it was caught up).
export async function getIndexedHead(): Promise<bigint | null> {
  await _init;
  const schema = await ponderSchema();
  try {
    const { rows } = await pool.query(
      `SELECT max(substring(latest_checkpoint from 27 for 16)::numeric) AS block
       FROM "${schema}"."_ponder_checkpoint"`,
    );
    return rows[0]?.block != null ? BigInt(rows[0].block) : null;
  } catch {
    return null;
  }
}

// Split undecrypted transfer handles into two disjoint counts:
//   decryptQueueSize     — handles the worker WILL decrypt (at least one party is currently
//                          delegated to the indexer). This is the operator's real backlog
//                          signal; growth here = worker slipping vs. arrival.
//   nonDecryptableHandles— handles the indexer CANNOT decrypt (neither party has an active
//                          delegation). They sit in token_event forever unless a party
//                          delegates later. Counted for visibility; not a backlog signal.
// "Active delegation" = latest delegation_event per (delegator, delegate=INDEXER, token)
// is a `grant` whose expiration hasn't passed (matches src/delegations.ts:isReadable and
// the worker's getDelegators). Both counts derived in ONE query.
export async function getHandleCounts(
  indexer: Hex,
  token: Hex,
): Promise<{ decryptQueueSize: number; nonDecryptableHandles: number }> {
  await _init;
  const schema = await ponderSchema();
  const ZERO = "0x" + "0".repeat(64);
  const { rows } = await pool.query(
    `WITH readable AS (
       SELECT DISTINCT ON (delegator) delegator
       FROM "${schema}".delegation_event
       WHERE delegate = $2 AND token = $3
       ORDER BY delegator, block_number DESC, log_index DESC
     ), readable_grants AS (
       SELECT r.delegator FROM readable r
       JOIN LATERAL (
         SELECT kind, expiration FROM "${schema}".delegation_event de
         WHERE de.delegator = r.delegator AND de.delegate = $2 AND de.token = $3
         ORDER BY de.block_number DESC, de.log_index DESC LIMIT 1
       ) latest ON true
       WHERE latest.kind = 'grant' AND latest.expiration::numeric > extract(epoch from now())
     ), undecrypted AS (
       SELECT DISTINCT lower(te.amount_handle) AS h,
              bool_or(te.from_addr IN (SELECT delegator FROM readable_grants)
                   OR te.to_addr   IN (SELECT delegator FROM readable_grants)) AS readable
       FROM "${schema}".token_event te
       WHERE te.kind = 'transfer' AND te.amount_handle <> $1
         AND lower(te.amount_handle) NOT IN (SELECT handle FROM app.cleartext WHERE status = 'decrypted')
       GROUP BY lower(te.amount_handle)
     )
     SELECT
       count(*) FILTER (WHERE readable)     ::int AS q,
       count(*) FILTER (WHERE NOT readable) ::int AS n
     FROM undecrypted`,
    [ZERO, indexer.toLowerCase(), token.toLowerCase()],
  );
  return { decryptQueueSize: rows[0]?.q ?? 0, nonDecryptableHandles: rows[0]?.n ?? 0 };
}

// ── Handle-economics ledger (the "automatic win", made queryable) ──
// app.cleartext is a content-addressed index: one row per DISTINCT ciphertext. Every
// transfer/balance handle on-chain is a *reference* INTO it. The dedup multiplier
// (references ÷ distinct handles) is the win the distinct-handle index gate buys:
//   - ~2 for an entropy token (cWETH): from/to counterparty de-double, irreducible n² entropy
//   - ≫2 for a structural/templated token: shared ciphertext collapses to one decrypt
// See ECONOMICS.md. Read-only aggregate; opt-in endpoint, not on the hot path.
let _ECON_SCHEMA: string | null = null;
async function ponderSchema(): Promise<string> {
  if (_ECON_SCHEMA) return _ECON_SCHEMA;
  const { rows } = await pool.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'token_event' LIMIT 1`,
  );
  _ECON_SCHEMA = rows[0]?.table_schema ?? "public";
  return _ECON_SCHEMA ?? "public";
}

export interface HandleEconomics {
  naiveDecryptAttempts: number; // from/to double-counted transfer refs + balance refs = what a no-index worker would attempt
  distinctHandles: number; // rows in the index = real decrypt work
  decryptedHandles: number; // distinct handles actually decrypted so far
  dedupMultiplier: number; // naiveDecryptAttempts / distinctHandles = the automatic win
}

export async function getHandleEconomics(): Promise<HandleEconomics> {
  await _init;
  const schema = await ponderSchema();
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  // refs = every handle the chain emitted (each transfer amount is queryable by 2 parties
  // → counted twice, matching the from/to decrypt attempts the index collapses).
  const { rows } = await pool.query(
    `WITH refs AS (
       SELECT amount_handle AS handle FROM "${schema}".token_event
         WHERE kind = 'transfer' AND amount_handle <> $1
       UNION ALL
       SELECT amount_handle FROM "${schema}".token_event
         WHERE kind = 'transfer' AND amount_handle <> $1
       UNION ALL
       SELECT handle FROM app.balance_handle WHERE handle IS NOT NULL
     )
     SELECT
       (SELECT count(*) FROM refs)::int                         AS ref_handles,
       (SELECT count(DISTINCT handle) FROM refs)::int            AS distinct_handles,
       (SELECT count(*) FROM app.cleartext WHERE status='decrypted')::int AS decrypted_handles`,
    [ZERO],
  );
  const r = rows[0] ?? {};
  const naiveDecryptAttempts = r.ref_handles ?? 0;
  const distinctHandles = r.distinct_handles ?? 0;
  return {
    naiveDecryptAttempts,
    distinctHandles,
    decryptedHandles: r.decrypted_handles ?? 0,
    dedupMultiplier: distinctHandles > 0 ? naiveDecryptAttempts / distinctHandles : 0,
  };
}


