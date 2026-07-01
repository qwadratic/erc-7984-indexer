/**
 * Standalone decrypt worker — runs OUTSIDE Ponder's Vite SSR context.
 * Reads Ponder tables + writes app.cleartext in the SAME Postgres.
 *
 * Originally this separation was ALSO forced by a technical blocker: the SDK's node()
 * transport used import.meta.resolve to locate its WASM worker, which Ponder's Vite SSR
 * rewrote to __vite_ssr_import_meta__.resolve (undefined at runtime). As of
 * @zama-fhe/sdk 3.3.0-alpha.2 (SDK-235 / PR #490) that blocker is GONE — the node worker
 * now resolves via createRequire(import.meta.url).resolve(). So the separate process is now
 * a PRODUCT choice (offchain decrypt scheduling, independent crash domain, polling loop),
 * not a technical workaround.
 *
 * Per readable delegator each tick:
 *   (1) refresh + decrypt the current balance handle at HEAD — also the propagation gate
 *       (DelegationNotPropagatedError → skip the delegator this tick)
 *   (2) batch-decrypt that delegator's undecrypted transfer amounts (newest-first)
 *       via delegatedBatchDecryptValues (per-entry error isolation)
 *
 * Counterparty-dedup: before decrypting any handle, skip if already in app.cleartext.
 * A shared transfer-amount handle decrypted via one party is reused for the counterparty.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hostname } from "node:os";

// ── Parallel-friendly: NO single-instance lock. ──
// Multiple workers may run concurrently and split the backlog via per-handle DB row-claims
// in app.cleartext (claimHandles below) — each distinct handle is decrypted by exactly one
// worker. Scale out by launching N processes (set DECRYPT_WORKER_ID=<n> for log clarity).
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("uncaughtException", (err) => {
  console.error("[decrypt-worker] uncaughtException:", err);
  process.exit(1);
});

// Load .env.local manually (ponder auto-loads it, but we're standalone)
const envPath = resolve(import.meta.dirname ?? ".", "..", ".env.local");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

import pg from "pg";
import {
  ZamaSDK,
  MemoryStorage,
  DelegationNotPropagatedError,
} from "@zama-fhe/sdk";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node, cleartext } from "@zama-fhe/sdk/node";
import { sepolia as zamaSepolia, hardhat as zamaHardhat } from "@zama-fhe/sdk/chains";
import type { FheChain } from "@zama-fhe/sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, hardhat } from "viem/chains";

// ── Env switch ──
const IS_LOCAL = (process.env.CHAIN ?? "sepolia").toLowerCase() === "local";

// ── Config ──
const TOKEN = (process.env.TOKEN_ADDRESS ?? "").toLowerCase() as Address;
const INDEXER_PK = process.env.INDEXER_PRIVATE_KEY as `0x${string}`;
const RPC_URL = IS_LOCAL
  ? (process.env.PONDER_RPC_URL_31337 ?? "http://127.0.0.1:8545")
  : process.env.PONDER_RPC_URL_11155111!;
const DATABASE_URL = process.env.DATABASE_URL!;
// Gateway caps a decryption request at MAX_DECRYPTION_REQUEST_BITS = 2048 TOTAL encrypted
// bits (proven: gateway-contracts/contracts/Decryption.sol:151 in zama-ai/fhevm; mirrored
// client-side by @zama-fhe/relayer-sdk check2048EncryptedBits). It's a BIT budget, not a
// handle count: euint64 = 64 bits → 2048/64 = 32 max; we use 28 (conservative, euint64-only).
const HANDLES_PER_REQUEST = 28;

// ── Postgres ──
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

// Worker-owned side tables (app.*). The worker writes ONLY here — never into a
// Ponder-managed table. Ponder installs an AFTER INSERT/UPDATE/DELETE row trigger
// on its tables that snapshots into _reorg__<table>; an out-of-band UPDATE there
// would inject phantom rows into Ponder's reorg log and get clobbered on revert.
// Keeping handles in app.* avoids that entirely and survives schema redeploys.
await pool.query(`
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

async function upsertCleartext(handle: string, value: bigint) {
  await pool.query(
    `INSERT INTO app.cleartext (handle, value, status, decrypted_at) VALUES ($1, $2, 'decrypted', now())
     ON CONFLICT (handle) DO UPDATE SET value = EXCLUDED.value, status = 'decrypted', decrypted_at = now(),
       claimed_by = NULL, claimed_at = NULL`,
    [handle.toLowerCase(), value.toString()],
  );
}

// ── Discover Ponder's schema ──
let PONDER_SCHEMA = "public";
{
  const { rows } = await pool.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'token_event' LIMIT 1`,
  );
  if (rows.length > 0) PONDER_SCHEMA = rows[0].table_schema;
  console.log(`[decrypt-worker] Ponder schema: ${PONDER_SCHEMA}`);
}

// ── SDK ──
const viemChain: Chain = IS_LOCAL ? hardhat : sepolia;
const account = privateKeyToAccount(INDEXER_PK);
const publicClient = createPublicClient({
  chain: viemChain,
  transport: http(RPC_URL),
});
const walletClient = createWalletClient({
  account,
  chain: viemChain,
  transport: http(RPC_URL),
});

const fheChain: FheChain = IS_LOCAL
  ? { ...zamaHardhat, network: RPC_URL } as const satisfies FheChain
  : { ...zamaSepolia, network: RPC_URL } as const satisfies FheChain;
const sdk = new ZamaSDK(
  createConfig({
    chains: [fheChain],
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    storage: new MemoryStorage(),
    relayers: { [fheChain.id]: IS_LOCAL ? cleartext() : node() },
  }),
);

console.log(`[decrypt-worker] SDK built (${IS_LOCAL ? 'local/cleartext' : 'sepolia/node'}), signer=${account.address}`);

// ── ABI for confidentialBalanceOf ──
const BALANCE_ABI = [
  {
    name: "confidentialBalanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" as const }],
    outputs: [{ name: "", type: "bytes32" as const }],
  },
] as const;

// ── SQL helpers ──
const INDEXER_ADDRESS = account.address.toLowerCase();
const MAX_UINT64 = "18446744073709551615";

async function getDelegators(): Promise<Address[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (delegator) delegator, kind, expiration
     FROM "${PONDER_SCHEMA}".delegation_event
     WHERE delegate = $1 AND token = $2
     ORDER BY delegator, block_number DESC, log_index DESC`,
    [INDEXER_ADDRESS, TOKEN],
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  const result: Address[] = [];
  for (const row of rows) {
    if (row.kind !== "grant") continue;
    const exp = BigInt(row.expiration);
    if (exp.toString() === MAX_UINT64 || exp > now + 60n) {
      result.push(row.delegator as Address);
    }
  }
  return result;
}

/**
 * Balance state = indexer activity (READ-ONLY from Ponder's balances) joined with
 * the worker's own captured handle (app.balance_handle). A pure SELECT on Ponder's
 * table does NOT fire its reorg trigger, so reading is safe; we just never write it.
 * Staleness is derived: recapture iff no handle yet OR handle_block < lastActivityBlock.
 */
