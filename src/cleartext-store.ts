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

// Ensure schema + table exist on first import
const _init = pool.query(`
  CREATE SCHEMA IF NOT EXISTS app;
  CREATE TABLE IF NOT EXISTS app.cleartext (
    handle text PRIMARY KEY,
    value  numeric,
    status text NOT NULL,
    decrypted_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE app.cleartext ADD COLUMN IF NOT EXISTS decrypted_at timestamptz NOT NULL DEFAULT now();
`);

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


