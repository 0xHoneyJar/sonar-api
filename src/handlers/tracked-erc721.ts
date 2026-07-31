import {
  indexer,
  type EvmOnEventContext,
  type TrackedHolder as TrackedHolderEntity,
} from "envio";

import { recordAction } from "../lib/actions";
import { ZERO_ADDRESS, isBurnAddress, isMintFromZero } from "../lib/mint-detection";
import { erc721CollectionKeys, isCustodialAddress } from "../registry/contracts";
import { writeTokenOwnership } from "../lib/token-ownership";

const ZERO = ZERO_ADDRESS.toLowerCase();

/*
 * contract address → collection key, derived from THE registry. The hardcoded
 * map this replaced held 28 addresses while config.yaml bound 51, so 23
 * collections indexed holders under their raw address. One declaration site now,
 * held to config.yaml by test/contract-registry.test.ts.
 */
const COLLECTION_KEYS: Record<string, string> = erc721CollectionKeys();

/** Structural shape of the TrackedErc721 Transfer event. */
type TrackedErc721TransferEvent = {
  srcAddress: string;
  chainId: number;
  logIndex: number | bigint;
  params: { from: string; to: string; tokenId: bigint };
  transaction: { hash: string };
  block: { timestamp: number | bigint; number: number | bigint };
};

/**
 * The ERC-721 holder path. One handler, one binding, every chain.
 *
 * The former dedicated `EthTrackedErc721` binding was removed at bd-dwq5.3: it
 * was a workaround for a supposed envio "single-address fetch gap" on chain 1
 * that turned out to be a corrupted Azuki address in the config, not an envio
 * defect. Chain 1 now binds 23 addresses under TrackedErc721 like every other
 * chain.
 */
export async function handleTrackedErc721Transfer(
  event: TrackedErc721TransferEvent,
  context: EvmOnEventContext,
): Promise<void> {
  const contractAddress = event.srcAddress.toLowerCase();
  const collectionKey =
    COLLECTION_KEYS[contractAddress] ?? contractAddress;
  const from = event.params.from.toLowerCase();
  const to = event.params.to.toLowerCase();
  const tokenId = event.params.tokenId;
  const chainId = event.chainId;
  const txHash = event.transaction.hash;
  const logIndex = Number(event.logIndex);
  const timestamp = BigInt(event.block.timestamp);

  // Preload: prime holder reads for from and to
  if (from !== ZERO && to !== ZERO) {
    const fromId = `${contractAddress}_${chainId}_${from}`;
    const toId = `${contractAddress}_${chainId}_${to}`;
    await Promise.all([
      context.TrackedHolder.get(fromId),
      context.TrackedHolder.get(toId),
    ]);
  }

  // Skip writes during preload
  if ((context as any).isPreload) return;

  // Custody, not ownership: a transfer into a staking vault leaves the depositor
  // as the real holder, and the withdrawal back out returns a token they never
  // stopped holding. Both sides are read off the registry's `custodial` field —
  // no address literals and no per-community branch here.
  const depositToCustody = isCustodialAddress(chainId, to) && from !== ZERO;
  const withdrawFromCustody = isCustodialAddress(chainId, from) && to !== ZERO;

  // Per-token current ownership (Token entity) — FR-2 / #153 (ported from
  // cycle/sonar-belt-factory e58a51c). Mirrors the TrackedHolder count below
  // so Token{owner} reconciles with TrackedHolder.tokenCount (EVANS I-3): on a
  // custody deposit the holder count is not decremented, so the effective owner
  // must stay `from`. On burn (to a burn address) owner=ZERO + isBurned=true.
  await updateTokenOwnership({
    context,
    contractAddress,
    chainId,
    tokenId,
    from,
    to: depositToCustody ? from : to,
    timestamp,
  });

  // If this is a mint (from zero address), also create a mint action
  if (from === ZERO) {
    const mintActionId = `${txHash}_${logIndex}`;
    recordAction(context, {
      id: mintActionId,
      actionType: "mint",
      actor: to,
      primaryCollection: collectionKey.toLowerCase(),
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
      },
    });
  }

  // If this is a burn (to zero or dead address), create a burn action
  if (isBurnAddress(to) && from !== ZERO) {
    const burnActionId = `${txHash}_${logIndex}_burn`;
    recordAction(context, {
      id: burnActionId,
      actionType: "burn",
      actor: from,
      primaryCollection: collectionKey.toLowerCase(),
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
        burnAddress: to,
      },
    });
  }

  // Track transfers for every bound collection (non-mint, non-burn transfers).
  // No collection allowlist: indexer.onEvent only delivers events for addresses
  // bound in config.yaml, so arrival already proves the collection is tracked.
  // The former TRANSFER_TRACKED_COLLECTIONS gate was hand-maintained while
  // Kitchen patches config.yaml automatically, so every onboarded collection
  // indexed holders and emitted no transfer history (bug-20260725-224d57 F1;
  // chain 1 had 9 bound collections and emitted transfers for exactly one).
  if (from !== ZERO && !isBurnAddress(to)) {
    const transferActionId = `${txHash}_${logIndex}_transfer`;
    recordAction(context, {
      id: transferActionId,
      actionType: "transfer",
      actor: to, // Recipient is the actor (they received the NFT)
      primaryCollection: collectionKey.toLowerCase(),
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: BigInt(tokenId.toString()),
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
        from,
        to,
        isSecondary: true,
        // `viaMarketplace` was removed here in bug-20260725-224d57 (F1/T6).
        //
        // It was `isMarketplaceAddress(from) || isMarketplaceAddress(to)`, which
        // cannot work for ERC-721: approval-based venues (Seaport, Element) never
        // take custody, so the marketplace appears in neither `from` nor `to`.
        // Measured on chain 1 (409 sampled Azuki transfers): ~29% precision, ~28%
        // recall. 122 of 172 `true` values were Blur Blend LOAN collateral moves —
        // borrowing against an NFT was reported as selling it. And a `false`
        // asserted "confirmed not a sale", a claim this code could never make.
        //
        // The sale signal now lives on MintActivity{SALE}, joinable on
        // (chainId, txHash, contract, tokenId), carrying `operator` and a priced
        // `amountPaid`. Absence of a matching SALE row means UNKNOWN, not "no sale".
      },
    });
  }

  // Custody move — leave both counts alone. Decrementing the depositor would
  // strip credit for an NFT they still own, and incrementing the vault would
  // make it the collection's top "holder" (462 staked Mibera on 2026-07-28).
  if (depositToCustody || withdrawFromCustody) return;

  // Normal transfer handling
  await adjustHolder({
    context,
    contractAddress,
    collectionKey,
    chainId,
    holderAddress: from,
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
    holderAddress: to,
    delta: 1,
    txHash,
    logIndex,
    timestamp,
    direction: "in",
  });
}

