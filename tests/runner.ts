/**
 * Golden-dataset test runner.
 * Loads scenarios.json (pure data), executes onchain txs via cast,
 * asserts logs / DB / API results in given-when-then format.
 *
 * Assumes: Ponder + decrypt worker are running, Postgres is up.
 *
 * Scenarios:
 *   1. wrap-happy-path   — single wrap, verify indexer picks it up
 *   2. spiking-throughput — bulk confidential transfers then spike-delegate;
 *                           measures decrypt-worker throughput (handles/sec)
 *
 * Env knobs for spiking-throughput:
 *   SPIKE_ACCOUNTS  — number of mnemonic accounts (default 5)
 *   SPIKE_N         — confidential transfers per account (default 20)
 *   SPIKE_DRYRUN    — set to "1" to run only Phase 0 (precondition check)
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";

// ── Load env ──
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

const IS_LOCAL = (process.env.CHAIN ?? "sepolia").toLowerCase() === "local";
const RPC_URL = IS_LOCAL
  ? (process.env.PONDER_RPC_URL_31337 ?? "http://127.0.0.1:8545")
  : process.env.PONDER_RPC_URL_11155111!;
const DATABASE_URL = process.env.DATABASE_URL!;
const API_BASE = process.env.API_BASE ?? "http://localhost:42069";
const TOKEN = process.env.TOKEN_ADDRESS ?? (IS_LOCAL ? "0x0" : "0x46208622DA27d91db4f0393733C8BA082ed83158");
const UNDERLYING = process.env.UNDERLYING_ADDRESS ?? (IS_LOCAL ? "0x0" : "0xff54739b16576FA5402F211D0b938469Ab9A5f3F");

// Derive account[0] private key
const MNEMONIC = execSync("psst get MNEMONIC", { encoding: "utf-8" }).trim();
const ACTOR_PK = execSync(
  `cast wallet private-key --mnemonic "${MNEMONIC}" --mnemonic-index 0`,
  { encoding: "utf-8" },
).trim();

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

// ── Constants ──
/** Gas limit for FHE-encrypted transactions (confidentialTransfer, etc.) */
const FHE_GAS = 3_000_000;

/** The decrypt worker chunks at this size */
const HANDLES_PER_REQUEST = 28;

// ── Helpers ──
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function castSend(to: string, sig: string, args: string[], opts?: { pk?: string; gasLimit?: number }): string {
  const pk = opts?.pk ?? ACTOR_PK;
  const gas = opts?.gasLimit ?? 500_000;
  const cmd = `cast send ${to} "${sig}" ${args.join(" ")} --private-key ${pk} --rpc-url ${RPC_URL} --gas-limit ${gas} --json`;
  const out = execSync(cmd, { encoding: "utf-8", timeout: 120_000 });
  const json = JSON.parse(out);
  return json.transactionHash;
}

function castReceipt(txHash: string): any {
  const cmd = `cast receipt ${txHash} --rpc-url ${RPC_URL} --json`;
  return JSON.parse(execSync(cmd, { encoding: "utf-8", timeout: 30_000 }));
}

async function pollDb(
  query: string,
  params: any[],
  check: (rows: any[]) => boolean,
  timeoutMs = 60_000,
): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(query, params);
    if (check(rows)) return rows;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`DB poll timed out after ${timeoutMs}ms`);
}

async function apiFetch(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

function deriveAccount(index: number): { pk: string; address: string } {
  const pk = execSync(
    `cast wallet private-key --mnemonic "${MNEMONIC}" --mnemonic-index ${index}`,
    { encoding: "utf-8" },
  ).trim();
  const address = execSync(`cast wallet address ${pk}`, { encoding: "utf-8" }).trim().toLowerCase();
  return { pk, address };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Load scenarios ──
const scenarios = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "golden", "scenarios.json"), "utf-8"),
);

let passed = 0;
let failed = 0;

