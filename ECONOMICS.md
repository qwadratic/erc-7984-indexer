# ECONOMICS — activity, gas, token value, and the automatic decrypt win

This doc connects the **game economy** (players moving confidential value) to the three
costs that decide whether the indexer survives a spike:

1. **Gas** — what the chain charges to *generate* a decryptable handle (crypto-bytes).
2. **Token value** — the cleartext amounts the indexer decrypts and serves.
3. **Decrypt-seconds** — relayer time to turn handles into cleartext (the bottleneck).

The headline result: the indexer's load is governed by the **entropy** of activity, not
its volume. Indexing converts raw volume into distinct-ciphertext cost — and that
conversion is the *automatic win* the distinct-handle index gate buys
(see `DECISIONS.md → Break-even` and `scripts/decrypt-worker.ts`).

Numbers below are reproducible from `recordings/economy-sim.ts`
(`node --import tsx/esm recordings/economy-sim.ts`), fed only by the warm constants in
`recordings/decrypt-speed-report.md` and the gas receipts in `recordings/runbook.md`.
Warm-bounded (relayer cache not ruled out); concurrency ceiling is a hypothesis.

---

## 1. The economic simulation

Model the token as a game currency. `n` active players, a spike, an activity topology:

| topology | directed transfers `T` | shape |
|----------|------------------------|-------|
| fully-connected | `n(n-1)` | everyone settles with everyone — **the n² case** |
| star | `2(n-1)` | a hub (market/escrow) pays and collects |
| chain | `n-1` | a payment line |

Each transfer costs gas and emits handles. The decrypt worker has a fixed service rate
`S ≈ 114 handles/s` (batch-28 × conc-10, warm; ~8.8 ms/handle).

### Fully-connected spike, n = 100 (T = 9,900 transfers)

| token | K (handles/transfer) | raw handles | distinct | gas (ETH) | crypto-bytes | decrypt s (no index) | decrypt s (indexed) | win |
|-------|--:|--:|--:|--:|--:|--:|--:|--:|
| cWETH wrapper | 1 | 9,900 | 9,900 | **30.5** | 77 KB | 173 | **87** | 2× |
| basket K=64 | 64 | 633,600 | 9,901 | 38.3 | 4.9 MB | 11,088 | **87** | 128× |
| basket K=256 | 256 | 2,534,400 | 9,901 | 62.2 | 19.8 MB | 44,352 | **87** | 512× |

### Same n = 100, across topologies

| topology | transfers | wrapper gas (ETH) | wrapper decrypt s | basket K=64 gas (ETH) | basket no-index s | basket indexed s |
|----------|--:|--:|--:|--:|--:|--:|
| fully | 9,900 | 30.5 | 87 | 38.3 | 11,088 | 87 |
| star | 198 | 0.6 | 1.7 | 0.8 | 222 | 1.7 |
| chain | 99 | 0.3 | 0.9 | 0.4 | 111 | 0.9 |

---

## 2. Two regimes — and why the win matters in only one

**cWETH is gas-bound.** Every confidential transfer mints one *unique* handle for
~460k gas. n² play costs n² × gas: 100 players fully-connected ≈ **30 ETH**. The chain
itself throttles handle generation, so the ~87 s of distinct decrypt work can never be
outrun — the relayer is slower than ~114 h/s, but the chain can't feed it faster than gas
allows. Here the index is a clean, bounded **2×**: it removes the from/to counterparty
double-count (each transfer handle is decryptable by both parties, so a naive worker
decrypts it twice). The n² of distinct entropy is **irreducible** — it is real cleartext
that someone paid 460k gas each to create.

**A structural token is index-bound.** `ConfidentialBasketMock` emits K handles/transfer,
but K-1 of them are a shared structural template handle re-emitted as a `LOG4` (~1,875
gas) next to the one ~460k-gas live slot. Crypto-bytes/gas **decouples**: the chain emits
K× handles at ~1× gas. Without the index, decrypt-seconds explode (K=64 → ~11,000 s for
the same spend that buys cWETH ~87 s). With the index they collapse back to the entropy
floor (~87 s), because the K-1 structural handles are *one* distinct ciphertext —
decrypted once, indexed forever.

**So the automatic win is insurance that becomes load-bearing exactly when a token
decouples crypto-byte generation from gas.** For cWETH: a 2× nicety. For any
structural / templated / tiered confidential token: the difference between keeping up and
unbounded cleartext debt. The defense lives in the indexer because indexing — unlike the
relayer — is ours to scale.

---

## 3. Representing the win in the database

The win is already structural in the schema; this section makes it **explicit and
queryable** so it can be joined to gas and token value.

### 3.1 The shape that already exists (zero migration)

`app.cleartext` is a **content-addressed index**: one row per *distinct* ciphertext.

```
app.cleartext(handle PK, value numeric, status, decrypted_at)   -- DISTINCT work
```

Every on-chain handle is a **reference into** that index:

```
token_event.amount_handle    -- transfer/wrap/unwrap refs   (where n² generation lands)
app.balance_handle.handle    -- current-balance refs
```

