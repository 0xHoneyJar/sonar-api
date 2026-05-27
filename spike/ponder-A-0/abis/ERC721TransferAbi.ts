// Minimal ERC-721 Transfer ABI — used by A-0 verification spike
// Mirrors the cluster's chain-1 contracts (HoneyJar, Honeycomb, MiladyCollection)
// Reference: freeside-sonar/config.yaml (event signature)
export const ERC721TransferAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { type: "address", name: "from", indexed: true },
      { type: "address", name: "to", indexed: true },
      { type: "uint256", name: "tokenId", indexed: true },
    ],
    anonymous: false,
  },
] as const;