indexer.onEvent(
  { contract: "TrackedErc721", event: "Transfer" },
  ({ event, context }) => handleTrackedErc721Transfer(event, context),
);

interface AdjustHolderArgs {
  context: EvmOnEventContext;
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
  if (delta === 0) {
    return;
  }

  const address = holderAddress.toLowerCase();
  if (address === ZERO) {
    return;
  }

  const id = `${contractAddress}_${chainId}_${address}`;
  const existing = await context.TrackedHolder.get(id);
  const currentCount = existing?.tokenCount ?? 0;
  const nextCount = currentCount + delta;

  const actionId = `${txHash}_${logIndex}_${direction}`;
  const normalizedCollection = collectionKey.toLowerCase();
  const tokenCount = Math.max(0, nextCount);

  recordAction(context, {
    id: actionId,
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

// =============================================================================
// Per-token current ownership (Token entity) — FR-2 / #153
// Ported from cycle/sonar-belt-factory e58a51c (population-only; no reconcile
// baggage). Exported for direct unit testing of the reconciliation invariant.
// =============================================================================

interface UpdateTokenOwnershipArgs {
  context: EvmOnEventContext;
  contractAddress: string;
  chainId: number;
  tokenId: bigint;
  from: string;
  to: string;
  timestamp: bigint;
}

/**
 * Maintain the per-token current-owner record (Token entity) for tracked
 * ERC-721 collections (Tarot + Fractures + lore + apdao_seat). Keyed
 * `${collection}_${chainId}_${tokenId}` to match the canonical Token shape
 * (src/lib/erc721-holders.ts). `collection` is the on-chain contract address
 * (lowercase), matching the TrackedHolder.contract field used downstream.
 * Burns (to a burn address) mark isBurned=true and set owner=ZERO.
 */
export async function updateTokenOwnership({
  context,
  contractAddress,
  chainId,
  tokenId,
  from,
  to,
  timestamp,
}: UpdateTokenOwnershipArgs) {
  await writeTokenOwnership({
    context,
    collection: contractAddress,
    chainId,
    tokenId,
    // `to` is the caller-resolved effective owner: the caller substitutes the
    // depositor on a transfer into a custodial address, so Token{owner} tracks
    // the same wallet TrackedHolder credits (EVANS I-3).
    candidateOwner: to,
    from,
    timestamp,
  });
}