async function getBalanceState(
  addr: Address,
): Promise<{ handle: Hex | null; handleBlock: bigint | null; lastActivityBlock: bigint | null }> {
  const { rows: act } = await pool.query(
    `SELECT last_activity_block FROM "${PONDER_SCHEMA}".balances
     WHERE address = $1 AND token = $2`,
    [addr.toLowerCase(), TOKEN],
  );
  const lastActivityBlock =
    act[0]?.last_activity_block != null ? BigInt(act[0].last_activity_block) : null;
  const { rows: h } = await pool.query(
    `SELECT handle, handle_block FROM app.balance_handle WHERE token = $1 AND address = $2`,
    [TOKEN, addr.toLowerCase()],
  );
  return {
    handle: (h[0]?.handle as Hex) ?? null,
    handleBlock: h[0]?.handle_block != null ? BigInt(h[0].handle_block) : null,
    lastActivityBlock,
  };
}

async function upsertBalanceHandle(
  address: Address,
  handle: Hex,
  block: bigint,
) {
  await pool.query(
    `INSERT INTO app.balance_handle (token, address, handle, handle_block, captured_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (token, address)
     DO UPDATE SET handle = EXCLUDED.handle, handle_block = EXCLUDED.handle_block, captured_at = now()`,
    [TOKEN, address.toLowerCase(), handle, block.toString()],
  );
}

async function getTransferHandles(
  delegator: Address,
  limit?: number,
): Promise<Hex[]> {
  const addr = delegator.toLowerCase();
  const orderAndLimit = limit
    ? `ORDER BY block_number DESC, log_index DESC LIMIT ${limit}`
    : `ORDER BY block_number DESC, log_index DESC`;
  const { rows } = await pool.query(
    `SELECT amount_handle FROM "${PONDER_SCHEMA}".token_event
     WHERE (from_addr = $1 OR to_addr = $1)
       AND kind = 'transfer'
       AND cleartext_amount IS NULL
       AND amount_handle != '0x0000000000000000000000000000000000000000000000000000000000000000'
     ${orderAndLimit}`,
    [addr],
  );
  return rows.map((r: any) => r.amount_handle as Hex);
}

