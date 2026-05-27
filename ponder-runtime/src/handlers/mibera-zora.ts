// ponder-runtime/src/handlers/mibera-zora.ts
//
// PORTED FROM: src/handlers/mibera-zora.ts (envio, source-of-truth)
//
// Mibera Zora ERC-1155 tracking.
// Tracks: mints (from zero), transfers (between users).
// Subject: nft.mint.detected.mibera-zora.v1
//
// envio → ponder API translation:
//   - envio: MiberaZora1155.TransferSingle.handler(async ({event, context}) => ...)
//     ponder: ponder.on("MiberaZora1155:TransferSingle", async ({event, context}) => ...)
//   - envio: context.Erc1155MintEvent.set({...}) — entity write
//     ponder: await context.db.insert(erc1155MintEvent).values({...})
//             .onConflictDoUpdate({...})   (mint events are by-id idempotent)
//   - envio: context.Action.set({...}) via recordAction()
//     ponder: await context.db.insert(action).values({...}).onConflictDoNothing()
//   - envio: await publishMintEvent({...}) — fail-soft NATS publish
//     ponder: await reorgSafeEmit(context, buildMintEnvelope("mibera-zora", payload), event, chainId)
//             — gated by isLiveEvent (SDD §4.2 HISTORICAL SYNC GATE)
//
// Event signature (config.mibera.yaml → MiberaZora1155):
//   TransferSingle(address indexed operator, address indexed from,
//                  address indexed to, uint256 id, uint256 value)
//   TransferBatch(address indexed operator, address indexed from,
//                 address indexed to, uint256[] ids, uint256[] values)
//
// CAVEAT: the envio handler was wired against MiberaZora1155 contract on
// Optimism (per envio config). A-1's ponder.config.mibera.ts does NOT include
// MiberaZora1155 (the blue belt is 3 chains: Ethereum/Base/Berachain). So the
// ponder.on registration below will not fire until ponder.config.mibera.ts
// adds the contract — this is OUT OF A-2 SCOPE and explicitly flagged in the
// A-2 dispatch report. The HANDLER LOGIC is ported faithfully so when the
// contract is added (B-1 green belt), this handler is ready.

import { ponder } from "ponder:registry";
import { erc1155MintEvent, action } from "../../ponder.schema";
import { isLiveEvent } from "../lib/sync-status";
import { reorgSafeEmit } from "../lib/reorg-safe-emit";
import { buildMintEnvelope } from "../lib/nats-publisher";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const COLLECTION_KEY = "mibera_zora";

function isMintFromZero(from: string): boolean {
  return from.toLowerCase() === ZERO_ADDRESS;
}

// F-3 re-dispatch: ACTIVE. Contract registered in ponder.config.mibera.ts.

ponder.on("MiberaZora1155:TransferSingle", handleTransferSingle);
ponder.on("MiberaZora1155:TransferBatch",  handleTransferBatch);

export async function handleTransferSingle({ event, context }: any) {
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
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const eventId = `${txHash}_${logIndex}`;
  const blockNumber = event.block.number;

  const isMintEvent = isMintFromZero(fromLower);

  if (isMintEvent) {
    // Erc1155MintEvent.set → insert with onConflictDoUpdate (id is deterministic;
    // reorg-replay safety).
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
        blockNumber,
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
          operator: operatorLower,
          contract: contractAddress,
          from: fromLower,
        }),
      })
      .onConflictDoNothing();

    // SDD §4.2 HISTORICAL SYNC GATE — gate every publish behind isLiveEvent.
    if (await isLiveEvent(event, context)) {
      const envelope = buildMintEnvelope("mibera-zora", {
        chain_id: chainId,
        contract: contractAddress,
        token_id: tokenId.toString(),
        minter: toLower,
        block_number: Number(blockNumber),
        transaction_hash: txHash,
        timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      });
      await reorgSafeEmit(context, envelope, event, chainId);
    }
  } else {
    // Secondary-market transfer1155 action.
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
          from: fromLower,
          to: toLower,
          operator: operatorLower,
          contract: contractAddress,
        }),
      })
      .onConflictDoNothing();
  }
}

export async function handleTransferBatch({ event, context }: any) {
  const { operator, from, to, ids, values } = event.args;
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();

  const contractAddress = event.log.address.toLowerCase();
  const operatorLower = operator.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const blockNumber = event.block.number;

  const idsArray = Array.from(ids as readonly bigint[]);
  const valuesArray = Array.from(values as readonly bigint[]);
  const length = Math.min(idsArray.length, valuesArray.length);

  const isMintEvent = isMintFromZero(fromLower);

  for (let index = 0; index < length; index += 1) {
    const rawId = idsArray[index];
    const rawValue = valuesArray[index];
    if (rawId === undefined || rawValue === undefined || rawValue === null) continue;

    const quantity = BigInt(rawValue.toString());
    if (quantity === 0n) continue;

    const tokenId = BigInt(rawId.toString());
    const eventId = `${txHash}_${logIndex}_${index}`;

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
          blockNumber,
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
            operator: operatorLower,
            contract: contractAddress,
            from: fromLower,
            batchIndex: index,
          }),
        })
        .onConflictDoNothing();

      if (await isLiveEvent(event, context)) {
        const envelope = buildMintEnvelope("mibera-zora", {
          chain_id: chainId,
          contract: contractAddress,
          token_id: tokenId.toString(),
          minter: toLower,
          block_number: Number(blockNumber),
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
            from: fromLower,
            to: toLower,
            operator: operatorLower,
            contract: contractAddress,
            batchIndex: index,
          }),
        })
        .onConflictDoNothing();
    }
  }
}
