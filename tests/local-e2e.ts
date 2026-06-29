/**
 * Local principal-flow e2e test.
 *
 * Runs the same sequence as the Sepolia test-plan against a local anvil
 * with cleartext FHE. Validates: wrap, confidential transfers, same-block
 * delegations, short-window revocation, pending_rights, Ponder indexing,
 * decrypt worker resolution, and API serving.
 *
 * Prereqs:
 *   1. anvil running on PONDER_RPC_URL_31337 (default http://127.0.0.1:8545)
 *   2. FHEVM host + MockERC20 + wrapper deployed (via scripts/deploy-local.sh)
 *   3. Ponder running with CHAIN=local
 *   4. Decrypt worker running with CHAIN=local
 *
 * Env:
 *   CHAIN=local (required)
 *   TOKEN_ADDRESS, UNDERLYING_ADDRESS, ACL_ADDRESS — from deploy-local.sh output
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

// Force local mode
if ((process.env.CHAIN ?? "").toLowerCase() !== "local") {
  console.error("FATAL: This test requires CHAIN=local");
  process.exit(1);
}

const RPC_URL = process.env.PONDER_RPC_URL_31337 ?? "http://127.0.0.1:8545";
const DATABASE_URL = process.env.DATABASE_URL!;
const API_BASE = process.env.API_BASE ?? "http://localhost:42069";
const TOKEN = process.env.TOKEN_ADDRESS!;
const UNDERLYING = process.env.UNDERLYING_ADDRESS!;
const ACL_ADDRESS = process.env.ACL_ADDRESS ?? "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D";

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
  execSync(`cast rpc anvil_setAutomine true --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });

  console.log(`\n${BOLD}═══ Local E2E Principal Flow Test ═══${RESET}`);
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  TOKEN:      ${TOKEN}`);
  console.log(`  UNDERLYING: ${UNDERLYING}`);
  console.log(`  ACL:        ${ACL_ADDRESS}`);
  console.log(`  INDEXER:    ${INDEXER_ADDR}`);
  console.log();

  const schema = await discoverSchema();
  console.log(`  Ponder schema: ${schema}`);

  const a0 = ANVIL_ACCOUNTS[0]!; // deployer, has underlying
  const a1 = ANVIL_ACCOUNTS[1]!; // will receive transfers, will delegate
  const a2 = ANVIL_ACCOUNTS[2]!; // will receive transfers, will delegate then revoke
  const a3 = ANVIL_ACCOUNTS[3]!; // will receive transfers, stays UNDELEGATED → pending_rights
  const a4 = ANVIL_ACCOUNTS[4]!; // spare

  // ──────────────────────────────────────────────
  // PHASE 1: Wrap
  // ──────────────────────────────────────────────
  console.log(`\n${BOLD}${YELLOW}PHASE 1${RESET} — Mint underlying → Approve → Wrap`);

  // Mint underlying to a0
  castSend(UNDERLYING, "mint(address,uint256)", [a0.addr, "1000000000000000000"], { pk: a0.pk, gas: 100_000 });

  // Approve + wrap
  castSend(UNDERLYING, "approve(address,uint256)", [TOKEN, "1000000000000000000"], { pk: a0.pk, gas: 100_000 });
  const wrapTx = castSend(TOKEN, "wrap(address,uint256)", [a0.addr, "1000000000000000000"], { pk: a0.pk });

  // Verify wrap receipt has ConfidentialTransfer log
  const receiptJson = execSync(`cast receipt ${wrapTx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv });
  const receipt = JSON.parse(receiptJson);
  const confTransferTopic = "0x67500e8d0ed826d2194f514dd0d8124f35648ab6e3fb5e6ed867134cffe661e9";
  const hasConfTransfer = receipt.logs.some((l: any) => l.topics?.[0]?.toLowerCase() === confTransferTopic);
  log("wrap", hasConfTransfer, `ConfidentialTransfer log in wrap receipt`);

  // Check Ponder indexed the wrap
  try {
    const rows = await pollDb(
      `SELECT kind, to_addr FROM "${schema}".token_event WHERE tx_hash = $1 AND kind = 'wrap'`,
      [wrapTx.toLowerCase()], (r) => r.length > 0, 30_000,
    );
    log("wrap-indexed", rows.length > 0, `Ponder indexed wrap event`);
  } catch (e: any) {
    log("wrap-indexed", false, e.message);
  }

  // ──────────────────────────────────────────────
  // PHASE 2: Confidential Transfers (randomized amounts)
  // ──────────────────────────────────────────────
  console.log(`\n${BOLD}${YELLOW}PHASE 2${RESET} — Randomized confidential transfers`);

  // a0 needs encrypted inputs for transfers. In cleartext mode, we use the SDK high-level
  // API via the encrypt path. But since we're using cast (no SDK), we use the SDK's
  // encrypt mechanism. For cleartext mode on anvil, we can call encrypt via the
  // InputVerifier-compatible path. Actually, for a minimal test, we'll use
  // the contract's `confidentialTransfer(address to, euint64 amount)` overload
  // which takes an existing encrypted handle (the balance handle).
  // BUT that only transfers the FULL balance.
  //
  // For partial transfers, we need the `confidentialTransfer(address, bytes32, bytes)` overload
  // with an encrypted input. In cleartext mode, the CleartextFHEVMExecutor handles this.
  //
  // The simplest approach for local testing: use the SDK directly from TypeScript.
  // Let's dynamically import the SDK and use createToken().confidentialTransfer().

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

  // Transfer to a1, a2, a3 with randomized amounts
  const transferAmounts: { to: string; amount: number }[] = [
    { to: a1.addr, amount: randomAmount() },
    { to: a1.addr, amount: randomAmount() },
    { to: a2.addr, amount: randomAmount() },
    { to: a2.addr, amount: randomAmount() },
    { to: a3.addr, amount: randomAmount() }, // a3 will stay undelegated
  ];

  const transferTxHashes: string[] = [];
  for (const t of transferAmounts) {
    console.log(`  Transfer ${t.amount} → ${t.to.slice(0, 10)}…`);
    try {
      const result = await token0.confidentialTransfer(t.to as `0x${string}`, BigInt(t.amount));
      transferTxHashes.push(result.txHash);
      log("transfer", true, `${t.amount} → ${t.to.slice(0, 10)}… tx=${result.txHash.slice(0, 14)}…`);
    } catch (e: any) {
      log("transfer", false, `${t.amount} → ${t.to.slice(0, 10)}… FAILED: ${e.message}`);
    }
  }

  // Wait for Ponder to index transfers
  console.log(`  Waiting for Ponder to index transfers…`);
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".token_event WHERE kind = 'transfer'`,
      [], (r) => Number(r[0]?.cnt) >= transferTxHashes.length, 30_000,
    );
    log("transfers-indexed", true, `${transferTxHashes.length} transfers indexed`);
  } catch (e: any) {
    log("transfers-indexed", false, e.message);
  }

  // ──────────────────────────────────────────────
  // PHASE 3: Two delegations in a SINGLE block
  // ──────────────────────────────────────────────
  console.log(`\n${BOLD}${YELLOW}PHASE 3${RESET} — 2 delegations in a single block (a1 + a2)`);

  // Disable auto-mining so both txs land in the same block
  execSync(`cast rpc anvil_setAutomine false --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });

  // Helper: async exec wrapped in a promise
  function execAsync(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: "utf-8", timeout: 30_000, env: castEnv }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }

  // Submit both delegations (from a1 and a2, different delegators → no ACL conflict)
  const del1Cmd = `cast send ${ACL_ADDRESS} "delegateForUserDecryption(address,address,uint64)" ${INDEXER_ADDR} ${TOKEN} ${MAX_EXPIRATION} --private-key ${a1.pk} --rpc-url ${RPC_URL} --gas-limit 500000 --json`;
  const del2Cmd = `cast send ${ACL_ADDRESS} "delegateForUserDecryption(address,address,uint64)" ${INDEXER_ADDR} ${TOKEN} ${MAX_EXPIRATION} --private-key ${a2.pk} --rpc-url ${RPC_URL} --gas-limit 500000 --json`;

  // Send both concurrently (async exec — both reach anvil’s mempool before mining)
  const del1P = execAsync(del1Cmd);
  const del2P = execAsync(del2Cmd);

  // Give both txs a moment to reach the mempool
  await sleep(2_000);

  // Mine one block containing both
  mineBlock();

  // Both execs now resolve (cast got receipts from the mined block)
  const [del1Out, del2Out] = await Promise.all([del1P, del2P]);

  // Re-enable auto-mining
  execSync(`cast rpc anvil_setAutomine true --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });

  const del1Tx = JSON.parse(del1Out).transactionHash;
  const del2Tx = JSON.parse(del2Out).transactionHash;

  // Verify both are in the same block
  const del1Receipt = JSON.parse(execSync(`cast receipt ${del1Tx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv }));
  const del2Receipt = JSON.parse(execSync(`cast receipt ${del2Tx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv }));
  const sameBlock = del1Receipt.blockNumber === del2Receipt.blockNumber;
  log("same-block-delegation", sameBlock,
    `Both delegations in block ${del1Receipt.blockNumber} (same=${sameBlock})`);

  // Wait for Ponder to index delegations
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".delegation_event WHERE kind = 'grant'`,
      [], (r) => Number(r[0]?.cnt) >= 2, 30_000,
    );
    log("delegations-indexed", true, `2 delegation grants indexed`);
  } catch (e: any) {
    log("delegations-indexed", false, e.message);
  }

  // ──────────────────────────────────────────────
  // PHASE 4: Revoke a2's delegation 1–3 blocks later
  // ──────────────────────────────────────────────
  console.log(`\n${BOLD}${YELLOW}PHASE 4${RESET} — Revoke a2's delegation (short window)`);

  // Mine 1–3 blocks first (simulate short window)
  const blocksToWait = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < blocksToWait; i++) mineBlock();
  console.log(`  Mined ${blocksToWait} block(s) before revoke`);

  const revokeTx = castSend(
    ACL_ADDRESS,
    "revokeDelegationForUserDecryption(address,address)",
    [INDEXER_ADDR, TOKEN],
    { pk: a2.pk, gas: 500_000 },
  );
  log("revoke", true, `a2 revoked delegation (tx=${revokeTx.slice(0, 14)}…)`);

  // Wait for Ponder to index revocation
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".delegation_event WHERE kind = 'revoke'`,
      [], (r) => Number(r[0]?.cnt) >= 1, 30_000,
    );
    log("revoke-indexed", true, `Revocation indexed`);
  } catch (e: any) {
    log("revoke-indexed", false, e.message);
  }

  // ──────────────────────────────────────────────
  // PHASE 5: Verify API states (pending_rights for a3)
  // ──────────────────────────────────────────────
  console.log(`\n${BOLD}${YELLOW}PHASE 5${RESET} — API assertions`);

  // a3 is undelegated → should show pending_rights
  await sleep(3_000); // give Ponder a moment

  try {
    const a3Balance = await apiFetch(`/v1/accounts/${a3.addr.toLowerCase()}/balance`);
    const a3IsPending = a3Balance.status === "pending_rights" || a3Balance.status === "no_ciphertext";
    log("pending-rights-a3", a3IsPending,
      `a3 balance status = ${a3Balance.status} (expected pending_rights or no_ciphertext)`);
  } catch (e: any) {
    log("pending-rights-a3", false, e.message);
  }

  // a1 delegated and not revoked → should eventually become decrypted (or pending while worker runs)
  try {
    const a1Balance = await apiFetch(`/v1/accounts/${a1.addr.toLowerCase()}/balance`);
    const a1Valid = ["decrypted", "pending"].includes(a1Balance.status);
    log("a1-balance-status", a1Valid,
      `a1 balance status = ${a1Balance.status} (expected decrypted or pending)`);
  } catch (e: any) {
    log("a1-balance-status", false, e.message);
  }

  // Check delegations endpoint
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

  // Check transfers endpoint for a1
  try {
    const a1Transfers = await apiFetch(`/v1/accounts/${a1.addr.toLowerCase()}/transfers`);
    const hasItems = (a1Transfers.items?.length ?? 0) > 0;
    log("transfers-api-a1", hasItems,
      `a1 has ${a1Transfers.items?.length ?? 0} transfer(s) in API`);
  } catch (e: any) {
    log("transfers-api-a1", false, e.message);
  }

  // Check health endpoint
  try {
    const health = await apiFetch("/v1/health");
    log("health-api", health.status === "ok", `Health: ${JSON.stringify(health)}`);
  } catch (e: any) {
    log("health-api", false, e.message);
  }

  // ──────────────────────────────────────────────
  // PHASE 6: Check decrypt worker (cleartext resolution)
  // ──────────────────────────────────────────────
  console.log(`\n${BOLD}${YELLOW}PHASE 6${RESET} — Decrypt worker cleartext resolution`);

  // Wait for decrypt worker to process a1's handles (cleartext mode → should be fast)
  try {
    const rows = await pollDb(
      `SELECT count(*) AS cnt FROM app.cleartext WHERE status = 'decrypted'`,
      [], (r) => Number(r[0]?.cnt) > 0, 60_000,
    );
    const cnt = Number(rows[0]?.cnt);
    log("cleartext-resolved", cnt > 0, `${cnt} handle(s) decrypted by worker`);
  } catch (e: any) {
    log("cleartext-resolved", false, e.message);
  }

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
