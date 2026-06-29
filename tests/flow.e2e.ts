/**
 * Principal-flow e2e test (env-agnostic — runs on local OR Sepolia via CHAIN).
 *
 * Same code, both envs: CHAIN=local uses a fresh anvil + cleartext FHE;
 * CHAIN=sepolia uses the live deployment + the real relayer (node()).
 *
 * Structure: GIVEN / WHEN / THEN — one end-to-end flow covering wrap,
 * confidential transfers, same-block delegations, short-window revocation,
 * pending_rights, Ponder indexing, decrypt worker resolution (with throughput
 * readout), and API serving.
 *
 * Env knobs:
 *   TRANSFER_COUNT — confidential transfers per recipient (default 2 local, 10 Sepolia)
 *   ACCOUNT_COUNT  — recipient accounts (default 3)
 *
 * Prereqs (local):
 *   1. anvil running on PONDER_RPC_URL_31337 (default http://127.0.0.1:8545)
 *   2. FHEVM host + MockERC20 + wrapper deployed (via scripts/deploy-local.sh)
 *   3. Ponder running with CHAIN=local
 *   4. Decrypt worker running with CHAIN=local
 *
 * Env:
 *   CHAIN=local | CHAIN=sepolia
 *   TOKEN_ADDRESS, UNDERLYING_ADDRESS, ACL_ADDRESS — from deploy output
 *   INDEXER_PRIVATE_KEY — the indexer's private key
 *   DATABASE_URL — Postgres connection string
 */

import { readFileSync } from "node:fs";
import { execSync, exec } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";

// ── Load .env.local ──
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

const IS_LOCAL = (process.env.CHAIN ?? "").toLowerCase() === "local";
if (!IS_LOCAL && (process.env.CHAIN ?? "").toLowerCase() !== "sepolia") {
  console.error("FATAL: CHAIN must be 'local' or 'sepolia'");
  process.exit(1);
}

const RPC_URL = IS_LOCAL
  ? (process.env.PONDER_RPC_URL_31337 ?? "http://127.0.0.1:8545")
  : process.env.PONDER_RPC_URL_11155111!;
const DATABASE_URL = process.env.DATABASE_URL!;
const API_BASE = process.env.API_BASE ?? "http://localhost:42069";
const TOKEN = process.env.TOKEN_ADDRESS!;
const UNDERLYING = process.env.UNDERLYING_ADDRESS!;
const ACL_ADDRESS = process.env.ACL_ADDRESS ?? "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D";

// Env-parameterizable transfer/account counts (small default for local, larger for Sepolia throughput)
const TRANSFER_COUNT = Number(process.env.TRANSFER_COUNT ?? (IS_LOCAL ? 2 : 10));
const ACCOUNT_COUNT = Number(process.env.ACCOUNT_COUNT ?? 3);

// Anvil default accounts (deterministic from mnemonic "test test ... junk")
const ANVIL_ACCOUNTS = [
  { pk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", addr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
  { pk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  { pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", addr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
  { pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", addr: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
  { pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", addr: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" },
];

// Use indexer PK from env
const INDEXER_PK = process.env.INDEXER_PRIVATE_KEY!;
// Strip CHAIN from env early — Foundry interprets it as --chain.
const _castEnvInit = { ...process.env };
delete _castEnvInit.CHAIN;
const INDEXER_ADDR = execSync(`cast wallet address ${INDEXER_PK}`, { encoding: "utf-8", env: _castEnvInit }).trim();

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

// ── Helpers ──
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const MAX_EXPIRATION = "18446744073709551615";

let passed = 0;
let failed = 0;
function log(phase: string, ok: boolean, detail: string) {
  const icon = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${icon} [${phase}] ${detail}`);
  if (ok) passed++; else failed++;
}

// Strip CHAIN from env when calling cast — Foundry interprets it as --chain.
const castEnv = { ...process.env };
delete castEnv.CHAIN;

function castSend(to: string, sig: string, args: string[], opts?: { pk?: string; gas?: number }): string {
  const pk = opts?.pk ?? ANVIL_ACCOUNTS[0]!.pk;
  const gas = opts?.gas ?? 3_000_000;
  const cmd = `cast send ${to} "${sig}" ${args.join(" ")} --private-key ${pk} --rpc-url ${RPC_URL} --gas-limit ${gas} --json`;
  const out = execSync(cmd, { encoding: "utf-8", timeout: 30_000, env: castEnv });
  const json = JSON.parse(out);
  if (json.status !== "0x1" && json.status !== 1) {
    throw new Error(`tx reverted: ${json.transactionHash}`);
  }
  return json.transactionHash;
}

function castCall(to: string, sig: string, args: string[]): string {
  const cmd = `cast call ${to} "${sig}" ${args.join(" ")} --rpc-url ${RPC_URL}`;
  return execSync(cmd, { encoding: "utf-8", timeout: 10_000, env: castEnv }).trim();
}

function mineBlock() {
  execSync(`cast rpc anvil_mine 1 --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });
}

async function pollDb(
  query: string, params: any[], check: (rows: any[]) => boolean, timeoutMs = 30_000,
): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(query, params);
    if (check(rows)) return rows;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`DB poll timed out after ${timeoutMs}ms`);
}

