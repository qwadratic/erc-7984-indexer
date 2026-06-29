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

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── PID lock: single-instance guard ──
const LOCK_FILE = resolve(import.meta.dirname ?? ".", "..", ".decrypt-worker.lock");

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    try {
      const raw = readFileSync(LOCK_FILE, "utf-8").trim();
      const pid = Number(raw);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // throws ESRCH if dead
          console.log(`[decrypt-worker] another instance is running (pid ${pid}) — exiting`);
          process.exit(1);
        } catch (e: any) {
          if (e?.code !== "ESRCH") throw e; // unexpected error
          // stale lock — fall through
        }
      }
    } catch (e: any) {
      if (e?.code === "ENOENT") { /* race: file vanished */ }
      else if (typeof e?.code === "string" && e.code === "ESRCH") { /* handled above */ }
      else if (e !== undefined && (e as any).message?.includes("exiting")) throw e;
      // garbage file — fall through
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const content = readFileSync(LOCK_FILE, "utf-8").trim();
      if (content === String(process.pid)) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {}
}

acquireLock();

process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); process.exit(143); });
process.on("uncaughtException", (err) => {
  console.error("[decrypt-worker] uncaughtException:", err);
  releaseLock();
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
import { node } from "@zama-fhe/sdk/node";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// ── Config ──
const TOKEN = (process.env.TOKEN_ADDRESS ?? "").toLowerCase() as Address;
const INDEXER_PK = process.env.INDEXER_PRIVATE_KEY as `0x${string}`;
const RPC_URL = process.env.PONDER_RPC_URL_11155111!;
const DATABASE_URL = process.env.DATABASE_URL!;
// Gateway caps a decryption request at MAX_DECRYPTION_REQUEST_BITS = 2048 TOTAL encrypted
// bits (proven: gateway-contracts/contracts/Decryption.sol:151 in zama-ai/fhevm; mirrored
// client-side by @zama-fhe/relayer-sdk check2048EncryptedBits). It's a BIT budget, not a
// handle count: euint64 = 64 bits → 2048/64 = 32 max; we use 28 (conservative, euint64-only).
const HANDLES_PER_REQUEST = 28;

// ── Postgres ──
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

await pool.query(`
  CREATE SCHEMA IF NOT EXISTS app;
  CREATE TABLE IF NOT EXISTS app.cleartext (
    handle text PRIMARY KEY,
    value  numeric,
    status text NOT NULL,
    decrypted_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE app.cleartext ADD COLUMN IF NOT EXISTS decrypted_at timestamptz NOT NULL DEFAULT now();
`);

async function upsertCleartext(handle: string, value: bigint) {
  await pool.query(
    `INSERT INTO app.cleartext (handle, value, status, decrypted_at) VALUES ($1, $2, 'decrypted', now())
     ON CONFLICT (handle) DO UPDATE SET value = EXCLUDED.value, status = 'decrypted', decrypted_at = now()`,
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
const account = privateKeyToAccount(INDEXER_PK);
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});
const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport: http(RPC_URL),
});

const chain = { ...zamaSepolia, network: RPC_URL } as const;
const sdk = new ZamaSDK(
  createConfig({
    chains: [chain],
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    storage: new MemoryStorage(),
    relayers: { [chain.id]: node() },
  }),
);

console.log(`[decrypt-worker] SDK built, signer=${account.address}`);

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

async function getBalanceRow(
  addr: Address,
): Promise<{ handle: Hex | null; stale: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT balance_handle, stale FROM "${PONDER_SCHEMA}".balances
     WHERE address = $1 AND token = $2`,
    [addr.toLowerCase(), TOKEN],
  );
  if (rows.length === 0) return null;
  return { handle: (rows[0].balance_handle as Hex) ?? null, stale: rows[0].stale };
}

async function updateBalanceHandle(
  address: Address,
  handle: Hex,
  block: bigint,
) {
  await pool.query(
    `UPDATE "${PONDER_SCHEMA}".balances
     SET balance_handle = $1, handle_block = $2, stale = false
     WHERE address = $3 AND token = $4`,
    [handle, block.toString(), address.toLowerCase(), TOKEN],
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

/**
 * Counterparty-dedup: check which handles are already decrypted in app.cleartext.
 * A shared transfer-amount handle decrypted via one party is reused for the
 * counterparty — never decrypt the same handle twice.
 */
async function getExistingHandles(handles: string[]): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT handle FROM app.cleartext WHERE handle = ANY($1)`,
    [handles.map((h) => h.toLowerCase())],
  );
  return new Set(rows.map((r: any) => r.handle));
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

// Batch-decrypt transfer amounts with per-entry error isolation: one bad/unpropagated
// handle doesn't sink the whole chunk. The SDK bounds its own fallback parallelism via
// maxConcurrency (= DECRYPT_RELAY_CONCURRENCY) — no external pLimit needed.
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
  console.log("[decrypt-worker] Starting main loop (balance gate → batch transfers)...");
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

      let totalDecrypted = 0;

      // Per delegator: (1) refresh + decrypt the current balance as a propagation gate,
      // (2) if propagated, batch-decrypt that delegator's undecrypted transfer amounts.
      for (const delegator of delegators) {
        try {
          // ── (1) Current balance handle (refresh at HEAD on new activity) ──
          const row = await getBalanceRow(delegator);
          let handle: Hex | null = row?.handle ?? null;
          if (!row || row.stale || !handle) {
            const head = (await publicClient.readContract({
              address: TOKEN,
              abi: BALANCE_ABI,
              functionName: "confidentialBalanceOf",
              args: [delegator as `0x${string}`],
            })) as Hex;
            const blockNum = await publicClient.getBlockNumber();
            await updateBalanceHandle(delegator, head, blockNum);
            handle = head;
          }

          // ── (2) Propagation gate: a successful balance decrypt confirms propagation.
          //         Not propagated → skip this delegator this tick.
          let propagated = true;
          if (handle && handle !== ZERO_HANDLE) {
            const existing = await getExistingHandles([handle]);
            if (!existing.has(handle.toLowerCase())) {
              const res = await tryDecrypt(delegator, [handle]);
              if (res === "not_propagated") {
                propagated = false;
              } else {
                for (const r of res) {
                  await upsertCleartext(r.handle, r.value);
                  totalDecrypted++;
                }
              }
            }
          }
          if (!propagated) continue;

          // ── (3) Transfer amounts via batch decrypt (per-entry error isolation) ──
          const transfers = await getTransferHandles(delegator);
          if (transfers.length === 0) continue;
          const existing = await getExistingHandles(transfers);
          const needed = transfers.filter((h) => !existing.has(h.toLowerCase()));
          if (needed.length === 0) continue;

          console.log(
            `[decrypt-worker] ${delegator}: batch-decrypting ${needed.length} transfer handle(s)`,
          );
          for (const chunk of chunks(needed, HANDLES_PER_REQUEST)) {
            const res = await tryBatchDecrypt(delegator, chunk as Hex[]);
            for (const r of res) {
              await upsertCleartext(r.handle, r.value);
              totalDecrypted++;
            }
          }
        } catch (err: any) {
          console.error(
            `[decrypt-worker] delegator=${delegator} loop error:`,
            err?.message ?? err,
          );
        }
      }

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