// ── Parallel work-split via DB row-claims ──
// WORKER_ID identifies this process; CLAIM_TTL bounds how long a claim is honored before
// another worker may steal it (covers a crashed worker that died mid-decrypt).
const WORKER_ID = process.env.DECRYPT_WORKER_ID ?? `${hostname()}:${process.pid}`;
const CLAIM_TTL_SEC = Number(process.env.DECRYPT_CLAIM_TTL_SEC ?? 120);

/**
 * Atomically claim handles for THIS worker; returns the subset actually won. Claimable =
 * brand-new, released ('pending'), or a stale claim (older than CLAIM_TTL). Never re-claims
 * a 'decrypted' row or one freshly claimed by another worker. This single statement is how
 * parallel workers split the backlog with no single-instance lock and no double-decrypt:
 * Postgres serializes the conflicting upserts, the status + TTL guard does the rest. It
 * also subsumes counterparty-dedup — a shared handle is won (and decrypted) exactly once.
 */
async function claimHandles(handles: Hex[]): Promise<Hex[]> {
  if (handles.length === 0) return [];
  const lower = [...new Set(handles.map((h) => h.toLowerCase()))];
  const { rows } = await pool.query(
    `INSERT INTO app.cleartext (handle, status, claimed_by, claimed_at)
     SELECT unnest($1::text[]), 'claimed', $2, now()
     ON CONFLICT (handle) DO UPDATE
       SET status = 'claimed', claimed_by = $2, claimed_at = now()
       WHERE app.cleartext.status <> 'decrypted'
         AND (app.cleartext.claimed_at IS NULL
              OR app.cleartext.claimed_at < now() - ($3 || ' seconds')::interval)
     RETURNING handle`,
    [lower, WORKER_ID, String(CLAIM_TTL_SEC)],
  );
  const won = new Set(rows.map((r: any) => r.handle as string));
  return handles.filter((h) => won.has(h.toLowerCase()));
}

/** Release our own unfulfilled claims (decrypt failed / not propagated) so they retry. */
async function releaseHandles(handles: Hex[]): Promise<void> {
  if (handles.length === 0) return;
  await pool.query(
    `UPDATE app.cleartext SET status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE handle = ANY($1) AND status = 'claimed' AND claimed_by = $2`,
    [handles.map((h) => h.toLowerCase()), WORKER_ID],
  );
}

// ── Decrypt ──
function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size)
    result.push(arr.slice(i, i + size));
  return result;
}

async function tryDecrypt(
  delegator: Address,
  handles: Hex[],
): Promise<Array<{ handle: Hex; value: bigint }> | "not_propagated"> {
  try {
    const inputs = handles.map((h) => ({
      encryptedValue: h as `0x${string}`,
      contractAddress: TOKEN as `0x${string}`,
    }));
    const clearValues = await sdk.decryption.delegatedDecryptValues(
      inputs,
      delegator,
    );
    const results: Array<{ handle: Hex; value: bigint }> = [];
    for (const h of handles) {
      const v = clearValues[h as `0x${string}`];
      if (v != null) {
        results.push({ handle: h, value: BigInt(v) });
      }
    }
    return results;
  } catch (err: any) {
    if (
      err instanceof DelegationNotPropagatedError ||
      err?.code === "DELEGATION_NOT_PROPAGATED"
    ) {
      console.log(
        `[decrypt-worker] delegation not propagated for ${delegator}, skipping`,
      );
      return "not_propagated";
    }
    console.error(
      `[decrypt-worker] delegator=${delegator}`,
      err?.message ?? err,
    );
    return [];
  }
}

