export const ACLABI = [
  {
    type: "event",
    name: "DelegatedForUserDecryption",
    inputs: [
      { name: "delegator", type: "address", indexed: true },
      { name: "delegate", type: "address", indexed: true },
      { name: "contractAddress", type: "address", indexed: false },
      { name: "delegationCounter", type: "uint64", indexed: false },
      { name: "oldExpirationDate", type: "uint64", indexed: false },
      { name: "newExpirationDate", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RevokedDelegationForUserDecryption",
    inputs: [
      { name: "delegator", type: "address", indexed: true },
      { name: "delegate", type: "address", indexed: true },
      { name: "contractAddress", type: "address", indexed: false },
      { name: "delegationCounter", type: "uint64", indexed: false },
      { name: "oldExpirationDate", type: "uint64", indexed: false },
    ],
  },
] as const;