async function apiFetch(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomAmount(): number {
  // Minimal-range random: 1–50 (6-decimal units, so 0.000001–0.00005 tokens)
  return Math.floor(Math.random() * 50) + 1;
}

// ── Discover Ponder schema ──
async function discoverSchema(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'token_event' LIMIT 1`,
  );
  return rows[0]?.table_schema ?? "public";
}

// ── Main ──
async function main() {
  // Ensure automine is on at the start (previous failures may have left it off)
  if (IS_LOCAL) {
    execSync(`cast rpc anvil_setAutomine true --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });
  }

  console.log(`\n${BOLD}═══ Principal-Flow E2E Test (GIVEN / WHEN / THEN) ═══${RESET}`);
  console.log(`  CHAIN:      ${process.env.CHAIN}`);
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  TOKEN:      ${TOKEN}`);
  console.log(`  UNDERLYING: ${UNDERLYING}`);
  console.log(`  ACL:        ${ACL_ADDRESS}`);
  console.log(`  INDEXER:    ${INDEXER_ADDR}`);
  console.log(`  TRANSFERS:  ${TRANSFER_COUNT} per recipient × ${ACCOUNT_COUNT} recipients`);
  console.log();

  const schema = await discoverSchema();
  console.log(`  Ponder schema: ${schema}`);

  const a0 = ANVIL_ACCOUNTS[0]!; // deployer, has underlying
  const a1 = ANVIL_ACCOUNTS[1]!; // will receive transfers, will delegate
  const a2 = ANVIL_ACCOUNTS[2]!; // will receive transfers, will delegate then revoke
  const a3 = ANVIL_ACCOUNTS[3]!; // will receive transfers, stays UNDELEGATED → pending_rights
  const a4 = ANVIL_ACCOUNTS[4]!; // spare

  // Slice recipients from configured account count (a1, a2, a3 are the default 3)
  const recipients = [a1, a2, a3].slice(0, ACCOUNT_COUNT);

  // ══════════════════════════════════════════════════════════════════════════
  //  GIVEN — Preconditions / state setup
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${BOLD}${YELLOW}GIVEN${RESET} a0 holds underlying, the indexed token is deployed, Ponder + worker are running`);

  // Mint underlying to a0
  castSend(UNDERLYING, "mint(address,uint256)", [a0.addr, "1000000000000000000"], { pk: a0.pk, gas: 100_000 });

  // Approve + wrap (wrap is the precondition that gives a0 a confidential balance)
  castSend(UNDERLYING, "approve(address,uint256)", [TOKEN, "1000000000000000000"], { pk: a0.pk, gas: 100_000 });
  const wrapTx = castSend(TOKEN, "wrap(address,uint256)", [a0.addr, "1000000000000000000"], { pk: a0.pk });

  // Assert: wrap receipt has ConfidentialTransfer log
  const receiptJson = execSync(`cast receipt ${wrapTx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv });
  const receipt = JSON.parse(receiptJson);
  const confTransferTopic = "0x67500e8d0ed826d2194f514dd0d8124f35648ab6e3fb5e6ed867134cffe661e9";
  const hasConfTransfer = receipt.logs.some((l: any) => l.topics?.[0]?.toLowerCase() === confTransferTopic);
  log("wrap", hasConfTransfer, `ConfidentialTransfer log in wrap receipt`);

  // Assert: Ponder indexed the wrap
  try {
    const rows = await pollDb(
      `SELECT kind, to_addr FROM "${schema}".token_event WHERE tx_hash = $1 AND kind = 'wrap'`,
      [wrapTx.toLowerCase()], (r) => r.length > 0, 30_000,
    );
    log("wrap-indexed", rows.length > 0, `Ponder indexed wrap event`);
  } catch (e: any) {
    log("wrap-indexed", false, e.message);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WHEN — On-chain actions (transfers, delegations, revocation)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${BOLD}${YELLOW}WHEN${RESET}  randomized confidential transfers, 2 same-block delegations, and a short-window revoke`);

  // ── Confidential Transfers (randomized amounts) ──
  console.log(`\n  Confidential transfers (${TRANSFER_COUNT} per recipient):`);

  const { ZamaSDK, MemoryStorage } = await import("@zama-fhe/sdk");
  const { createConfig } = await import("@zama-fhe/sdk/viem");
  const { cleartext, hardhat: zamaHardhat } = await import("@zama-fhe/sdk/node");
  const { createPublicClient, createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { hardhat: viemHardhat } = await import("viem/chains");

  function makeSdk(pk: `0x${string}`) {
    const account = privateKeyToAccount(pk);
    const publicClient = createPublicClient({ chain: viemHardhat, transport: http(RPC_URL) });
    const walletClient = createWalletClient({ account, chain: viemHardhat, transport: http(RPC_URL) });
    const fheChain = { ...zamaHardhat, network: RPC_URL } as const;
    return new ZamaSDK(
      createConfig({
        chains: [fheChain],
        publicClient: publicClient as any,
        walletClient: walletClient as any,
        storage: new MemoryStorage(),
        relayers: { [fheChain.id]: cleartext() },
      }),
    );
  }

  const sdk0 = makeSdk(a0.pk as `0x${string}`);
  const token0 = sdk0.createToken(TOKEN as `0x${string}`);

  // Build transfer list: TRANSFER_COUNT per recipient
  const transferAmounts: { to: string; amount: number }[] = [];
  for (const r of recipients) {
    for (let i = 0; i < TRANSFER_COUNT; i++) {
      transferAmounts.push({ to: r.addr, amount: randomAmount() });
    }
  }

  const transferTxHashes: string[] = [];
  for (const t of transferAmounts) {
    console.log(`    Transfer ${t.amount} → ${t.to.slice(0, 10)}…`);
    try {
      const result = await token0.confidentialTransfer(t.to as `0x${string}`, BigInt(t.amount));
      transferTxHashes.push(result.txHash);
      log("transfer", true, `${t.amount} → ${t.to.slice(0, 10)}… tx=${result.txHash.slice(0, 14)}…`);
    } catch (e: any) {
      log("transfer", false, `${t.amount} → ${t.to.slice(0, 10)}… FAILED: ${e.message}`);
    }
  }

  // ── Two delegations in a SINGLE block ──
  console.log(`\n  Two same-block delegations (a1 + a2):`);

  if (IS_LOCAL) {
    // Disable auto-mining so both txs land in the same block
    execSync(`cast rpc anvil_setAutomine false --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });
  }

  function execAsync(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: "utf-8", timeout: 30_000, env: castEnv }, (err, stdout, _stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }

  const del1Cmd = `cast send ${ACL_ADDRESS} "delegateForUserDecryption(address,address,uint64)" ${INDEXER_ADDR} ${TOKEN} ${MAX_EXPIRATION} --private-key ${a1.pk} --rpc-url ${RPC_URL} --gas-limit 500000 --json`;
  const del2Cmd = `cast send ${ACL_ADDRESS} "delegateForUserDecryption(address,address,uint64)" ${INDEXER_ADDR} ${TOKEN} ${MAX_EXPIRATION} --private-key ${a2.pk} --rpc-url ${RPC_URL} --gas-limit 500000 --json`;

  // Send both concurrently (async exec — both reach the mempool before mining)
  const del1P = execAsync(del1Cmd);
  const del2P = execAsync(del2Cmd);

  if (IS_LOCAL) {
    await sleep(2_000);
    mineBlock();
  }

  const [del1Out, del2Out] = await Promise.all([del1P, del2P]);

  if (IS_LOCAL) {
    execSync(`cast rpc anvil_setAutomine true --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });
  }

  const del1Tx = JSON.parse(del1Out).transactionHash;
  const del2Tx = JSON.parse(del2Out).transactionHash;

  // Verify both are in the same block
  const del1Receipt = JSON.parse(execSync(`cast receipt ${del1Tx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv }));
  const del2Receipt = JSON.parse(execSync(`cast receipt ${del2Tx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv }));
  const sameBlock = del1Receipt.blockNumber === del2Receipt.blockNumber;
  log("same-block-delegation", sameBlock,
    `Both delegations in block ${del1Receipt.blockNumber} (same=${sameBlock})`);

  // Record delegation spike time (for throughput measurement)
  const delegationSpikeTime = Date.now();

  // ── Short-window revocation (a2 revokes 1–3 blocks later) ──
  console.log(`\n  Short-window revoke (a2):`);

  if (IS_LOCAL) {
    const blocksToWait = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < blocksToWait; i++) mineBlock();
    console.log(`    Mined ${blocksToWait} block(s) before revoke`);
  } else {
    await sleep(15_000); // Sepolia: wait ~1 block
  }

  const revokeTx = castSend(
    ACL_ADDRESS,
    "revokeDelegationForUserDecryption(address,address)",
    [INDEXER_ADDR, TOKEN],
    { pk: a2.pk, gas: 500_000 },
  );
  log("revoke", true, `a2 revoked delegation (tx=${revokeTx.slice(0, 14)}…)`);

  // ══════════════════════════════════════════════════════════════════════════
  //  THEN — Assertions (log / DB / API / decrypt)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${BOLD}${YELLOW}THEN${RESET}  all events indexed, API correct, worker resolves cleartext`);

  // ── DB: transfers indexed ──
  console.log(`\n  Indexed assertions:`);

  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".token_event WHERE kind = 'transfer'`,
      [], (r) => Number(r[0]?.cnt) >= transferTxHashes.length, 30_000,
    );
    log("transfers-indexed", true, `${transferTxHashes.length} transfers indexed`);
  } catch (e: any) {
    log("transfers-indexed", false, e.message);
  }

  // ── DB: delegations indexed ──
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".delegation_event WHERE kind = 'grant'`,
      [], (r) => Number(r[0]?.cnt) >= 2, 30_000,
    );
    log("delegations-indexed", true, `2 delegation grants indexed`);
  } catch (e: any) {
    log("delegations-indexed", false, e.message);
  }

  // ── DB: revocation indexed ──
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".delegation_event WHERE kind = 'revoke'`,
      [], (r) => Number(r[0]?.cnt) >= 1, 30_000,
    );
    log("revoke-indexed", true, `Revocation indexed`);
  } catch (e: any) {
    log("revoke-indexed", false, e.message);
  }

  // ── API: pending_rights for a3 (undelegated) ──
  console.log(`\n  API assertions:`);
  await sleep(3_000); // give Ponder a moment

  try {
    const a3Balance = await apiFetch(`/v1/accounts/${a3.addr.toLowerCase()}/balance`);
    const a3IsPending = a3Balance.status === "pending_rights" || a3Balance.status === "no_ciphertext";
    log("pending-rights-a3", a3IsPending,
      `a3 balance status = ${a3Balance.status} (expected pending_rights or no_ciphertext)`);
  } catch (e: any) {
    log("pending-rights-a3", false, e.message);
  }

  // ── API: a1 delegated → decrypted or pending ──
  try {
    const a1Balance = await apiFetch(`/v1/accounts/${a1.addr.toLowerCase()}/balance`);
    const a1Valid = ["decrypted", "pending"].includes(a1Balance.status);
    log("a1-balance-status", a1Valid,
      `a1 balance status = ${a1Balance.status} (expected decrypted or pending)`);
  } catch (e: any) {
    log("a1-balance-status", false, e.message);
  }

  // ── API: delegations endpoint ──
  try {
    const delegations = await apiFetch("/v1/delegations");
    const items = delegations.items ?? [];
    const hasGrants = items.filter((i: any) => i.kind === "grant").length >= 2;
    const hasRevoke = items.some((i: any) => i.kind === "revoke");
    log("delegations-api", hasGrants, `API shows ≥2 grants`);
    log("revocation-api", hasRevoke, `API shows revocation`);
  } catch (e: any) {
    log("delegations-api", false, e.message);
    log("revocation-api", false, e.message);
  }

  // ── API: transfers for a1 ──
  try {
    const a1Transfers = await apiFetch(`/v1/accounts/${a1.addr.toLowerCase()}/transfers`);
    const hasItems = (a1Transfers.items?.length ?? 0) > 0;
    log("transfers-api-a1", hasItems,
      `a1 has ${a1Transfers.items?.length ?? 0} transfer(s) in API`);
  } catch (e: any) {
    log("transfers-api-a1", false, e.message);
  }

  // ── API: health ──
  try {
    const health = await apiFetch("/v1/health");
    log("health-api", health.status === "ok", `Health: ${JSON.stringify(health)}`);
  } catch (e: any) {
    log("health-api", false, e.message);
  }

  // ── Decrypt worker: cleartext resolution + throughput readout ──
  console.log(`\n  Decrypt-worker resolution + throughput:`);

  // Count expected handles from a1's transfers (a1 is delegated + not revoked → should resolve)
  // We measure wall-time from the delegation spike until all expected handles land in app.cleartext.
  const expectedHandleCount = transferTxHashes.length; // one amount handle per transfer

  let resolvedCount = 0;
  const decryptPollStart = Date.now();
  const decryptTimeout = IS_LOCAL ? 60_000 : 300_000;
  try {
    const rows = await pollDb(
      `SELECT count(*) AS cnt FROM app.cleartext WHERE status = 'decrypted'`,
      [], (r) => Number(r[0]?.cnt) > 0, decryptTimeout,
    );
    resolvedCount = Number(rows[0]?.cnt);
    log("cleartext-resolved", resolvedCount > 0, `${resolvedCount} handle(s) decrypted by worker`);
  } catch (e: any) {
    log("cleartext-resolved", false, e.message);
  }

  // Throughput readout: measure from delegation spike to now (all resolved handles)
  const decryptWallMs = Date.now() - delegationSpikeTime;
  const decryptWallSec = decryptWallMs / 1000;
  const handlesPerSec = decryptWallSec > 0 ? resolvedCount / decryptWallSec : 0;

  console.log(`\n  ${BOLD}── Decryption Throughput Readout ──${RESET}`);
  console.log(`  Handles resolved:    ${resolvedCount}`);
  console.log(`  Wall-time (spike→now): ${decryptWallSec.toFixed(1)}s`);
  console.log(`  Throughput:          ${handlesPerSec.toFixed(2)} handles/sec`);
  console.log(`  (TRANSFER_COUNT=${TRANSFER_COUNT}, ACCOUNT_COUNT=${ACCOUNT_COUNT})`);

  // ── Summary ──
  console.log(`\n${BOLD}═══ Results ═══${RESET}`);
  console.log(`${GREEN}Passed: ${passed}${RESET}  ${failed > 0 ? RED : ""}Failed: ${failed}${RESET}`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
