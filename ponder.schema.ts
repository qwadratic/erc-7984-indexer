import { onchainTable, index } from "ponder";

export const tokenEvent = onchainTable("token_event", (t) => ({
  id:              t.text().primaryKey(),
  blockNumber:     t.bigint().notNull(),
  blockTime:       t.bigint().notNull(),
  txHash:          t.hex().notNull(),
  logIndex:        t.integer().notNull(),
  token:           t.hex().notNull(),
  kind:            t.text().notNull(),          // transfer | wrap | unwrap
  fromAddr:        t.hex().notNull(),
  toAddr:          t.hex().notNull(),
  amountHandle:    t.hex().notNull(),           // bytes32 FHE handle
  cleartextAmount: t.bigint(),                  // non-null for wrap/unwrap (public), null for transfers
}), (t) => ({
  fromIdx: index().on(t.token, t.fromAddr, t.blockNumber, t.logIndex),
  toIdx:   index().on(t.token, t.toAddr,   t.blockNumber, t.logIndex),
}));

// No dedicated `balances` table. A holder's last-activity block is DERIVED on
// demand as max(block_number) over that address's token_event rows (indexed on
// both from_addr and to_addr) — token_event is the single onchain source of
// truth. The worker-captured HEAD balance handle (not present in any event)
// lives in the side table app.balance_handle, off any Ponder-triggered table so
// worker writes can't pollute the reorg log. Staleness is DERIVED: a captured
// handle is current iff its handle_block >= that max activity block.
// See scripts/decrypt-worker.ts + src/cleartext-store.ts.

export const delegationEvent = onchainTable("delegation_event", (t) => ({
  id:          t.text().primaryKey(),
  delegator:   t.hex().notNull(),
  delegate:    t.hex().notNull(),
  token:       t.hex().notNull(),
  kind:        t.text().notNull(),              // grant | revoke
  expiration:  t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  logIndex:    t.integer().notNull(),
}), (t) => ({
  tupleIdx: index().on(t.delegator, t.delegate, t.token, t.blockNumber, t.logIndex),
}));
