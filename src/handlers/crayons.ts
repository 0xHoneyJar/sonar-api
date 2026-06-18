import { indexer, type Transfer } from "envio";

// Skeleton handler for Crayons Factory emits. This records the discovery event.
// Follow-up work will add dynamic tracking of ERC721 Base collection transfers
// and populate Token/Transfer entities for holders/stats.

indexer.onEvent(
  { contract: "CrayonsFactory", event: "Factory__NewERC721Base" },
  async ({ event, context }) => {
    const { owner, erc721Base } = event.params;

    const transfer: Transfer = {
      id: `${event.transaction.hash}_crayons_factory_${erc721Base.toLowerCase()}`,
      tokenId: 0n,
      from: owner.toLowerCase(),
      to: erc721Base.toLowerCase(),
      timestamp: BigInt(event.block.timestamp),
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash.toLowerCase(),
      collection: "crayons_factory",
      chainId: event.chainId,
    };

    context.Transfer.set(transfer);
  }
);