// ── Main loop ──
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const RELAY_CONCURRENCY = Number(process.env.DECRYPT_RELAY_CONCURRENCY ?? 10);
const ZERO_HANDLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Per-tick parallelism. Measured live on Sepolia (recordings/load-test-report.md):
//   DELEGATOR_CONCURRENCY=5 CC=1 → 6.97 h/s sustained on a 490-handle backlog (best).
//   CHUNK_CONCURRENCY>1 → SDK per-item fallback path triggers under sustained load,
//     produces item-failures and is 2.4× slower than serial chunks (worst config).
// Winning shape: parallelize ACROSS delegators (their balance gates overlap), keep chunks
// WITHIN a delegator serial so no single delegator saturates the relayer alone.
// The 17.4 h/s from stress.ts phase B was a burst peak on 64 cached handles — not a
// sustainable steady-state ceiling. The DB row-claim stays the authority on who decrypts
// each handle, so this concurrency never double-decrypts — it only overlaps the waiting.
const DELEGATOR_CONCURRENCY = Number(process.env.DECRYPT_DELEGATOR_CONCURRENCY ?? 5);
const CHUNK_CONCURRENCY = Number(process.env.DECRYPT_CHUNK_CONCURRENCY ?? 1);

function pLimit(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => { active--; queue.shift()?.(); };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => { active++; fn().then(resolve, reject).finally(next); };
      active < n ? run() : queue.push(run);
    });
}

// Batch-decrypt transfer amounts with per-entry error isolation: one bad/unpropagated
// handle doesn't sink the whole chunk. The SDK bounds its own fallback parallelism via
// maxConcurrency (= DECRYPT_RELAY_CONCURRENCY), so we don't manage concurrency here.
async function tryBatchDecrypt(
  delegator: Address,
  handles: Hex[],
): Promise<Array<{ handle: Hex; value: bigint }>> {
  try {
    const inputs = handles.map((h) => ({
      encryptedValue: h as `0x${string}`,
      contractAddress: TOKEN as `0x${string}`,
    }));
    const batch = await sdk.decryption.delegatedBatchDecryptValues({
      encryptedInputs: inputs,
      delegatorAddress: delegator,
      maxConcurrency: RELAY_CONCURRENCY,
    });
    const results: Array<{ handle: Hex; value: bigint }> = [];
    for (const item of batch.items) {
      if (item.error) {
        console.warn(
          `[decrypt-worker] batch item failed delegator=${delegator} handle=${item.encryptedValue}: ${item.error?.message ?? item.error}`,
        );
        continue;
      }
      if (item.value != null) {
        results.push({
          handle: item.encryptedValue as Hex,
          value: BigInt(item.value),
        });
      }
    }
    return results;
  } catch (err: any) {
    console.error(
      `[decrypt-worker] batch decrypt error delegator=${delegator}`,
      err?.message ?? err,
    );
    return [];
  }
}

