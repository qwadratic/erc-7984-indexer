import { onchainTable, index, primaryKey } from "ponder";

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

// Indexer-owned ONLY. The decrypt worker never writes here.
// Captured balance handle + freshness live in app.balance_handle (side table,
// worker-owned) — keeping worker writes off any Ponder-triggered table so they
// can't pollute the reorg log (_reorg__ row trigger) or be clobbered on revert.
// Staleness is DERIVED: a captured handle is current iff its handle_block >=
// lastActivityBlock. See scripts/decrypt-worker.ts + src/cleartext-store.ts.
export const balances = onchainTable("balances", (t) => ({
  address:           t.hex().notNull(),
  token:             t.hex().notNull(),
  lastActivityBlock: t.bigint().notNull(),
}), (t) => ({
  pk: primaryKey({ columns: [t.address, t.token] }),
}));

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
