import { createConfig } from "ponder";
import { ERC7984ERC20WrapperABI } from "./abis/ERC7984ERC20Wrapper";
import { ERC20ABI } from "./abis/ERC20";
import { ACLABI } from "./abis/ACL";
import { TOKEN, UNDERLYING, ACL, INDEXER_ADDRESS } from "./src/config";

// Per-contract start blocks — all env-driven.
const START_BLOCK = Number(process.env.START_BLOCK ?? 0);
// Underlying may have been deployed earlier or at the same block as the wrapper.
const UNDERLYING_START_BLOCK = Number(process.env.UNDERLYING_START_BLOCK ?? START_BLOCK);
// ACL is network-wide busy; we only care about delegations to OUR indexer, which
// are recent. A later ACL start + an indexed-arg filter keeps backfill cheap.
const ACL_START_BLOCK = Number(process.env.ACL_START_BLOCK ?? START_BLOCK);

export default createConfig({
  database: {
    kind: "postgres" as const,
    connectionString: process.env.DATABASE_URL!,
  },
  chains: {
    sepolia: {
      id: 11155111,
      rpc: process.env.PONDER_RPC_URL_11155111!,
      // Throttle below the RPC's limit so backfill is steady instead of bursting
      // into 429s + provider-inactive backoff. Free-tier Alchemy ~7 req/s → use ~5.
      maxRequestsPerSecond: Number(process.env.MAX_RPS ?? 5),
    },
  },
  contracts: {
    ERC7984ERC20Wrapper: {
      chain: "sepolia",
      abi: ERC7984ERC20WrapperABI,
      address: TOKEN,
      startBlock: START_BLOCK,
    },
    Underlying: {
      chain: "sepolia",
      abi: ERC20ABI,
      address: UNDERLYING,
      startBlock: UNDERLYING_START_BLOCK,
      // Only transfers INTO the wrapper are wraps — filter by indexed `to`
      // so the RPC returns only wrap-relevant logs across full history.
      filter: { event: "Transfer", args: { to: TOKEN } },
    },
    ACL: {
      chain: "sepolia",
      abi: ACLABI,
      address: ACL,
      startBlock: ACL_START_BLOCK,
      // Only delegations to OUR indexer — filter by indexed `delegate`.
      filter: [
        { event: "DelegatedForUserDecryption", args: { delegate: INDEXER_ADDRESS } },
        { event: "RevokedDelegationForUserDecryption", args: { delegate: INDEXER_ADDRESS } },
      ],
    },
  },
});