function log(_scenario: string, phase: string, ok: boolean, detail: string) {
  const icon = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${icon} [${phase}] ${detail}`);
  if (ok) passed++;
  else failed++;
}

// ── Scenario 1: wrap-happy-path ──
async function runWrapHappyPath(s: any) {
  console.log(`\n${BOLD}${YELLOW}GIVEN${RESET} ${s.given.narrative}`);
  console.log(`${BOLD}${YELLOW}WHEN${RESET}  ${s.when.narrative}`);

  // Execute foundry txs
  let wrapTxHash = "";
  for (let i = 0; i < s.when.steps.length; i++) {
    if (i > 0) execSync("sleep 3"); // let nonce propagate
    const step = s.when.steps[i];
    const hash = castSend(step.to, step.sig, step.args);
    console.log(`  tx: ${hash}`);
    if (step.captureHash) wrapTxHash = hash;
  }

  console.log(`${BOLD}${YELLOW}THEN${RESET}`);

  // (a) Log assertions
  const receipt = castReceipt(wrapTxHash);
  const logs = receipt.logs || [];
  const confTransferTopic = s.then.log.expectTopic0_ConfidentialTransfer.toLowerCase();
  const transferTopic = s.then.log.expectTopic0_Transfer.toLowerCase();
  const hasConfTransfer = logs.some((l: any) => l.topics?.[0]?.toLowerCase() === confTransferTopic);
  const hasTransfer = logs.some((l: any) => l.topics?.[0]?.toLowerCase() === transferTopic);
  log(s.name, "log", hasConfTransfer, `ConfidentialTransfer log in receipt`);
  log(s.name, "log", hasTransfer, `Underlying Transfer log in receipt`);

  // (b) DB assertion — poll for token_event with this tx hash
  const dbRows = await pollDb(
    `SELECT kind, to_addr, cleartext_amount FROM public.token_event WHERE tx_hash = $1 AND kind = 'wrap'`,
    [wrapTxHash.toLowerCase()],
    (rows) => rows.length > 0,
    60_000,
  );
  const row = dbRows[0];
  const kindOk = row.kind === s.then.db.expect.kind;
  const toOk = row.to_addr === s.then.db.expect.to_addr;
  const amountOk = String(row.cleartext_amount) === s.then.db.expect.cleartext_amount;
  log(s.name, "db", kindOk && toOk && amountOk,
    `token_event: kind=${row.kind}, to=${row.to_addr}, amount=${row.cleartext_amount}`);

  // (c) API assertion — poll transfers endpoint
  let apiOk = false;
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const data = await apiFetch(s.then.api.endpoint);
    const match = data.items?.find(
      (i: any) => i.kind === s.then.api.expectItem.kind && String(i.amount) === s.then.api.expectItem.amount,
    );
    if (match) {
      apiOk = true;
      log(s.name, "api", match.status === s.then.api.expectItem.status,
        `${s.then.api.endpoint} → kind=${match.kind}, amount=${match.amount}, status=${match.status}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!apiOk) log(s.name, "api", false, `wrap not found in API within timeout`);
}

