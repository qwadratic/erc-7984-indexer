import { createConfig } from "ponder";
import { ERC7984ERC20WrapperABI } from "./abis/ERC7984ERC20Wrapper";
import { ERC20ABI } from "./abis/ERC20";
import { ACLABI } from "./abis/ACL";
import { TOKEN, UNDERLYING, ACL, INDEXER_ADDRESS, isLocal, CHAIN_ID, RPC_URL } from "./src/config";

// Per-contract start blocks — all env-driven.
// Local always starts from block 0 (anvil genesis) regardless of .env.local's Sepolia START_BLOCK.
const START_BLOCK = isLocal ? 0 : Number(process.env.START_BLOCK ?? 0);
// Underlying may have been deployed earlier or at the same block as the wrapper.
const UNDERLYING_START_BLOCK = isLocal ? 0 : Number(process.env.UNDERLYING_START_BLOCK ?? START_BLOCK);
// ACL is network-wide busy; we only care about delegations to OUR indexer, which
// are recent. A later ACL start + an indexed-arg filter keeps backfill cheap.
const ACL_START_BLOCK = isLocal ? 0 : Number(process.env.ACL_START_BLOCK ?? START_BLOCK);

// Chain name used as Ponder key — must be stable per chainId.
const CHAIN_NAME = isLocal ? "local" : "sepolia";

export default createConfig({
  database: {
    kind: "postgres" as const,
    connectionString: process.env.DATABASE_URL!,
  },
  chains: {
    [CHAIN_NAME]: {
      id: CHAIN_ID,
      rpc: RPC_URL,
      // Throttle below the RPC's limit so backfill is steady instead of bursting
      // into 429s + provider-inactive backoff. Local anvil is unlimited.
      maxRequestsPerSecond: isLocal ? 100 : Number(process.env.MAX_RPS ?? 5),
    },
  },
  contracts: {
    ERC7984ERC20Wrapper: {
      chain: CHAIN_NAME,
      abi: ERC7984ERC20WrapperABI,
      address: TOKEN,
      startBlock: START_BLOCK,
    },
    Underlying: {
      chain: CHAIN_NAME,
      abi: ERC20ABI,
      address: UNDERLYING,
      startBlock: UNDERLYING_START_BLOCK,
      // Only transfers INTO the wrapper are wraps — filter by indexed `to`
      // so the RPC returns only wrap-relevant logs across full history.
      filter: { event: "Transfer", args: { to: TOKEN } },
    },
    ACL: {
      chain: CHAIN_NAME,
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
