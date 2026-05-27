// ponder-runtime/src/handlers/mibera-sets.ts
//
// PORTED FROM: src/handlers/mibera-sets.ts (envio, source-of-truth)
// Contract: MiberaSets (ERC-1155 on Optimism / multi-chain compat).
//
// F-3 re-dispatch: ACTIVE. Contract registered in ponder.config.mibera.ts.
// Both TransferSingle and TransferBatch handlers wired.
//
// Subject: nft.mint.detected.mibera-sets.v1
// Mint discriminant: from == 0x0 OR from == distribution wallet (airdrop).
// Token ID classification: 8/9/10/11 = strong set; 12 = super set.

import { ponder } from "ponder:registry";
import { erc1155MintEvent, action } from "../../ponder.schema";
import { isLiveEvent } from "../lib/sync-status";
import { reorgSafeEmit } from "../lib/reorg-safe-emit";
import { buildMintEnvelope } from "../lib/nats-publisher";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Verbatim from envio src/handlers/mibera-sets.ts:21
const DISTRIBUTION_WALLET = "0x4a8c9a29b23c4eac0d235729d5e0d035258cdfa7";
const AIRDROP_WALLETS = new Set<string>([DISTRIBUTION_WALLET]);
const COLLECTION_KEY = "mibera_sets";
const STRONG_SET_TOKEN_IDS = new Set<bigint>([8n, 9n, 10n, 11n]);
const SUPER_SET_TOKEN_ID = 12n;

// Marketplace list — verbatim from envio src/handlers/marketplaces/constants.ts.
// We only need the membership check (boolean), not the categorization.
const MARKETPLACE_ADDRESSES = new Set<string>([
  // Seaport / OpenSea
  "0x00000000006c3852cbef3e08e8df289169ede581",
  "0x00000000000001ad428e4906ae43d8f9852d0dd6",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
  "0x0000000000000068f116a894984e2db1123eb395",
  "0x1e0049783f008a0085193e00003d00cd54003c71",
  // Blur
  "0x000000000000ad05ccc4f10045630fb830b95127",
  "0x39da41747a83aee658334415666f3ef92dd0d541",
  "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5",
  "0x29469395eaf6f95920e59f858042f0e28d98a20b",
  // LooksRare
  "0x59728544b08ab483533076417fbbb2fd0b17ce3a",
  "0x0000000000e655fae4d56241588680f86e3b2377",
  // X2Y2
  "0x6d7812d41a08bc2a910b562d8b56411964a4ed88",
  "0x74312363e45dcaba76c59ec49a7aa8a65a67eed3",
  // Rarible
  "0xcd4ec7b66fbc029c116ba9ffb3e59351c20b5b06",
  "0x9757f2d2b135150bbeb65308d4a91804107cd8d6",
  // Foundation
  "0xcda72070e455bb31c7690a170224ce43623d0b6f",
  // SuperRare
  "0x65b49f7aee40347f5a90b714be4ef086f3fe5e2c",
  "0x8c9f364bf7a56ed058fc63ef81c6cf09c833e656",
  // Zora
  "0x76744367ae5a056381868f716bdf0b13ae1aeaa3",
  "0x6170b3c3a54c3d8c854934cbc314ed479b2b29a3",
  // NFTX
  "0x0fc584529a2aefa997697fafacba5831fac0c22d",
  // Sudoswap
  "0x2b2e8cda09bba9660dca5cb6233787738ad68329",
  "0xa020d57ab0448ef74115c112d18a9c231cc86000",
  // Gem / Genie
  "0x83c8f28c26bf6aaca652df1dbbe0e1b56f8baba2",
  "0x0000000035634b55f3d99b071b5a354f48e10bef",
  "0x0a267cf51ef038fc00e71801f5a524aec06e4f07",
]);

function isMintOrAirdrop(from: string): boolean {
  const lower = from.toLowerCase();
  return lower === ZERO_ADDRESS || AIRDROP_WALLETS.has(lower);
}

function isMarketplaceAddress(addr: string): boolean {
  return MARKETPLACE_ADDRESSES.has(addr.toLowerCase());
}

function getSetTier(tokenId: bigint): string {
  if (STRONG_SET_TOKEN_IDS.has(tokenId)) return "strong";
  if (tokenId === SUPER_SET_TOKEN_ID) return "super";
  return "unknown";
}