// ── Scenario 2: spiking-throughput ──
async function runSpikingThroughput(s: any) {
  const ACCOUNTS = Number(process.env.SPIKE_ACCOUNTS ?? 5);
  const N = Number(process.env.SPIKE_N ?? 20);
  const DRYRUN = process.env.SPIKE_DRYRUN === "1";
  const TOTAL_HANDLES = ACCOUNTS * N;
  const PASS_THRESHOLD: number = s.then?.passThreshold ?? 0.95;
  const TIMEOUT_MS: number = s.then?.timeoutMs ?? 600_000;
  const INDEXER_INDEX = 9;
  const INDEXER_ADDR = "0xF2988048C7FE127b0a11E5BCD27557fcb445B133";
  const WRAP_AMOUNT = "10000000000000000000"; // 10 underlying tokens
  const TRANSFER_AMOUNT = "1"; // 1 wrapper unit per transfer (tiny)
  const MAX_EXPIRATION = "18446744073709551615";

  console.log(`\n${BOLD}${YELLOW}═══ spiking-throughput ═══${RESET}`);
  console.log(`  accounts=${ACCOUNTS}, transfers/account=${N}, total handles=${TOTAL_HANDLES}`);

  if (TOTAL_HANDLES < 3 * HANDLES_PER_REQUEST) {
    console.warn(
      `  ${YELLOW}WARNING${RESET}: total handles (${TOTAL_HANDLES}) < 3 × HANDLES_PER_REQUEST (${3 * HANDLES_PER_REQUEST}). ` +
      `Increase SPIKE_ACCOUNTS or SPIKE_N for a meaningful throughput measurement.`,
    );
  }

  // ── Phase 0: preconditions (no sends) ──
  console.log(`\n${BOLD}${YELLOW}PHASE 0${RESET} — Precondition check (no on-chain sends)`);

  interface AccountInfo {
    index: number;
    pk: string;
    address: string;
    ethBalance: bigint;
    underlyingBalance: bigint;
  }

  const accounts: AccountInfo[] = [];
  const MIN_ETH = BigInt("50000000000000000"); // 0.05 ETH for gas
  const MIN_UNDERLYING = BigInt(WRAP_AMOUNT);

  for (let i = 0; i < ACCOUNTS; i++) {
    const { pk, address } = deriveAccount(i);
    let ethBalance = 0n;
    let underlyingBalance = 0n;
    try {
      const ethRaw = execSync(
        `cast balance ${address} --rpc-url ${RPC_URL}`,
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();
      ethBalance = BigInt(ethRaw);
    } catch {}
    try {
      const ulRaw = execSync(
        `cast call ${UNDERLYING} "balanceOf(address)(uint256)" ${address} --rpc-url ${RPC_URL}`,
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();
      underlyingBalance = BigInt(ulRaw);
    } catch {}
    accounts.push({ index: i, pk, address, ethBalance, underlyingBalance });
  }

  // Print funding table
  let fundingNeeded = false;
  console.log(`\n  ${"Index".padEnd(6)} ${"Address".padEnd(44)} ${"ETH Balance".padEnd(24)} ${"Underlying".padEnd(24)} Status`);
  console.log(`  ${"─".repeat(6)} ${"─".repeat(44)} ${"─".repeat(24)} ${"─".repeat(24)} ${"─".repeat(12)}`);
  for (const a of accounts) {
    const needsEth = a.ethBalance < MIN_ETH;
    const needsUnderlying = a.underlyingBalance < MIN_UNDERLYING;
    const status = needsEth || needsUnderlying
      ? `${RED}NEEDS FUNDING${RESET}`
      : `${GREEN}OK${RESET}`;
    if (needsEth || needsUnderlying) fundingNeeded = true;
    const details: string[] = [];
    if (needsEth) details.push(`ETH: need ≥0.05`);
    if (needsUnderlying) details.push(`Underlying: need ≥${WRAP_AMOUNT}`);
    console.log(
      `  ${String(a.index).padEnd(6)} ${a.address.padEnd(44)} ${a.ethBalance.toString().padEnd(24)} ${a.underlyingBalance.toString().padEnd(24)} ${status}${details.length ? " (" + details.join(", ") + ")" : ""}`,
    );
  }

  if (fundingNeeded) {
    console.error(`\n  ${RED}${BOLD}ABORT${RESET}: One or more accounts lack funding. Fund them and re-run.`);
    await pool.end();
    process.exit(1);
  }

  log(s.name, "phase0", true, `All ${ACCOUNTS} accounts funded`);

  if (DRYRUN) {
    console.log(`\n  ${YELLOW}SPIKE_DRYRUN=1${RESET} — stopping after Phase 0.`);
    return;
  }

  // ── Phase 1: load (approve → wrap → N transfers per account) ──
  console.log(`\n${BOLD}${YELLOW}PHASE 1${RESET} — Load: approve → wrap → ${N} transfers × ${ACCOUNTS} accounts`);

  // Run accounts in parallel (independent nonce streams), sequential per account.
  const allTxHashes: string[][] = Array.from({ length: ACCOUNTS }, () => []);

  const phase1Tasks = accounts.map(async (acct, i) => {
    // Approve
    castSend(UNDERLYING, "approve(address,uint256)", [TOKEN, WRAP_AMOUNT], { pk: acct.pk });
    await sleep(1_000);
    // Wrap
    castSend(TOKEN, "wrap(address,uint256)", [acct.address, WRAP_AMOUNT], { pk: acct.pk });
    await sleep(2_000);
    // N confidential transfers to rotating counterparty
    const counterparty = accounts[(i + 1) % ACCOUNTS]!.address;
    for (let t = 0; t < N; t++) {
      const txHash = castSend(
        TOKEN,
        "confidentialTransfer(address,bytes32,bytes)",
        [counterparty, `0x${"00".repeat(32)}`, "0x"], // einput placeholder — real FHE input needed
        { pk: acct.pk, gasLimit: FHE_GAS },
      );
      allTxHashes[i]!.push(txHash);
      if (t % 5 === 4) await sleep(1_000); // pace within account
    }
  });

  await Promise.all(phase1Tasks);
  const flatTxHashes = allTxHashes.flat();
  console.log(`  Sent ${flatTxHashes.length} confidential transfers total`);

  // Collect expected amount handles from DB (poll until Ponder indexes them)
  console.log(`  Waiting for Ponder to index transfer events…`);
  let expectedHandles: string[] = [];
  const addrList = accounts.map((a) => a.address);
  await pollDb(
    `SELECT DISTINCT amount_handle FROM public.token_event
     WHERE kind = 'transfer' AND (from_addr = ANY($1) OR to_addr = ANY($1))
       AND amount_handle != '0x0000000000000000000000000000000000000000000000000000000000000000'`,
    [addrList],
    (rows) => {
      expectedHandles = rows.map((r: any) => (r.amount_handle as string).toLowerCase());
      return expectedHandles.length >= TOTAL_HANDLES;
    },
    300_000,
  );
  console.log(`  Collected ${expectedHandles.length} expected amount handles`);
  log(s.name, "phase1", expectedHandles.length >= TOTAL_HANDLES,
    `Expected ${TOTAL_HANDLES} handles, got ${expectedHandles.length}`);

  // ── Phase 2: the delegation spike ──
  console.log(`\n${BOLD}${YELLOW}PHASE 2${RESET} — Spike: delegate all ${ACCOUNTS} accounts to indexer simultaneously`);

  // Fire near-simultaneously (castSend is sync/execSync, but independent nonce streams)
  const delegationHashes: string[] = [];
  for (const acct of accounts) {
    const h = castSend(
      process.env.ACL_ADDRESS ?? "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
      "delegateForUserDecryption(address,address,uint64)",
      [INDEXER_ADDR, TOKEN, MAX_EXPIRATION],
      { pk: acct.pk, gasLimit: FHE_GAS },
    );
    delegationHashes.push(h);
  }
  console.log(`  Submitted ${delegationHashes.length} delegation txs`);

  // ── Phase 3: measure decryption throughput ──
  console.log(`\n${BOLD}${YELLOW}PHASE 3${RESET} — Measure: polling app.cleartext for decrypted handles`);

  const expectedSet = new Set(expectedHandles);
  let t0: number | null = null;
  let t1: number | null = null;
  let decryptedCount = 0;
  let lastDecryptedCount = 0;
  let plateauTicks = 0;
  const pollStart = Date.now();

  while (Date.now() - pollStart < TIMEOUT_MS) {
    const { rows } = await pool.query(
      `SELECT handle FROM app.cleartext WHERE status = 'decrypted' AND handle = ANY($1)`,
      [expectedHandles],
    );
    decryptedCount = rows.length;

    if (decryptedCount > 0 && t0 === null) {
      t0 = Date.now();
      console.log(`  t0: first handle decrypted (${decryptedCount} so far)`);
    }

    if (decryptedCount >= expectedHandles.length * PASS_THRESHOLD) {
      t1 = Date.now();
      console.log(`  t1: ≥95% decrypted (${decryptedCount}/${expectedHandles.length})`);
      break;
    }

    // Plateau detection
    if (decryptedCount === lastDecryptedCount && decryptedCount > 0) {
      plateauTicks++;
      if (plateauTicks >= 30) { // 30 × 2s = 60s plateau
        t1 = Date.now();
        console.log(`  t1: plateau at ${decryptedCount}/${expectedHandles.length}`);
        break;
      }
    } else {
      plateauTicks = 0;
    }
    lastDecryptedCount = decryptedCount;
    await sleep(2_000);
  }

  if (t1 === null) t1 = Date.now();
  if (t0 === null) t0 = t1;

  const durationSec = (t1 - t0) / 1000;
  const throughput = durationSec > 0 ? decryptedCount / durationSec : 0;
  const wallClock = (t1 - pollStart) / 1000;
  const passRate = decryptedCount / expectedHandles.length;
  const ok = passRate >= PASS_THRESHOLD;

  console.log(`\n  ${BOLD}── Results ──${RESET}`);
  console.log(`  Total handles:       ${expectedHandles.length}`);
  console.log(`  Decrypted:           ${decryptedCount} (${(passRate * 100).toFixed(1)}%)`);
  console.log(`  Throughput:          ${throughput.toFixed(2)} handles/sec (t0→t1 = ${durationSec.toFixed(1)}s)`);
  console.log(`  Wall-clock (incl. propagation): ${wallClock.toFixed(1)}s`);
  log(s.name, "throughput", ok,
    `${decryptedCount}/${expectedHandles.length} decrypted (${(passRate * 100).toFixed(1)}%), ` +
    `throughput=${throughput.toFixed(2)} handles/sec`);
}

// ── Main ──
async function main() {
  console.log(`${BOLD}═══ Golden-Dataset Test Runner ═══${RESET}`);
  console.log(`Scenarios: ${scenarios.length}`);

  for (const s of scenarios) {
    switch (s.name) {
      case "wrap-happy-path":
        await runWrapHappyPath(s);
        break;
      case "spiking-throughput":
        await runSpikingThroughput(s);
        break;
      default:
        console.log(`Unknown scenario: ${s.name}`);
        failed++;
    }
  }

  console.log(`\n${BOLD}═══ Results ═══${RESET}`);
  console.log(`${GREEN}Passed: ${passed}${RESET}  ${failed > 0 ? RED : ""}Failed: ${failed}${RESET}`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
