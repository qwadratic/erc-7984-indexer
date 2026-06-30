import { ponder } from "ponder:registry";
import { tokenEvent, balances, delegationEvent } from "ponder:schema";
import { zeroAddress } from "viem";
import { eq, and, desc } from "ponder";
import { TOKEN, INDEXER_ADDRESS } from "./config";

// ── Zero-RPC handlers ──
// All handlers index logs only — no confidentialBalanceOf, no context.client.readContract.
// Balance handles are captured at HEAD by the decrypt worker (scripts/decrypt-worker.ts).
// This makes backfill pure log fetching (fast, no archive RPC bottleneck).

/**
 * Record holder activity (indexer-owned). Advancing lastActivityBlock is the
 * staleness signal the decrypt worker reads: any captured balance handle with
 * handle_block < lastActivityBlock is stale and gets re-captured at HEAD.
 * No balance handle is written here — that lives in app.balance_handle.
 */
async function touchHolder(
  db: any,
  address: `0x${string}`,
  blockNumber: bigint,
) {
  await db
    .insert(balances)
    .values({
      address,
      token: TOKEN,
      lastActivityBlock: blockNumber,
    })
    .onConflictDoUpdate({
      lastActivityBlock: blockNumber,
    });
}

// Underlying ERC-20 Transfer — capture wrap amounts (public)
// Fires BEFORE ConfidentialTransfer (underlying pull → then mint).
ponder.on("Underlying:Transfer", async ({ event, context }) => {
  if (event.args.to.toLowerCase() !== TOKEN) return; // only wraps

  const wrapper = event.args.from.toLowerCase() as `0x${string}`;

  await context.db.insert(tokenEvent).values({
    id: event.id,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    token: TOKEN,
    kind: "wrap",
    fromAddr: zeroAddress,
    toAddr: wrapper,
    amountHandle:
      "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    cleartextAmount: event.args.value,
  });

  // Record activity (worker re-captures balance handle at HEAD)
  await touchHolder(context.db, wrapper, event.block.number);
});

// ConfidentialTransfer — covers transfer, wrap (from=0x0), unwrap (to=0x0)
ponder.on(
  "ERC7984ERC20Wrapper:ConfidentialTransfer",
  async ({ event, context }) => {
    const from = event.args.from.toLowerCase() as `0x${string}`;
    const to = event.args.to.toLowerCase() as `0x${string}`;
    const kind =
      from === zeroAddress ? "wrap" : to === zeroAddress ? "unwrap" : "transfer";

    if (kind === "wrap") {
      // Row already exists from Underlying:Transfer — update with real amountHandle
      const match = await context.db.sql
        .select()
        .from(tokenEvent)
        .where(
          and(
            eq(tokenEvent.txHash, event.transaction.hash),
            eq(tokenEvent.kind, "wrap"),
          ),
        )
        .limit(1);
      if (match[0]) {
        await context.db
          .update(tokenEvent, { id: match[0].id })
          .set({ amountHandle: event.args.amount });
      }
    } else {
      // Transfer or unwrap — insert fresh row
      await context.db.insert(tokenEvent).values({
        id: event.id,
        blockNumber: event.block.number,
        blockTime: event.block.timestamp,
        txHash: event.transaction.hash,
        logIndex: event.log.logIndex,
        token: TOKEN,
        kind,
        fromAddr: from,
        toAddr: to,
        amountHandle: event.args.amount,
        cleartextAmount: null,
      });
    }

    // Record holder activity (zero RPC — no balance read; worker captures handle)
    if (from !== zeroAddress) {
      await touchHolder(context.db, from, event.block.number);
    }
    if (to !== zeroAddress) {
      await touchHolder(context.db, to, event.block.number);
    }
  },
);

// UnwrapFinalized — public cleartext amount
ponder.on(
  "ERC7984ERC20Wrapper:UnwrapFinalized",
  async ({ event, context }) => {
    const match = await context.db.sql
      .select()
      .from(tokenEvent)
      .where(
        and(
          eq(tokenEvent.amountHandle, event.args.encryptedAmount),
          eq(tokenEvent.kind, "unwrap"),
        ),
      )
      .orderBy(desc(tokenEvent.blockNumber), desc(tokenEvent.logIndex))
      .limit(1);
    if (match[0]) {
      await context.db
        .update(tokenEvent, { id: match[0].id })
        .set({ cleartextAmount: BigInt(event.args.cleartextAmount) });
    }
  },
);

// ACL delegation — filter to delegate == INDEXER, token == TOKEN
ponder.on(
  "ACL:DelegatedForUserDecryption",
  async ({ event, context }) => {
    if (event.args.delegate.toLowerCase() !== INDEXER_ADDRESS) return;
    if (event.args.contractAddress.toLowerCase() !== TOKEN) return;

    await context.db.insert(delegationEvent).values({
      id: event.id,
      delegator: event.args.delegator.toLowerCase() as `0x${string}`,
      delegate: event.args.delegate.toLowerCase() as `0x${string}`,
      token: event.args.contractAddress.toLowerCase() as `0x${string}`,
      kind: "grant",
      expiration: BigInt(event.args.newExpirationDate),
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
    });
  },
);

ponder.on(
  "ACL:RevokedDelegationForUserDecryption",
  async ({ event, context }) => {
    if (event.args.delegate.toLowerCase() !== INDEXER_ADDRESS) return;
    if (event.args.contractAddress.toLowerCase() !== TOKEN) return;

    await context.db.insert(delegationEvent).values({
      id: event.id,
      delegator: event.args.delegator.toLowerCase() as `0x${string}`,
      delegate: event.args.delegate.toLowerCase() as `0x${string}`,
      token: event.args.contractAddress.toLowerCase() as `0x${string}`,
      kind: "revoke",
      expiration: 0n,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
    });
  },
);