// ────────────────────────────────────────────────────────────────────────────
// TransferSingle
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaSets:TransferSingle", async ({ event, context }) => {
  const { operator, from, to, id, value } = event.args;
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const tokenId = BigInt(id.toString());
  const quantity = BigInt(value.toString());
  if (quantity === 0n) return;

  const contractAddress = event.log.address.toLowerCase();
  const operatorLower = operator.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const eventId = `${event.transaction.hash}_${event.log.logIndex}`;
  const setTier = getSetTier(tokenId);
  const isMintEvent = isMintOrAirdrop(fromLower);

  if (isMintEvent) {
    await context.db
      .insert(erc1155MintEvent)
      .values({
        id: eventId,
        collectionKey: COLLECTION_KEY,
        tokenId,
        value: quantity,
        minter: toLower as `0x${string}`,
        operator: operatorLower as `0x${string}`,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash as `0x${string}`,
        chainId,
      })
      .onConflictDoNothing();

    await context.db
      .insert(action)
      .values({
        id: eventId,
        actionType: "mint1155",
        actor: toLower as `0x${string}`,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash as `0x${string}`,
        numeric1: quantity,
        numeric2: tokenId,
        context: JSON.stringify({
          tokenId: tokenId.toString(),
          setTier,
          operator: operatorLower,
          contract: contractAddress,
          from: fromLower,
        }),
      })
      .onConflictDoNothing();

    if (await isLiveEvent(event, context as any)) {
      const envelope = buildMintEnvelope("mibera-sets", {
        chain_id: chainId,
        contract: contractAddress,
        token_id: tokenId.toString(),
        minter: toLower,
        block_number: Number(event.block.number),
        transaction_hash: event.transaction.hash,
        timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      });
      await reorgSafeEmit(context, envelope, event, chainId);
    }
  } else {
    await context.db
      .insert(action)
      .values({
        id: eventId,
        actionType: "transfer1155",
        actor: toLower as `0x${string}`,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash as `0x${string}`,
        numeric1: quantity,
        numeric2: tokenId,
        context: JSON.stringify({
          tokenId: tokenId.toString(),
          setTier,
          from: fromLower,
          to: toLower,
          operator: operatorLower,
          contract: contractAddress,
          isSecondary: true,
          viaMarketplace: isMarketplaceAddress(operatorLower),
        }),
      })
      .onConflictDoNothing();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// TransferBatch — full port (per F-3 brief: expand from envio source).
//
// Identical to TransferSingle but iterates ids/values in lockstep. eventId
// suffix is `_${index}` to keep batch entries unique within the same log.
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaSets:TransferBatch", async ({ event, context }) => {
  const { operator, from, to, ids, values } = event.args;
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const contractAddress = event.log.address.toLowerCase();
  const operatorLower = operator.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  const idsArray = Array.from(ids);
  const valuesArray = Array.from(values);
  const length = Math.min(idsArray.length, valuesArray.length);
  const isMintEvent = isMintOrAirdrop(fromLower);

  for (let index = 0; index < length; index += 1) {
    const rawId = idsArray[index];
    const rawValue = valuesArray[index];
    if (rawId === undefined || rawValue === undefined || rawValue === null) continue;

    const quantity = BigInt(rawValue.toString());
    if (quantity === 0n) continue;

    const tokenId = BigInt(rawId.toString());
    const eventId = `${txHash}_${logIndex}_${index}`;
    const setTier = getSetTier(tokenId);

    if (isMintEvent) {
      await context.db
        .insert(erc1155MintEvent)
        .values({
          id: eventId,
          collectionKey: COLLECTION_KEY,
          tokenId,
          value: quantity,
          minter: toLower as `0x${string}`,
          operator: operatorLower as `0x${string}`,
          timestamp,
          blockNumber: event.block.number,
          transactionHash: txHash as `0x${string}`,
          chainId,
        })
        .onConflictDoNothing();

      await context.db
        .insert(action)
        .values({
          id: eventId,
          actionType: "mint1155",
          actor: toLower as `0x${string}`,
          primaryCollection: COLLECTION_KEY,
          timestamp,
          chainId,
          txHash: txHash as `0x${string}`,
          numeric1: quantity,
          numeric2: tokenId,
          context: JSON.stringify({
            tokenId: tokenId.toString(),
            setTier,
            operator: operatorLower,
            contract: contractAddress,
            from: fromLower,
            batchIndex: index,
          }),
        })
        .onConflictDoNothing();

      if (await isLiveEvent(event, context as any)) {
        const envelope = buildMintEnvelope("mibera-sets", {
          chain_id: chainId,
          contract: contractAddress,
          token_id: tokenId.toString(),
          minter: toLower,
          block_number: Number(event.block.number),
          transaction_hash: txHash,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        });
        await reorgSafeEmit(context, envelope, event, chainId);
      }
    } else {
      await context.db
        .insert(action)
        .values({
          id: eventId,
          actionType: "transfer1155",
          actor: toLower as `0x${string}`,
          primaryCollection: COLLECTION_KEY,
          timestamp,
          chainId,
          txHash: txHash as `0x${string}`,
          numeric1: quantity,
          numeric2: tokenId,
          context: JSON.stringify({
            tokenId: tokenId.toString(),
            setTier,
            from: fromLower,
            to: toLower,
            operator: operatorLower,
            contract: contractAddress,
            batchIndex: index,
            isSecondary: true,
            viaMarketplace: isMarketplaceAddress(operatorLower),
          }),
        })
        .onConflictDoNothing();
    }
  }
});
