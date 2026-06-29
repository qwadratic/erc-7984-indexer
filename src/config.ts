import { type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * CHAIN env switch — "local" targets anvil (chainId 31337, cleartext FHE),
 * anything else (default) targets Sepolia (chainId 11155111, real FHE).
 */
export const CHAIN: "local" | "sepolia" =
  (process.env.CHAIN ?? "sepolia").toLowerCase() === "local" ? "local" : "sepolia";
export const isLocal: boolean = CHAIN === "local";

export const CHAIN_ID: number = isLocal ? 31337 : 11155111;

export const TOKEN: Address = (process.env.TOKEN_ADDRESS ?? "0x0").toLowerCase() as Address;
export const UNDERLYING: Address = (process.env.UNDERLYING_ADDRESS ?? "0x0").toLowerCase() as Address;
export const ACL: Address = (process.env.ACL_ADDRESS ?? (isLocal
  ? "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D"
  : "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D"
)).toLowerCase() as Address;
export const INDEXER_ADDRESS: Address = privateKeyToAccount(
  process.env.INDEXER_PRIVATE_KEY! as `0x${string}`,
).address.toLowerCase() as Address;

/** RPC URL — local uses PONDER_RPC_URL_31337, Sepolia uses PONDER_RPC_URL_11155111. */
export const RPC_URL: string = isLocal
  ? (process.env.PONDER_RPC_URL_31337 ?? "http://127.0.0.1:8545")
  : process.env.PONDER_RPC_URL_11155111!;