Because the index is keyed by `handle` (= the ciphertext's content id), refs collapse onto
distinct rows automatically. The win is one ratio:

```sql
-- references ÷ distinct ciphertext = the dedup multiplier (the automatic win)
WITH refs AS (
  -- each transfer handle is decryptable by BOTH parties → counted twice,
  -- matching the from/to decrypt attempts the index folds away
  SELECT amount_handle AS handle FROM "<ponder_schema>".token_event
    WHERE kind = 'transfer' AND amount_handle <> repeat('0',64)::bytea  -- (zero handle)
  UNION ALL SELECT amount_handle FROM "<ponder_schema>".token_event
    WHERE kind = 'transfer' AND amount_handle <> repeat('0',64)::bytea
  UNION ALL SELECT handle FROM app.balance_handle
    WHERE handle IS NOT NULL
)
SELECT count(*)                AS ref_handles,        -- generation incidences (n² surface)
       count(DISTINCT handle)  AS distinct_handles,   -- real decrypt work
       count(*)::numeric / nullif(count(DISTINCT handle),0) AS dedup_multiplier;
```

This is shipped as `getHandleEconomics()` in `src/cleartext-store.ts` and exposed at
**`GET /v1/economics`**:

```json
{
  "naiveDecryptAttempts": 19800,    // from/to ×2 transfer refs + balance refs (no-index worker)
  "distinctHandles": 9900,          // real decrypt work
  "dedupMultiplier": 2.0,           // naiveDecryptAttempts ÷ distinctHandles = the win
  "cleartextBytes": 79200,
  "decryptSecondsSaved": 86.6,
  "gasGeneratedEthAt6_7Gwei": 30.5, // STALE price (runbook.md), not live gas
  "regime": "gas-bound (entropy)"
}
```

`dedupMultiplier ≤ 3` → `gas-bound (entropy)`; `> 3` → `index-bound (structural reuse)`.
The threshold is a heuristic: a pure entropy token floors at ~2 (counterparty de-double),
so anything materially above means shared ciphertext the index is collapsing.

`regime` flips to `index-bound (structural reuse)` once `dedupMultiplier > 3` — the live
signal that a token is generating crypto-bytes faster than gas would suggest, i.e. that the
index has gone from nicety to load-bearing.

### 3.2 First-class ledger (opt-in migration, if economics becomes primary)

If you want the win and its economics to be a first-class, indexable fact rather than a
derived query, enrich the index and add an explicit ref table:

```sql
ALTER TABLE app.cleartext
  ADD COLUMN bits             int,       -- 64 for euint64 → feeds the 2048-bit batch budget
  ADD COLUMN first_seen_block bigint;    -- ties each DISTINCT decrypt to the tx (→ gas) that birthed it

CREATE TABLE app.handle_ref (            -- where n² generation lands; points INTO the index
  handle    text NOT NULL,              -- FK → app.cleartext.handle
  ref_kind  text NOT NULL,              -- transfer | balance | basket_slot
  token     bytea NOT NULL,
  party     bytea NOT NULL,             -- address that can decrypt via this ref
  block     bigint NOT NULL,
  log_index int NOT NULL,
  PRIMARY KEY (handle, party, ref_kind, block, log_index)
);
CREATE INDEX ON app.handle_ref (handle);
```

Then the win and its full economic ledger are direct aggregates:

```sql
SELECT
  count(*)                             AS generated_refs,     -- crypto-bytes emitted (gas paid)
  count(DISTINCT handle)               AS decrypt_work,       -- relayer round-trips needed
  count(*)::numeric / count(DISTINCT handle)        AS win_multiplier,
  count(DISTINCT handle) * 8                          AS cleartext_bytes,
  (count(*) - count(DISTINCT handle)) * 0.00875       AS decrypt_seconds_saved,  -- ×per-handle s
  count(DISTINCT handle) * 460000 * 6.7e-9            AS gas_generated_eth        -- ×per-transfer gas
FROM app.handle_ref;
```

`bits` also lets the worker pack the 2048-bit decryption request exactly
(`HANDLES_PER_REQUEST` stops being a euint64-only guess), and `first_seen_block` makes the
**gas ⋈ decrypt** join exact: each distinct handle's birth tx → its `gasUsed` → ETH spent
to generate that byte of cleartext, set against the decrypt-seconds the index saved.

### 3.3 Connecting to token value

The cleartext the index holds *is* the economic data:

```sql
-- value moved vs cost to surface it, per token
SELECT te.token,
       sum(ct.value)                      AS confidential_value_moved,
       count(DISTINCT ct.handle)          AS handles_decrypted,
       count(DISTINCT ct.handle) * 460000 * 6.7e-9 AS gas_to_generate_eth
FROM "<ponder_schema>".token_event te
JOIN app.cleartext ct ON ct.handle = te.amount_handle AND ct.status = 'decrypted'
GROUP BY te.token;
```

That closes the loop the brief asked for: **on-chain activity → gas spent → crypto-bytes
generated → decrypt-seconds → cleartext token value served**, with the dedup multiplier as
the single number that says how much of the volume was structure (free to index) versus
entropy (paid for in gas, irreducible).

---

## 4. Design implication

A confidential token built for an economy should put as much of its per-transfer state
into **shared structure** (templates, tiers, constants, fixed attributes) as the use case
allows — not because it hides more, but because structural ciphertext is **free to index**,
while entropy-bearing ciphertext costs a relayer round-trip per distinct value. The indexer
makes that trade visible (`/v1/economics → dedupMultiplier`) so the token designer can see,
live, which side of the gas/entropy line their economy is generating.
