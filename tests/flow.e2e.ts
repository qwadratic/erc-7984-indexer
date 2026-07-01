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
 * Prereqs (sepolia):
 *   1. MNEMONIC + SEPOLIA_RPC_URL via psst
 *   2. a0 (idx0) funded with ETH + cWETH, already delegated to INDEXER
 *   3. Ponder + decrypt worker running with CHAIN=sepolia
 *
 * Env:
 *   CHAIN=local | CHAIN=sepolia
 *   TOKEN_ADDRESS, UNDERLYING_ADDRESS, ACL_ADDRESS — from deploy output
 *   INDEXER_PRIVATE_KEY — the indexer's private key
 *   DATABASE_URL — Postgres connection string
 *   MNEMONIC — (Sepolia only) HD wallet mnemonic
 */

import { execSync, exec } from "node:child_process";
import pg from "pg";
import { loadEnvLocal } from "../src/load-env";
import { MAX_UINT64 } from "../src/delegations";

// ── Load .env.local ──
loadEnvLocal();

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
const ACL_ADDRESS = process.env.ACL_ADDRESS ?? (IS_LOCAL
  ? "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D"
  : "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D");

// Env-parameterizable transfer/account counts
// Sepolia default: small (budget!) — 1 transfer per route × 4 routes = 4 total
const TRANSFER_COUNT = Number(process.env.TRANSFER_COUNT ?? (IS_LOCAL ? 2 : 1));
const ACCOUNT_COUNT = Number(process.env.ACCOUNT_COUNT ?? 3);

// ── Account setup (local vs Sepolia) ──
type Acct = { pk: string; addr: string };

