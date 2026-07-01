import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { replaceBigInts } from "ponder";
import { db } from "ponder:api";
import { tokenEvent, delegationEvent } from "ponder:schema";
import { eq, or, and, desc, lt } from "ponder";
import { getCleartextBatch, getRecentDecryptCount, getBalanceHandle, getIndexedHead, getHandleCounts } from "../cleartext-store";
import { isActiveGrant, readableDelegatorsFromRows } from "../delegations";
import { TOKEN, INDEXER_ADDRESS } from "../config";

// Ponder-db wrappers over delegation_event. The readability *rule* lives in
// src/delegations.ts (pure, shared with the decrypt worker); these just fetch the
// rows via the drizzle query builder and hand them to that rule.
async function isReadable(
  database: typeof db,
  address: `0x${string}`,
): Promise<boolean> {
  const rows = await database
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
  const row = rows[0];
  return row ? isActiveGrant(row.kind, BigInt(row.expiration)) : false;
}

async function readableDelegators(
  database: typeof db,
): Promise<`0x${string}`[]> {
  const rows = await database
    .select()
    .from(delegationEvent)
    .where(
      and(
        eq(delegationEvent.delegate, INDEXER_ADDRESS),
        eq(delegationEvent.token, TOKEN),
      ),
    )
    .orderBy(desc(delegationEvent.blockNumber), desc(delegationEvent.logIndex));
  return readableDelegatorsFromRows(rows);
}

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((v) => v.toLowerCase() as `0x${string}`);
const addressParam = z.object({ address: hexAddress });
const transfersQuery = z.object({
  cursor: z.string().regex(/^\d+:\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Decrypt jobs run in a separate process (scripts/decrypt-worker.ts)
// to avoid Vite SSR incompatibility with @zama-fhe/sdk's node() transport.

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException)
    return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal server error" }, 500);
});
app.notFound((c) =>
  c.json({ error: `${c.req.method} ${c.req.path} not found` }, 404),
);

// GET /v1/accounts/:address/balance
// ERC-20-like read: delegated users get decrypted values; non-delegated get same
// rows with values null (hidden). No live fetch/decrypt in the API.
app.get(
  "/v1/accounts/:address/balance",
  zValidator("param", addressParam),
  async (c) => {
    const { address } = c.req.valid("param");

    // Holder existence is derived from token_event (no `balances` table): an
    // address with no from/to row has never held the ciphertext.
    const hasEvents = await db
      .select()
      .from(tokenEvent)
      .where(
        or(eq(tokenEvent.toAddr, address), eq(tokenEvent.fromAddr, address)),
      )
      .limit(1);
    if (!hasEvents[0])
      return c.json({ address, handle: null, balance: null, status: "no_ciphertext" });

    // Balance handle is worker-owned, in app.balance_handle (not Ponder's table).
    const bh = await getBalanceHandle(TOKEN, address);
    const handle = bh?.handle ?? null;
    if (!handle) {
      const readable = await isReadable(db, address);
      return c.json({
        address,
        handle: null,
        balance: null,
        status: readable ? "pending" : "pending_rights",
      });
    }

    const ct = await getCleartextBatch([handle]);
    const entry = ct.get(handle.toLowerCase() as `0x${string}`);
    const readable = await isReadable(db, address);
    return c.json(
      replaceBigInts(
        {
          address,
          handle,
          balance: entry?.value ?? null,
          status:
            entry?.status === "decrypted"
              ? "decrypted"
              : readable
                ? "pending"
                : "pending_rights",
        },
        String,
      ),
    );
  },
);

