import type { Address } from "viem";

/**
 * Delegation readability rules — pure and dependency-free ON PURPOSE.
 *
 * Both readers of `delegation_event` share these rules but reach the rows through
 * different layers: the Ponder API via the drizzle query builder (`ponder:schema`),
 * the standalone decrypt worker via raw `pg`. This module imports neither, so the
 * worker — which runs outside Ponder and can't resolve `ponder:schema` — can import
 * it too. The ponder-side query wrappers live in `src/api/index.ts`; the worker's
 * SQL lives in `scripts/decrypt-worker.ts`. Keep the *rule* here, once.
 */

/** Max uint64 — the "forever" delegation expiry (never expires). */
export const MAX_UINT64 = 18446744073709551615n;

/**
 * Whether a delegator's LATEST delegation event grants active decryption rights:
 * a grant (not a revoke) that either never expires (`MAX_UINT64`) or expires more
 * than 60s out — a small margin so we don't act on an about-to-expire grant.
 */
export function isActiveGrant(
  kind: string,
  expiration: bigint,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): boolean {
  if (kind !== "grant") return false;
  if (expiration === MAX_UINT64) return true;
  return expiration > nowSec + 60n;
}

type DelegationRow = {
  delegator: string;
  kind: string;
  expiration: bigint | string | number;
};

/**
 * Reduce delegation-event rows — ordered newest-first (block desc, logIndex desc) —
 * to the delegator addresses whose latest event is an active grant. Rows already
 * deduped to one-per-delegator (e.g. SQL `DISTINCT ON`) work too: the grouping is
 * then a no-op.
 */
export function readableDelegatorsFromRows(
  rows: DelegationRow[],
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Address[] {
  const latest = new Map<string, DelegationRow>();
  for (const row of rows) {
    const d = row.delegator.toLowerCase();
    if (!latest.has(d)) latest.set(d, row);
  }
  const result: Address[] = [];
  for (const [addr, row] of latest) {
    if (isActiveGrant(row.kind, BigInt(row.expiration), nowSec)) {
      result.push(addr as Address);
    }
  }
  return result;
}
