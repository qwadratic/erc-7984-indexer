import { type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const TOKEN: Address = (process.env.TOKEN_ADDRESS ?? "0x0").toLowerCase() as Address;
export const UNDERLYING: Address = (process.env.UNDERLYING_ADDRESS ?? "0x0").toLowerCase() as Address;
export const ACL: Address = (process.env.ACL_ADDRESS ?? "0x0").toLowerCase() as Address;
export const INDEXER_ADDRESS: Address = privateKeyToAccount(
  process.env.INDEXER_PRIVATE_KEY! as `0x${string}`,
).address.toLowerCase() as Address;