// GET /v1/accounts/:address/transfers
app.get(
  "/v1/accounts/:address/transfers",
  zValidator("param", addressParam),
  zValidator("query", transfersQuery),
  async (c) => {
    const { address } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");

    const cursorFilter = cursor
      ? (() => {
          const parts = cursor.split(":").map(Number);
          const b = parts[0]!;
          const l = parts[1]!;
          return or(
            lt(tokenEvent.blockNumber, BigInt(b)),
            and(
              eq(tokenEvent.blockNumber, BigInt(b)),
              lt(tokenEvent.logIndex, l),
            ),
          );
        })()
      : undefined;

    const events = await db
      .select()
      .from(tokenEvent)
      .where(
        and(
          or(
            eq(tokenEvent.fromAddr, address),
            eq(tokenEvent.toAddr, address),
          ),
          cursorFilter,
        ),
      )
      .orderBy(desc(tokenEvent.blockNumber), desc(tokenEvent.logIndex))
      .limit(limit + 1);

    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;

    const handles = page
      .filter((e: any) => e.cleartextAmount == null)
      .map((e: any) => e.amountHandle as `0x${string}`);
    const ct =
      handles.length > 0 ? await getCleartextBatch(handles) : new Map();
    const readable = await isReadable(db, address);

    const items = page.map((e: any) => {
      const counterparty =
        e.fromAddr === address ? e.toAddr : e.fromAddr;
      if (e.cleartextAmount != null) {
        return {
          txHash: e.txHash,
          block: e.blockNumber,
          timestamp: e.blockTime,
          direction: e.fromAddr === address ? "out" : "in",
          counterparty,
          kind: e.kind,
          amountHandle: e.amountHandle,
          amount: e.cleartextAmount,
          status: "decrypted",
        };
      }
      const entry = ct.get(e.amountHandle.toLowerCase() as `0x${string}`);
      return {
        txHash: e.txHash,
        block: e.blockNumber,
        timestamp: e.blockTime,
        direction: e.fromAddr === address ? "out" : "in",
        counterparty,
        kind: e.kind,
        amountHandle: e.amountHandle,
        amount: entry?.value ?? null,
        status:
          entry?.status === "decrypted"
            ? "decrypted"
            : readable
              ? "pending"
              : "pending_rights",
      };
    });

    const nextCursor = hasMore
      ? `${page[page.length - 1]!.blockNumber}:${page[page.length - 1]!.logIndex}`
      : null;
    return c.json(replaceBigInts({ items, nextCursor }, String));
  },
);

// GET /v1/health
// indexedBlock          = Ponder's true sync head (compare to chain HEAD to judge "caught up").
// lastEventBlock        = last block that produced a token event — only moves on token activity,
//                         so it can sit well behind HEAD while fully synced (NOT sync lag).
// decryptQueueSize      = distinct undecrypted transfer handles whose from/to is currently
//                         delegated to the indexer — the worker's REAL backlog. Growth =
//                         worker slipping vs arrival (the failure-mode signal).
// nonDecryptableHandles = distinct undecrypted transfer handles where NEITHER party has an
//                         active delegation — the indexer can't decrypt them (sit forever
//                         unless a party delegates later). Visibility only, not a backlog signal.
// decryptedLast15m      = handles decrypted in the last 15 min (worker liveness).
app.get("/v1/health", async (c) => {
  const latest = await db
    .select()
    .from(tokenEvent)
    .orderBy(desc(tokenEvent.blockNumber))
    .limit(1);
  const delegators = await readableDelegators(db);

  let decryptedLast15m = 0;
  let indexedBlock: bigint | null = null;
  let decryptQueueSize = 0;
  let nonDecryptableHandles = 0;
  try { decryptedLast15m = await getRecentDecryptCount(15); } catch {}
  try { indexedBlock = await getIndexedHead(); } catch {}
  try {
    const counts = await getHandleCounts(INDEXER_ADDRESS, TOKEN);
    decryptQueueSize = counts.decryptQueueSize;
    nonDecryptableHandles = counts.nonDecryptableHandles;
  } catch {}

  return c.json(
    replaceBigInts(
      {
        status: "ok",
        indexedBlock,                                   // true sync head (≈ chain HEAD when caught up)
        lastEventBlock: latest[0]?.blockNumber ?? null, // last block with a token event (not sync lag)
        decryptQueueSize,                               // worker's real backlog (readable-only)
        nonDecryptableHandles,                          // undecryptable (no active delegation on either side)
        decryptedLast15m,
        readableUsers: delegators.length,
      },
      String,
    ),
  );
});

// GET /v1/delegations
app.get("/v1/delegations", async (c) => {
  const rows = await db
    .select()
    .from(delegationEvent)
    .orderBy(desc(delegationEvent.blockNumber))
    .limit(50);
  return c.json(replaceBigInts({ items: rows }, String));
});

export default app;
