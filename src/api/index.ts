import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { replaceBigInts } from "ponder";
import { db } from "ponder:api";
import { tokenEvent, balances, delegationEvent } from "ponder:schema";
import { eq, or, and, desc, lt } from "ponder";
import { getCleartextBatch, getRecentDecryptCount } from "../cleartext-store";
import { isReadable, readableDelegators } from "../delegations";
import { TOKEN } from "../config";

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
    const bal = await db
      .select()
      .from(balances)
      .where(
        and(eq(balances.address, address), eq(balances.token, TOKEN)),
      )
      .limit(1);

    if (!bal[0]) {
      const hasEvents = await db
        .select()
        .from(tokenEvent)
        .where(
          or(eq(tokenEvent.toAddr, address), eq(tokenEvent.fromAddr, address)),
        )
        .limit(1);
      if (!hasEvents[0])
        return c.json({ address, handle: null, balance: null, status: "no_ciphertext" });
      const readable = await isReadable(db, address);
      return c.json({
        address,
        handle: null,
        balance: null,
        status: readable ? "pending" : "pending_rights",
      });
    }

    const handle = bal[0].balanceHandle;
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
// decryptedLast15m = handles the worker decrypted in the last 15 minutes (liveness signal)
app.get("/v1/health", async (c) => {
  const latest = await db
    .select()
    .from(tokenEvent)
    .orderBy(desc(tokenEvent.blockNumber))
    .limit(1);
  const delegators = await readableDelegators(db);

  let decryptedLast15m = 0;
  try {
    decryptedLast15m = await getRecentDecryptCount(15);
  } catch {
    // cleartext table may not exist yet
  }

  return c.json(
    replaceBigInts(
      {
        status: "ok",
        headBlock: latest[0]?.blockNumber ?? null,
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
