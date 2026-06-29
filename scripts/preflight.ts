#!/usr/bin/env tsx
/**
 * Preflight ERC-7984 token validation.
 * Checks that TOKEN_ADDRESS supports the ERC-7984 interface (0x4958f2a4)
 * and classifies it as wrapper vs native.
 *
 * Exit 0 = valid, Exit 1 = invalid/error.
 */

import { createPublicClient, http, type Address, getAddress } from "viem";
import { sepolia } from "viem/chains";

const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS as Address | undefined;
if (!TOKEN_ADDRESS) {
  console.error("FATAL: TOKEN_ADDRESS env var is not set.");
  process.exit(1);
}

const addr = getAddress(TOKEN_ADDRESS);

// Determine RPC URL from env (Ponder convention)
const rpcUrl = process.env.PONDER_RPC_URL_11155111 ?? "http://127.0.0.1:8545";

const chain = sepolia;

const client = createPublicClient({
  chain,
  transport: http(rpcUrl),
});

const ERC7984_INTERFACE_ID = "0x4958f2a4" as const;

async function main() {
  console.log(`Preflight: checking ${addr} on ${chain.name} (${rpcUrl.replace(/\/[^/]{10,}$/, "/***")})`);

  // 1. supportsInterface check
  let supported: boolean;
  try {
    supported = (await client.readContract({
      address: addr,
      abi: [
        {
          type: "function",
          name: "supportsInterface",
          inputs: [{ name: "interfaceId", type: "bytes4" }],
          outputs: [{ name: "", type: "bool" }],
          stateMutability: "view",
        },
      ],
      functionName: "supportsInterface",
      args: [ERC7984_INTERFACE_ID],
    })) as boolean;
  } catch {
    console.error(
      `FATAL: ${addr} does not implement supportsInterface or is not a contract. Refusing to index.`
    );
    process.exit(1);
  }

  if (!supported) {
    console.error(
      `FATAL: ${addr} is not an ERC-7984 token (supportsInterface ${ERC7984_INTERFACE_ID} = false). Refusing to index.`
    );
    process.exit(1);
  }

  // 2. Classify wrapper vs native via underlying()
  let kind = "native";
  let underlyingAddr: string | undefined;
  try {
    underlyingAddr = (await client.readContract({
      address: addr,
      abi: [
        {
          type: "function",
          name: "underlying",
          inputs: [],
          outputs: [{ name: "", type: "address" }],
          stateMutability: "view",
        },
      ],
      functionName: "underlying",
    })) as string;
    kind = "wrapper";
  } catch {
    // underlying() reverted → native confidential token
    kind = "native";
  }

  console.log(`✓ ${addr} is a valid ERC-7984 confidential token (kind=${kind})`);
  if (underlyingAddr) {
    console.log(`  underlying = ${underlyingAddr}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Preflight error:", err);
  process.exit(1);
});
