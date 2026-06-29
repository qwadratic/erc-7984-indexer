import { eq, and, desc } from "ponder";
import { delegationEvent } from "ponder:schema";
import { INDEXER_ADDRESS, TOKEN } from "./config";
import type { Address } from "viem";

type Db = {
  select(): any;
};

const MAX_UINT64 = 18446744073709551615n;

export async function isReadable(db: Db, address: Address): Promise<boolean> {
  const rows = await db
    .select()
    .from(delegationEvent)
    .where(
      and(
        eq(delegationEvent.delegator, address.toLowerCase() as `0x${string}`),
        eq(delegationEvent.delegate, INDEXER_ADDRESS),
        eq(delegationEvent.token, TOKEN),
      ),
    )
    .orderBy(desc(delegationEvent.blockNumber), desc(delegationEvent.logIndex))
    .limit(1);

  if (!rows[0]) return false;
  const row = rows[0];
  if (row.kind !== "grant") return false;
  const exp = BigInt(row.expiration);
  if (exp === MAX_UINT64) return true;
  // Valid if expiration > now + 60s
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  return exp > nowSec + 60n;
}

export async function readableDelegators(db: Db): Promise<Address[]> {
  // Get all distinct delegators with grants to our indexer for our token
  const rows = await db
    .select()
    .from(delegationEvent)
    .where(
      and(
        eq(delegationEvent.delegate, INDEXER_ADDRESS),
        eq(delegationEvent.token, TOKEN),
      ),
    )
    .orderBy(desc(delegationEvent.blockNumber), desc(delegationEvent.logIndex));

  // Group by delegator, take latest event per delegator
  const latest = new Map<string, (typeof rows)[0]>();
  for (const row of rows) {
    const d = row.delegator.toLowerCase();
    if (!latest.has(d)) latest.set(d, row);
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const result: Address[] = [];
  for (const [addr, row] of latest) {
    if (row.kind !== "grant") continue;
    const exp = BigInt(row.expiration);
    if (exp === MAX_UINT64 || exp > nowSec + 60n) {
      result.push(addr as Address);
    }
  }
  return result;
}
