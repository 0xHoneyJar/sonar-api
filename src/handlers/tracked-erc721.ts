import {
  indexer,
  type EvmOnEventContext,
  type TrackedHolder as TrackedHolderEntity,
} from "envio";

import { eventIdentity, recordAction } from "../lib/actions";
import { ZERO_ADDRESS, isBurnAddress } from "../lib/mint-detection";
import { erc721CollectionKeys, isCustodialAddress } from "../registry/contracts";
import { writeTokenOwnership } from "../lib/token-ownership";

const ZERO = ZERO_ADDRESS.toLowerCase();

/** contract address → collection key, from THE registry. */
const COLLECTION_KEYS: Record<string, string> = erc721CollectionKeys();

/** Structural shape of the TrackedErc721 Transfer event. */
type TrackedErc721TransferEvent = {
  srcAddress: string;
  chainId: number;
  logIndex: number | bigint;
  params: { from: string; to: string; tokenId: bigint };
  transaction: { hash: string; transactionIndex?: number | bigint };
  block: { timestamp: number | bigint; number: number | bigint };
};

/** The ERC-721 holder path. One handler, one binding, every chain. */
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
  const { txHash, logIndex, timestamp, blockNumber, transactionIndex } =
    eventIdentity(event);

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

  // On a withdrawal the pre-transfer effective owner must be read BEFORE
  // updateTokenOwnership overwrites it — it decides below whether the token is
  // returning to its depositor or changed hands inside custody.
  const preWithdrawOwner = withdrawFromCustody
    ? (await context.Token.get(`${contractAddress}_${chainId}_${tokenId}`))?.owner?.toLowerCase()
    : undefined;

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
      blockNumber,
      transactionIndex,
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
      blockNumber,
      transactionIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
        burnAddress: to,
      },
    });
  }

  // Every bound collection, no allowlist: indexer.onEvent only delivers events
  // for addresses bound in config.yaml, so arrival already proves the collection
  // is tracked. A hand-maintained allowlist here once drifted from the config and
  // emitted transfer history for 1 of 9 bound collections on chain 1.
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
      blockNumber,
      transactionIndex,
      numeric1: BigInt(tokenId.toString()),
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
        from,
        to,
        isSecondary: true,
        // No `viaMarketplace` flag here, deliberately. Approval-based venues
        // (Seaport, Element) never take custody, so the marketplace appears in
        // neither `from` nor `to` — inferring a sale from them scored ~29%
        // precision on 409 sampled chain-1 transfers, mostly misreading Blur
        // Blend loan collateral as sales. The sale signal lives on
        // MintActivity{SALE}, joined on (chainId, txHash, contract, tokenId).
        // No matching SALE row means UNKNOWN, not "not a sale".
      },
    });
  }

  // Custody move — usually leave both counts alone. Decrementing the depositor
  // would strip credit for an NFT they still own, and incrementing the vault
  // would make it the collection's top "holder" (462 staked Mibera on
  // 2026-07-28).
  //
  // EXCEPT: a withdrawal to someone other than the recorded effective owner
  // means the token changed hands INSIDE custody (paddlefi trades/liquidations
  // do this). Skipping that too leaves the old owner with phantom credit and
  // the receiver with none — and the receiver's next sale decrements a row
  // that doesn't exist while the buyer's increment lands, inflating the total.
  // Measured 2026-08-06 on a full sync: TrackedHolder summed 10,057 against
  // mibera's on-chain totalSupply of 10,000. Token.owner is the source of
  // truth (it was exact on the same sync), so move the credit when they
  // disagree.
  if (depositToCustody || withdrawFromCustody) {
    if (
      withdrawFromCustody &&
      preWithdrawOwner &&
      preWithdrawOwner !== to &&
      preWithdrawOwner !== ZERO
    ) {
      await adjustHolder({
        context,
        contractAddress,
        collectionKey,
        chainId,
        holderAddress: preWithdrawOwner,
        delta: -1,
        txHash,
        logIndex,
        timestamp,
        blockNumber,
        transactionIndex,
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
        blockNumber,
        transactionIndex,
        direction: "in",
      });
    }
    return;
  }

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
    blockNumber,
    transactionIndex,
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
    blockNumber,
    transactionIndex,
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
  blockNumber: bigint;
  transactionIndex: number | undefined;
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
  blockNumber,
  transactionIndex,
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
    blockNumber,
    transactionIndex,
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
 * Maintain the per-token current-owner record. Keyed
 * `${contract}_${chainId}_${tokenId}`; burns set owner=ZERO and isBurned=true.
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