async function runLoop() {
  console.log(`[decrypt-worker] Starting main loop (worker=${WORKER_ID}, claim-split, balance gate → batch transfers)...`);
  while (true) {
    try {
      // Check if Ponder tables exist yet
      const { rows: tableCheck } = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'token_event' LIMIT 1`,
        [PONDER_SCHEMA],
      );
      if (tableCheck.length === 0) {
        // Re-discover schema
        const { rows: schemaRows } = await pool.query(
          `SELECT table_schema FROM information_schema.tables WHERE table_name = 'token_event' LIMIT 1`,
        );
        if (schemaRows.length > 0) {
          PONDER_SCHEMA = schemaRows[0].table_schema;
          console.log(
            `[decrypt-worker] Ponder schema discovered: ${PONDER_SCHEMA}`,
          );
        } else {
          await sleep(5_000);
          continue;
        }
      }

      const delegators = await getDelegators();
      if (delegators.length === 0) {
        await sleep(5_000);
        continue;
      }
      // Shuffle so N parallel workers don't lockstep on the same delegator order — spreads
      // claim contention and keeps each worker drawing from a different part of the frontier.
      for (let i = delegators.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [delegators[i], delegators[j]] = [delegators[j]!, delegators[i]!];
      }

      let totalDecrypted = 0;

      // ── Distinct-handle index gate (the structural lever) ──
      // A handle is a content identifier: identical ciphertext ⇒ identical bytes32.
      // So decrypt work should scale with DISTINCT unseen ciphertext, not with handle
      // count. A big-structure token (ConfidentialBasketMock) emits K handles/transfer
      // but reuses a structural template handle for K-1 of them; without this gate the
      // worker pays K relayer round-trips/transfer and the boundary collapses as ~1/K.
      // This tick-scoped index folds the inflation away: each distinct handle is
      // decrypted at most once per tick (and never if already in app.cleartext), across
      // ALL delegators — so the break-even on-chain rate stops depending on K.
      const seenThisTick = new Set<string>();

      // Per delegator (bounded-concurrency parallel — overlaps the relayer round-trips):
      // (1) refresh + decrypt the current balance as a propagation gate,
      // (2) if propagated, batch-decrypt that delegator's undecrypted transfer amounts.
      const delegatorLimit = pLimit(DELEGATOR_CONCURRENCY);
      const perDelegatorCounts = await Promise.all(
        delegators.map((delegator) =>
          delegatorLimit(async () => {
            let count = 0;
            try {
              // ── (1) Current balance handle (refresh at HEAD on new activity) ──
              // Derived staleness: recapture when the worker has no handle yet, or the
              // captured handle predates the latest indexed activity for this holder.
              const bs = await getBalanceState(delegator);
              let handle: Hex | null = bs.handle;
              const needsRecapture =
                !handle ||
                bs.handleBlock == null ||
                (bs.lastActivityBlock != null && bs.handleBlock < bs.lastActivityBlock);
              if (needsRecapture) {
                const head = (await publicClient.readContract({
                  address: TOKEN,
                  abi: BALANCE_ABI,
                  functionName: "confidentialBalanceOf",
                  args: [delegator as `0x${string}`],
                })) as Hex;
                const blockNum = await publicClient.getBlockNumber();
                await upsertBalanceHandle(delegator, head, blockNum);
                handle = head;
              }

              // ── (2) Propagation gate: claim the balance handle, decrypt it. A successful
              //         decrypt confirms propagation; not-propagated → release + skip delegator.
              //         If another worker already owns/decrypted it, proceed optimistically (a
              //         per-item not_propagated on the transfers will gate us anyway).
              let propagated = true;
              if (handle && handle !== ZERO_HANDLE) {
                seenThisTick.add(handle.toLowerCase());
                const claimedBal = await claimHandles([handle]);
                if (claimedBal.length > 0) {
                  const res = await tryDecrypt(delegator, [handle]);
                  if (res === "not_propagated") {
                    propagated = false;
                    await releaseHandles([handle]);
                  } else {
                    for (const r of res) {
                      await upsertCleartext(r.handle, r.value);
                      count++;
                    }
                  }
                }
              }
              if (!propagated) return count;

              // ── (3) Transfer amounts: claim + decrypt, CHUNKS IN PARALLEL ──
              // Claiming per HANDLES_PER_REQUEST chunk (not the whole delegator at once) is what
              // lets N parallel workers split ONE delegator's large backlog — each grabs
              // different chunks. Running the chunks concurrently overlaps the round-trips for a
              // single hot delegator too. The claim is the cross-worker authority (each handle
              // won once, no double-decrypt); seenThisTick is an in-process pre-filter; handles
              // claimed but not decrypted are released so another worker / next tick retries them.
              const transfers = await getTransferHandles(delegator);
              if (transfers.length === 0) return count;
              let announced = false;
              const chunkLimit = pLimit(CHUNK_CONCURRENCY);
              const chunkCounts = await Promise.all(
                chunks(transfers, HANDLES_PER_REQUEST).map((chunk) =>
                  chunkLimit(async () => {
                    const fresh: Hex[] = [];
                    for (const h of chunk) {
                      const k = h.toLowerCase();
                      if (seenThisTick.has(k)) continue;
                      seenThisTick.add(k);
                      fresh.push(h);
                    }
                    const claimed = await claimHandles(fresh);
                    if (claimed.length === 0) return 0;
                    if (!announced) {
                      console.log(`[decrypt-worker] ${delegator}: draining claimed transfer handles…`);
                      announced = true;
                    }
                    const res = await tryBatchDecrypt(delegator, claimed);
                    const ok = new Set(res.map((r) => r.handle.toLowerCase()));
                    for (const r of res) await upsertCleartext(r.handle, r.value);
                    await releaseHandles(claimed.filter((h) => !ok.has(h.toLowerCase())));
                    return res.length;
                  }),
                ),
              );
              return count + chunkCounts.reduce((a, b) => a + b, 0);
            } catch (err: any) {
              console.error(
                `[decrypt-worker] delegator=${delegator} loop error:`,
                err?.message ?? err,
              );
              return count;
            }
          }),
        ),
      );
      totalDecrypted += perDelegatorCounts.reduce((a, b) => a + b, 0);

      if (totalDecrypted > 0) {
        console.log(
          `[decrypt-worker] Decrypted ${totalDecrypted} handles this tick`,
        );
      }
    } catch (err) {
      console.error("[decrypt-worker] loop error:", err);
    }
    await sleep(5_000);
  }
}

runLoop();