// Anvil default accounts (deterministic from mnemonic "test test ... junk")
const ANVIL_ACCOUNTS: Acct[] = [
  { pk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", addr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
  { pk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  { pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", addr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
  { pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", addr: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
  { pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", addr: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" },
];

// Strip CHAIN from env when calling cast — Foundry interprets it as --chain.
const castEnv = { ...process.env };
delete castEnv.CHAIN;

function deriveMnemonicAccount(idx: number): Acct {
  const mnemonic = process.env.MNEMONIC!;
  const pk = execSync(
    `cast wallet private-key --mnemonic "${mnemonic}" --mnemonic-index ${idx}`,
    { encoding: "utf-8", env: castEnv },
  ).trim();
  const addr = execSync(`cast wallet address ${pk}`, { encoding: "utf-8", env: castEnv }).trim();
  return { pk, addr };
}

// Resolve accounts: local uses anvil, Sepolia uses mnemonic
let ACCOUNTS: Acct[];
let INDEXER_ACCT: Acct;
if (IS_LOCAL) {
  ACCOUNTS = ANVIL_ACCOUNTS;
  const ipk = process.env.INDEXER_PRIVATE_KEY!;
  INDEXER_ACCT = {
    pk: ipk,
    addr: execSync(`cast wallet address ${ipk}`, { encoding: "utf-8", env: castEnv }).trim(),
  };
} else {
  // Derive a0–a3 from mnemonic idx 0–3, indexer from idx 9
  ACCOUNTS = [0, 1, 2, 3].map(deriveMnemonicAccount);
  INDEXER_ACCT = deriveMnemonicAccount(9);
}

const INDEXER_PK = INDEXER_ACCT.pk;
const INDEXER_ADDR = INDEXER_ACCT.addr;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

// ── Helpers ──
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const MAX_EXPIRATION = MAX_UINT64.toString();

let passed = 0;
let failed = 0;
function log(phase: string, ok: boolean, detail: string) {
  const icon = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${icon} [${phase}] ${detail}`);
  if (ok) passed++; else failed++;
}

function castSend(to: string, sig: string, args: string[], opts?: { pk?: string; gas?: number; value?: string }): string {
  const pk = opts?.pk ?? ACCOUNTS[0]!.pk;
  const gas = opts?.gas ?? 3_000_000;
  const valuePart = opts?.value ? ` --value ${opts.value}` : "";
  const cmd = `cast send ${to} "${sig}" ${args.join(" ")} --private-key ${pk} --rpc-url ${RPC_URL} --gas-limit ${gas}${valuePart} --json`;
  const timeout = IS_LOCAL ? 30_000 : 120_000;
  const out = execSync(cmd, { encoding: "utf-8", timeout, env: castEnv });
  const json = JSON.parse(out);
  if (json.status !== "0x1" && json.status !== 1) {
    throw new Error(`tx reverted: ${json.transactionHash}`);
  }
  return json.transactionHash;
}

/** Send raw ETH (no calldata). */
function castSendEth(to: string, valueWei: string, opts: { pk: string }): string {
  const cmd = `cast send ${to} --private-key ${opts.pk} --rpc-url ${RPC_URL} --gas-limit 21000 --value ${valueWei} --json`;
  const timeout = IS_LOCAL ? 30_000 : 120_000;
  const out = execSync(cmd, { encoding: "utf-8", timeout, env: castEnv });
  const json = JSON.parse(out);
  if (json.status !== "0x1" && json.status !== 1) {
    throw new Error(`ETH send reverted: ${json.transactionHash}`);
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

// ══════════════════════════════════════════════════════════════════════════
//  Sepolia preflight: budget check (DRY RUN before any tx)
// ══════════════════════════════════════════════════════════════════════════

// Gas LIMITS per-op. On Sepolia, cast send reserves the full --gas-limit from
// the sender's balance, so funding must cover the limit (not just gasUsed).
// CT: SDK auto-estimates (~460k measured), we pad to 500k for funding math.
// Delegate/revoke: measured ~56k, cast send uses --gas-limit 100k on Sepolia.
const GAS_OPS = {
  ethSend: 21_000n,
  confidentialTransfer: 500_000n,
  delegateLimit: 100_000n,
  revokeLimit: 100_000n,
};

async function sepoliaPreflight(accounts: Acct[]): Promise<{
  plan: string[];
  totalEstWei: bigint;
  gasPrice: bigint;
  a0BalWei: bigint;
  ok: boolean;
}> {
  const a0 = accounts[0]!;
  const a1 = accounts[1]!;
  const a2 = accounts[2]!;
  const a3 = accounts[3]!;
  const gasPriceStr = execSync(`cast gas-price --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim();
  const gasPrice = BigInt(gasPriceStr);

  // Fetch balances
  const a0Bal = BigInt(execSync(`cast balance ${a0.addr} --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());
  const a1Bal = BigInt(execSync(`cast balance ${a1.addr} --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());
  const a2Bal = BigInt(execSync(`cast balance ${a2.addr} --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());

  // a1 needs gas for: 2 CTs + 1 delegate (gas limits, not measured gas)
  const a1NeedGas = (2n * GAS_OPS.confidentialTransfer + GAS_OPS.delegateLimit) * gasPrice;
  const a1Fund = a1NeedGas > a1Bal ? a1NeedGas - a1Bal + gasPrice * 100_000n : 0n; // +100k headroom

  // a2 needs gas for: 1 delegate + 1 revoke
  const a2NeedGas = (GAS_OPS.delegateLimit + GAS_OPS.revokeLimit) * gasPrice;
  const a2Fund = a2NeedGas > a2Bal ? a2NeedGas - a2Bal + gasPrice * 50_000n : 0n;

  // a0 spends:
  //   2 ETH sends (fund a1, a2)
  //   2 CTs (a0→a2, a0→a3)
  const a0GasForSelf = (
    2n * GAS_OPS.ethSend +
    2n * GAS_OPS.confidentialTransfer
  ) * gasPrice;
  const a0Total = a0GasForSelf + a1Fund + a2Fund;
  const a0TotalWithHeadroom = a0Total * 130n / 100n; // 30% headroom

  const fmt = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;

  const plan: string[] = [
    `Gas price: ${gasPrice} wei (${(Number(gasPrice) / 1e9).toFixed(2)} gwei)`,
    ``,
    `Balances:`,
    `  a0 (${a0.addr}): ${fmt(a0Bal)}`,
    `  a1 (${a1.addr}): ${fmt(a1Bal)}`,
    `  a2 (${a2.addr}): ${fmt(a2Bal)}`,
    ``,
    `Planned transactions:`,
    `  1. a0 → a1 fund gas: ${fmt(a1Fund)} (ETH send, 21k gas)`,
    `  2. a0 → a2 fund gas: ${fmt(a2Fund)} (ETH send, 21k gas)`,
    `  3. a0 → a2 confidentialTransfer: ~500k gas limit = ${fmt(GAS_OPS.confidentialTransfer * gasPrice)}`,
    `  4. a0 → a3 confidentialTransfer: ~500k gas limit = ${fmt(GAS_OPS.confidentialTransfer * gasPrice)}`,
    `  5. a1 → a2 confidentialTransfer: ~500k gas limit = ${fmt(GAS_OPS.confidentialTransfer * gasPrice)} (from a1 funds)`,
    `  6. a1 → a3 confidentialTransfer: ~500k gas limit = ${fmt(GAS_OPS.confidentialTransfer * gasPrice)} (from a1 funds)`,
    `  7. a1 delegate to INDEXER: 100k gas limit = ${fmt(GAS_OPS.delegateLimit * gasPrice)} (from a1 funds)`,
    `  8. a2 delegate to INDEXER: 100k gas limit = ${fmt(GAS_OPS.delegateLimit * gasPrice)} (from a2 funds)`,
    `  9. a2 revoke delegation: 100k gas limit = ${fmt(GAS_OPS.revokeLimit * gasPrice)} (from a2 funds)`,
    ``,
    `a0 total spend estimate: ${fmt(a0Total)}`,
    `a0 total with 30% headroom: ${fmt(a0TotalWithHeadroom)}`,
    `a0 available: ${fmt(a0Bal)}`,
    `Budget check: ${a0Bal >= a0TotalWithHeadroom ? "✅ PASS" : "❌ FAIL — ABORTING"}`,
  ];

  return {
    plan,
    totalEstWei: a0TotalWithHeadroom,
    gasPrice,
    a0BalWei: a0Bal,
    ok: a0Bal >= a0TotalWithHeadroom,
  };
}

// ── Main ──
async function main() {
  // Ensure automine is on at the start (previous failures may have left it off)
  if (IS_LOCAL) {
    execSync(`cast rpc anvil_setAutomine true --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });
  }

  console.log(`\n${BOLD}═══ Principal-Flow E2E Test (GIVEN / WHEN / THEN) ═══${RESET}`);
  const maskedRpc = RPC_URL.replace(/\/[^/]{10,}$/, '/***');
  console.log(`  CHAIN:      ${process.env.CHAIN}`);
  console.log(`  RPC:        ${maskedRpc}`);
  console.log(`  TOKEN:      ${TOKEN}`);
  console.log(`  UNDERLYING: ${UNDERLYING}`);
  console.log(`  ACL:        ${ACL_ADDRESS}`);
  console.log(`  INDEXER:    ${INDEXER_ADDR}`);
  console.log();

  const a0 = ACCOUNTS[0]!;
  const a1 = ACCOUNTS[1]!;
  const a2 = ACCOUNTS[2]!;
  const a3 = ACCOUNTS[3]!;

  // ══════════════════════════════════════════════════════════════════════════
  //  Sepolia budget preflight (DRY RUN)
  // ══════════════════════════════════════════════════════════════════════════
  if (!IS_LOCAL) {
    console.log(`\n${BOLD}${YELLOW}PREFLIGHT${RESET} — Sepolia budget dry run`);
    const pf = await sepoliaPreflight(ACCOUNTS);
    for (const line of pf.plan) console.log(`  ${line}`);
    if (!pf.ok) {
      console.error(`\n${RED}${BOLD}ABORT: a0 ETH insufficient for plan + 30% headroom.${RESET}`);
      await pool.end();
      process.exit(1);
    }
    console.log();
  }

  const schema = await discoverSchema();
  console.log(`  Ponder schema: ${schema}`);

  // Slice recipients from configured account count (a1, a2, a3 are the default 3)
  const recipients = [a1, a2, a3].slice(0, ACCOUNT_COUNT);

  // ══════════════════════════════════════════════════════════════════════════
  //  GIVEN — Preconditions / state setup
  // ══════════════════════════════════════════════════════════════════════════
  if (IS_LOCAL) {
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
  } else {
    console.log(`\n${BOLD}${YELLOW}GIVEN${RESET} a0 already holds ~7.998 cWETH on Sepolia (reusing; no wrap/mint)`);
    console.log(`  Skipping mint/approve/wrap — a0 cWETH balance already exists.`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Sepolia: fund a1 + a2 with gas ETH from a0
  // ══════════════════════════════════════════════════════════════════════════
  const allTxHashes: { stage: string; hash: string; from: string; to: string }[] = [];

  if (!IS_LOCAL) {
    console.log(`\n${BOLD}${YELLOW}FUND${RESET} a1 + a2 gas from a0`);

    const gasPrice = BigInt(execSync(`cast gas-price --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());

    // a1 needs: 2 CTs + 1 delegate (gas limits), with 50% headroom
    const a1Need = (2n * GAS_OPS.confidentialTransfer + GAS_OPS.delegateLimit) * gasPrice * 150n / 100n;
    const a1Bal = BigInt(execSync(`cast balance ${a1.addr} --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());
    if (a1Bal < a1Need) {
      const sendAmt = a1Need - a1Bal;
      console.log(`  Funding a1 with ${(Number(sendAmt) / 1e18).toFixed(6)} ETH`);
      const h = castSendEth(a1.addr, sendAmt.toString(), { pk: a0.pk });
      allTxHashes.push({ stage: "fund-a1", hash: h, from: a0.addr, to: a1.addr });
      log("fund-a1", true, `tx=${h.slice(0, 14)}…`);
    } else {
      console.log(`  a1 already has enough ETH (${(Number(a1Bal) / 1e18).toFixed(6)})`);
    }

    // a2 needs: 1 delegate + 1 revoke (gas limits), with 50% headroom
    const a2Need = (GAS_OPS.delegateLimit + GAS_OPS.revokeLimit) * gasPrice * 150n / 100n;
    const a2Bal = BigInt(execSync(`cast balance ${a2.addr} --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());
    if (a2Bal < a2Need) {
      const sendAmt = a2Need - a2Bal;
      console.log(`  Funding a2 with ${(Number(sendAmt) / 1e18).toFixed(6)} ETH`);
      const h = castSendEth(a2.addr, sendAmt.toString(), { pk: a0.pk });
      allTxHashes.push({ stage: "fund-a2", hash: h, from: a0.addr, to: a2.addr });
      log("fund-a2", true, `tx=${h.slice(0, 14)}…`);
    } else {
      console.log(`  a2 already has enough ETH (${(Number(a2Bal) / 1e18).toFixed(6)})`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  WHEN — On-chain actions (transfers, delegations, revocation)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${BOLD}${YELLOW}WHEN${RESET}  randomized confidential transfers, 2 delegations (same/adjacent block), and a short-window revoke`);

  // ── SDK setup (local vs Sepolia) ──
  const { ZamaSDK, MemoryStorage } = await import("@zama-fhe/sdk");
  const { createConfig } = await import("@zama-fhe/sdk/viem");
  const { createPublicClient, createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  let makeSdk: (pk: `0x${string}`) => InstanceType<typeof ZamaSDK>;

  if (IS_LOCAL) {
    const { cleartext, hardhat: zamaHardhat } = await import("@zama-fhe/sdk/node");
    const { hardhat: viemHardhat } = await import("viem/chains");
    makeSdk = (pk: `0x${string}`) => {
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
    };
  } else {
    const { node, sepolia: zamaSepolia } = await import("@zama-fhe/sdk/node");
    const { sepolia: viemSepolia } = await import("viem/chains");
    makeSdk = (pk: `0x${string}`) => {
      const account = privateKeyToAccount(pk);
      const publicClient = createPublicClient({ chain: viemSepolia, transport: http(RPC_URL) });
      const walletClient = createWalletClient({ account, chain: viemSepolia, transport: http(RPC_URL) });
      const fheChain = { ...zamaSepolia, network: RPC_URL } as const;
      return new ZamaSDK(
        createConfig({
          chains: [fheChain],
          publicClient: publicClient as any,
          walletClient: walletClient as any,
          storage: new MemoryStorage(),
          relayers: { [fheChain.id]: node() },
        }),
      );
    };
  }

  // ── Confidential Transfers ──
  // Local: all from a0 to each recipient × TRANSFER_COUNT
  // Sepolia: a0→a2, a0→a3, a1→a2, a1→a3 (4 routes, TRANSFER_COUNT each)
  console.log(`\n  Confidential transfers:`);

  type TransferPlan = { senderIdx: number; to: string; amount: number };
  const transferPlan: TransferPlan[] = [];

  if (IS_LOCAL) {
    // Local: a0 sends to all recipients
    for (const r of recipients) {
      for (let i = 0; i < TRANSFER_COUNT; i++) {
        transferPlan.push({ senderIdx: 0, to: r.addr, amount: randomAmount() });
      }
    }
  } else {
    // Sepolia: 4 routes with randomized amounts
    // a0→a2, a0→a3, a1→a2, a1→a3
    for (let i = 0; i < TRANSFER_COUNT; i++) {
      transferPlan.push({ senderIdx: 0, to: a2.addr, amount: randomAmount() });
      transferPlan.push({ senderIdx: 0, to: a3.addr, amount: randomAmount() });
      transferPlan.push({ senderIdx: 1, to: a2.addr, amount: randomAmount() });
      transferPlan.push({ senderIdx: 1, to: a3.addr, amount: randomAmount() });
    }
  }

  // Build SDK instances per sender
  const senderSdks = new Map<number, InstanceType<typeof ZamaSDK>>();
  for (const t of transferPlan) {
    if (!senderSdks.has(t.senderIdx)) {
      senderSdks.set(t.senderIdx, makeSdk(ACCOUNTS[t.senderIdx]!.pk as `0x${string}`));
    }
  }

  const transferTxHashes: string[] = [];
  for (const t of transferPlan) {
    const sender = ACCOUNTS[t.senderIdx]!;
    const sdk = senderSdks.get(t.senderIdx)!;
    const token = sdk.createToken(TOKEN as `0x${string}`);
    console.log(`    Transfer ${t.amount} (${sender.addr.slice(0, 10)}… → ${t.to.slice(0, 10)}…)`);
    try {
      const result = await token.confidentialTransfer(t.to as `0x${string}`, BigInt(t.amount));
      transferTxHashes.push(result.txHash);
      allTxHashes.push({ stage: "transfer", hash: result.txHash, from: sender.addr, to: t.to });
      log("transfer", true, `${t.amount} (${sender.addr.slice(0, 10)}… → ${t.to.slice(0, 10)}…) tx=${result.txHash.slice(0, 14)}…`);
    } catch (e: any) {
      log("transfer", false, `${t.amount} (${sender.addr.slice(0, 10)}… → ${t.to.slice(0, 10)}…) FAILED: ${e.message}`);
    }
  }

  // ── Two delegations (same block on local, concurrent submission on Sepolia) ──
  console.log(`\n  Two delegations (a1 + a2) — ${IS_LOCAL ? "same block" : "concurrent submission"}:`);

  if (IS_LOCAL) {
    // Disable auto-mining so both txs land in the same block
    execSync(`cast rpc anvil_setAutomine false --rpc-url ${RPC_URL}`, { timeout: 5_000, env: castEnv });
  }

  function execAsync(cmd: string, timeout = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: "utf-8", timeout, env: castEnv }, (err, stdout, _stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }

  // Gas limit 100k: measured delegation gas is ~56k, 100k gives comfortable headroom
  // without reserving 500k×gasPrice upfront (which can exceed a1/a2's funded balance)
  const delegateGasLimit = IS_LOCAL ? 500000 : 100000;
  const del1Cmd = `cast send ${ACL_ADDRESS} "delegateForUserDecryption(address,address,uint64)" ${INDEXER_ADDR} ${TOKEN} ${MAX_EXPIRATION} --private-key ${a1.pk} --rpc-url ${RPC_URL} --gas-limit ${delegateGasLimit} --json`;
  const del2Cmd = `cast send ${ACL_ADDRESS} "delegateForUserDecryption(address,address,uint64)" ${INDEXER_ADDR} ${TOKEN} ${MAX_EXPIRATION} --private-key ${a2.pk} --rpc-url ${RPC_URL} --gas-limit ${delegateGasLimit} --json`;

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
  allTxHashes.push({ stage: "delegate-a1", hash: del1Tx, from: a1.addr, to: ACL_ADDRESS });
  allTxHashes.push({ stage: "delegate-a2", hash: del2Tx, from: a2.addr, to: ACL_ADDRESS });

  // Verify block placement
  const del1Receipt = JSON.parse(execSync(`cast receipt ${del1Tx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv }));
  const del2Receipt = JSON.parse(execSync(`cast receipt ${del2Tx} --rpc-url ${RPC_URL} --json`, { encoding: "utf-8", env: castEnv }));
  const sameBlock = del1Receipt.blockNumber === del2Receipt.blockNumber;
  const del1Block = typeof del1Receipt.blockNumber === "string" ? parseInt(del1Receipt.blockNumber, 16) : del1Receipt.blockNumber;
  const del2Block = typeof del2Receipt.blockNumber === "string" ? parseInt(del2Receipt.blockNumber, 16) : del2Receipt.blockNumber;

  if (IS_LOCAL) {
    log("same-block-delegation", sameBlock,
      `Both delegations in block ${del1Block} (same=${sameBlock})`);
  } else {
    // On Sepolia we can't guarantee same block — accept same or adjacent
    const adjacent = Math.abs(del1Block - del2Block) <= 1;
    log("same-or-adjacent-delegation", adjacent,
      `Delegations in blocks ${del1Block} and ${del2Block} (same=${sameBlock}, adjacent=${adjacent})`);
  }

  // Record delegation spike time + baseline decrypted count, so the bandwidth readout
  // below measures THIS run's fresh per-run delta, not cumulative rows from old runs.
  const delegationSpikeTime = Date.now();
  let baselineDecrypted = 0;
  try {
    const { rows } = await pool.query(`SELECT count(*) AS cnt FROM app.cleartext WHERE status = 'decrypted'`);
    baselineDecrypted = Number(rows[0]?.cnt ?? 0);
  } catch {}

  // ── Short-window revocation (a2 revokes 1–3 blocks later) ──
  console.log(`\n  Short-window revoke (a2):`);

  if (IS_LOCAL) {
    const blocksToWait = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < blocksToWait; i++) mineBlock();
    console.log(`    Mined ${blocksToWait} block(s) before revoke`);
  } else {
    // Sepolia ~12s blocks — wait 15s for ~1 block gap
    console.log(`    Waiting ~15s for 1 block gap before revoke…`);
    await sleep(15_000);
  }

  const revokeGasLimit = IS_LOCAL ? 500_000 : 100_000;
  const revokeTx = castSend(
    ACL_ADDRESS,
    "revokeDelegationForUserDecryption(address,address)",
    [INDEXER_ADDR, TOKEN],
    { pk: a2.pk, gas: revokeGasLimit },
  );
  allTxHashes.push({ stage: "revoke-a2", hash: revokeTx, from: a2.addr, to: ACL_ADDRESS });
  log("revoke", true, `a2 revoked delegation (tx=${revokeTx.slice(0, 14)}…)`);

  // ══════════════════════════════════════════════════════════════════════════
  //  THEN — Assertions (log / DB / API / decrypt)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${BOLD}${YELLOW}THEN${RESET}  all events indexed, API correct, worker resolves cleartext`);

  // On Sepolia, Ponder needs more time to sync recent blocks
  const dbPollTimeout = IS_LOCAL ? 30_000 : 180_000;

  // ── DB: transfers indexed ──
  console.log(`\n  Indexed assertions:`);

  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".token_event WHERE kind = 'transfer'`,
      [], (r) => Number(r[0]?.cnt) >= transferTxHashes.length, dbPollTimeout,
    );
    log("transfers-indexed", true, `≥${transferTxHashes.length} transfers indexed`);
  } catch (e: any) {
    log("transfers-indexed", false, e.message);
  }

  // ── DB: delegations indexed ──
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".delegation_event WHERE kind = 'grant'`,
      [], (r) => Number(r[0]?.cnt) >= 2, dbPollTimeout,
    );
    log("delegations-indexed", true, `≥2 delegation grants indexed`);
  } catch (e: any) {
    log("delegations-indexed", false, e.message);
  }

  // ── DB: revocation indexed ──
  try {
    await pollDb(
      `SELECT count(*) AS cnt FROM "${schema}".delegation_event WHERE kind = 'revoke'`,
      [], (r) => Number(r[0]?.cnt) >= 1, dbPollTimeout,
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

  // ── Decrypt worker: cleartext resolution + bandwidth readout ──
  console.log(`\n  Decrypt-worker resolution + bandwidth:`);

  let finalDecrypted = baselineDecrypted;
  const decryptTimeout = IS_LOCAL ? 60_000 : 600_000; // 10 min on Sepolia (real relayer is slow)
  try {
    // Wait for the first fresh handle (past baseline)…
    await pollDb(
      `SELECT count(*) AS cnt FROM app.cleartext WHERE status = 'decrypted'`,
      [], (r) => Number(r[0]?.cnt) > baselineDecrypted, decryptTimeout,
    );
    // …then drain: keep reading until the count stops rising for 8s, so we time full
    // resolution of this run's handles, not just first-handle latency.
    let stableMs = 0;
    while (stableMs < 8_000) {
      await sleep(2_000);
      const { rows } = await pool.query(`SELECT count(*) AS cnt FROM app.cleartext WHERE status = 'decrypted'`);
      const cnt = Number(rows[0]?.cnt ?? 0);
      if (cnt > finalDecrypted) { finalDecrypted = cnt; stableMs = 0; } else { stableMs += 2_000; }
    }
    const delta = finalDecrypted - baselineDecrypted;
    log("cleartext-resolved", delta > 0, `${delta} fresh handle(s) decrypted this run (total ${finalDecrypted})`);
  } catch (e: any) {
    log("cleartext-resolved", false, e.message);
  }

  // Bandwidth readout: fresh per-run delta over wall-time from the delegation spike.
  // 1 euint64 handle = 8 cleartext bytes. This rate is END-TO-END (includes delegation
  // propagation), so treat it as a LOWER bound on raw decrypt bandwidth — the isolated
  // cold/saturation/concurrency curves live in recordings/stress.ts (PHASE A/B/C).
  const BYTES_PER_HANDLE = 8;
  const resolvedDelta = Math.max(0, finalDecrypted - baselineDecrypted);
  const decryptWallSec = (Date.now() - delegationSpikeTime) / 1000;
  const handlesPerSec = decryptWallSec > 0 ? resolvedDelta / decryptWallSec : 0;
  const bytesPerSec = handlesPerSec * BYTES_PER_HANDLE;
  // Break-even: at K handles/transfer (cWETH K=1), transfers/sec = handles/sec / K is the
  // arrival rate that would outpace this worker and grow cleartext debt without bound.
  const K = 1;
  const breakEvenTps = handlesPerSec / K;

  console.log(`\n  ${BOLD}── Decryption Bandwidth Readout ──${RESET}`);
  console.log(`  Fresh handles resolved:    ${resolvedDelta}`);
  console.log(`  Wall-time (spike→drained): ${decryptWallSec.toFixed(1)}s`);
  console.log(`  Bandwidth:                 ${bytesPerSec.toFixed(2)} bytes/sec  (${handlesPerSec.toFixed(4)} handles/sec)`);
  console.log(`  Break-even (cWETH K=1):    ~${breakEvenTps.toFixed(2)} transfers/sec before debt grows`);
  console.log(`  Transfer count:            ${transferTxHashes.length}`);

  // ── Sepolia: check a3 pending_rights in DB ──
  if (!IS_LOCAL) {
    console.log(`\n  Pending-rights DB check:`);
    try {
      const { rows } = await pool.query(
        `SELECT count(*) AS cnt FROM "${schema}".token_event
         WHERE (from_addr = $1 OR to_addr = $1) AND kind = 'transfer'`,
        [a3.addr.toLowerCase()],
      );
      const a3HasTransfers = Number(rows[0]?.cnt) > 0;
      log("a3-has-transfers", a3HasTransfers, `a3 has ${rows[0]?.cnt} transfer events (should have some, but no delegation)`);
    } catch (e: any) {
      log("a3-has-transfers", false, e.message);
    }
  }

  // ── Record all tx hashes ──
  console.log(`\n  ${BOLD}── All Transaction Hashes ──${RESET}`);
  for (const tx of allTxHashes) {
    console.log(`  [${tx.stage}] ${tx.hash} (${tx.from.slice(0, 10)}… → ${tx.to.slice(0, 10)}…)`);
  }

  // ── Sepolia: record final a0 balance ──
  if (!IS_LOCAL) {
    const a0BalAfter = BigInt(execSync(`cast balance ${a0.addr} --rpc-url ${RPC_URL}`, { encoding: "utf-8", env: castEnv }).trim());
    console.log(`\n  a0 ETH after: ${(Number(a0BalAfter) / 1e18).toFixed(6)} ETH`);
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
