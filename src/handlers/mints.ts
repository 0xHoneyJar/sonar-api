/*
 * Generalized ERC721 mint + ownership tracking handler (GeneralMints).
 *
 * Configured contracts: mibera_vm / mibera_shadows (0x0483…) and mibera_gif
 * (0x2309…) on Berachain — see config.yaml / config.mibera.yaml GeneralMints.
 *
 * - On mint (from == zero): stores a normalized MintEvent + mint action
 *   (existing behaviour; downstream consumers + VM trait enrichment depend on it).
 * - On every transfer (mint/burn/transfer): maintains per-token current
 *   ownership (Token entity) and per-holder counts (TrackedHolder) so the
 *   inventory API can answer "which tokenIds of collection C does wallet W own"
 *   and counts reconcile with TrackedHolder.tokenCount (DEP-1).
 *
 * Prior to DEP-1 this handler early-returned on non-mint transfers, so these two
 * collections had no ownership/holder tracking at all.
 */

import { GeneralMints, MintEvent } from "generated";
import type {
  handlerContext,
  Token as TokenEntity,
  TrackedHolder as TrackedHolderEntity,
} from "generated";

import { recordAction } from "../lib/actions";
import { isBurnAddress } from "../lib/mint-detection";

import { ZERO_ADDRESS } from "./constants";
import { MINT_COLLECTION_KEYS } from "./mints/constants";

const ZERO = ZERO_ADDRESS.toLowerCase();

export const handleGeneralMintTransfer = GeneralMints.Transfer.handler(
  async ({ event, context }) => {
    const { from, to, tokenId } = event.params;

    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const contractAddress = event.srcAddress.toLowerCase();
    const collectionKey =
      MINT_COLLECTION_KEYS[contractAddress] ?? contractAddress;

    const id = `${event.transaction.hash}_${event.logIndex}`;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const logIndex = Number(event.logIndex);
    const txHash = event.transaction.hash;
    const normalizedTokenId = BigInt(tokenId.toString());

    // Preload: prime holder reads for from and to
    if (fromLower !== ZERO && toLower !== ZERO) {
      await Promise.all([
        context.TrackedHolder.get(`${contractAddress}_${chainId}_${fromLower}`),
        context.TrackedHolder.get(`${contractAddress}_${chainId}_${toLower}`),
      ]);
    }

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // =========================================================================
    // Per-token current ownership (Token entity) — DEP-1.
    // Burn (to a burn address): owner=ZERO + isBurned=true.
    // =========================================================================
    await updateTokenOwnership({
      context,
      contractAddress,
      chainId,
      tokenId: normalizedTokenId,
      from: fromLower,
      to: toLower,
      timestamp,
    });

    // =========================================================================
    // Per-holder counts (TrackedHolder) — DEP-1.
    // =========================================================================
    await adjustHolder({
      context,
      contractAddress,
      collectionKey,
      chainId,
      holderAddress: fromLower,
      delta: -1,
      txHash,
      logIndex,
      timestamp,
      direction: "out",
    });
    await adjustHolder({
      context,
      contractAddress,
      collectionKey,
      chainId,
      holderAddress: toLower,
      delta: 1,
      txHash,
      logIndex,
      timestamp,
      direction: "in",
    });

    // =========================================================================
    // Mint event + mint action (existing behaviour) — mints only.
    // =========================================================================
    if (fromLower !== ZERO) {
      return; // Not a mint; ownership/counts already handled above.
    }

    const minter = toLower;
    const mintEvent: MintEvent = {
      id,
      collectionKey,
      tokenId: normalizedTokenId,
      minter,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash,
      chainId,
      encodedTraits: undefined, // Will be populated by VM Minted handler if applicable
    };

    context.MintEvent.set(mintEvent);

    recordAction(context, {
      id,
      actionType: "mint",
      actor: minter,
      primaryCollection: collectionKey,
      timestamp,
      chainId,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
      },
    });
  }
);

// =============================================================================
// Per-token current ownership (Token entity) — DEP-1
// =============================================================================

interface UpdateTokenOwnershipArgs {
  context: handlerContext;
  contractAddress: string;
  chainId: number;
  tokenId: bigint;
  from: string;
  to: string;
  timestamp: bigint;
}

/**
 * Maintain the per-token current-owner record (Token entity), keyed
 * `${collection}_${chainId}_${tokenId}` to match the canonical Token shape
 * (src/lib/erc721-holders.ts). `collection` is the on-chain contract address
 * (lowercase). Burns (to a burn address) mark isBurned=true and set owner=ZERO.
 */
async function updateTokenOwnership({
  context,
  contractAddress,
  chainId,
  tokenId,
  from,
  to,
  timestamp,
}: UpdateTokenOwnershipArgs) {
  const burned = isBurnAddress(to);
  const owner = burned ? ZERO : to;

  const tokenKey = `${contractAddress}_${chainId}_${tokenId}`;
  const existing = await context.Token.get(tokenKey);

  const token: TokenEntity = existing
    ? {
        ...existing,
        owner,
        isBurned: burned,
        lastTransferTime: timestamp,
      }
    : {
        id: tokenKey,
        collection: contractAddress,
        chainId,
        tokenId,
        owner,
        isBurned: burned,
        mintedAt: from === ZERO ? timestamp : BigInt(0),
        lastTransferTime: timestamp,
      };

  context.Token.set(token);
}

// =============================================================================
// Per-holder counts (TrackedHolder) — DEP-1
// =============================================================================

interface AdjustHolderArgs {
  context: handlerContext;
  contractAddress: string;
  collectionKey: string;
  chainId: number;
  holderAddress: string;
  delta: number;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
  direction: "in" | "out";
}

/**
 * Maintain per-(collection, chain, wallet) token counts (TrackedHolder),
 * mirroring src/handlers/tracked-erc721.ts adjustHolder. Skips the zero and
 * burn addresses; deletes the holder when its count drops to 0.
 */
async function adjustHolder({
  context,
  contractAddress,
  collectionKey,
  chainId,
  holderAddress,
  delta,
  txHash,
  logIndex,
  timestamp,
  direction,
}: AdjustHolderArgs) {
  if (delta === 0) return;

  const address = holderAddress.toLowerCase();
  if (address === ZERO || isBurnAddress(address)) return;

  const id = `${contractAddress}_${chainId}_${address}`;
  const existing = await context.TrackedHolder.get(id);
  const currentCount = existing?.tokenCount ?? 0;
  const nextCount = currentCount + delta;

  const normalizedCollection = collectionKey.toLowerCase();
  const tokenCount = Math.max(0, nextCount);

  recordAction(context, {
    id: `${txHash}_${logIndex}_${direction}`,
    actionType: "hold721",
    actor: address,
    primaryCollection: normalizedCollection,
    timestamp,
    chainId,
    txHash,
    logIndex,
    numeric1: BigInt(tokenCount),
    context: {
      contract: contractAddress,
      collectionKey: normalizedCollection,
      tokenCount,
      direction,
    },
  });

  if (nextCount <= 0) {
    if (existing) {
      context.TrackedHolder.deleteUnsafe(id);
    }
    return;
  }

  const holder: TrackedHolderEntity = {
    id,
    contract: contractAddress,
    collectionKey,
    chainId,
    address,
    tokenCount: nextCount,
  };

  context.TrackedHolder.set(holder);
}
