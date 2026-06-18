import { ZERO_ADDRESS } from "../handlers/constants";
import type {
  EvmOnEventContext,
  Holder,
  Token,
  Transfer,
  CollectionStat,
} from "envio";

export interface Erc721TransferEventLike {
  readonly params: {
    readonly from: string;
    readonly to: string;
    readonly tokenId: bigint;
  };
  readonly srcAddress: string;
  readonly transaction: { readonly hash: string };
  readonly block: { readonly timestamp: number; readonly number: number };
  readonly logIndex: number;
  readonly chainId: number;
}

export async function processErc721Transfer({
  event,
  context,
  collectionAddress,
}: {
  event: Erc721TransferEventLike;
  context: EvmOnEventContext;
  collectionAddress?: string;
}) {
  const { params, srcAddress, transaction, block, logIndex, chainId } = event;
  const from = params.from.toLowerCase();
  const to = params.to.toLowerCase();
  const tokenId = params.tokenId;
  const collection = (collectionAddress ?? srcAddress).toLowerCase();
  const zero = ZERO_ADDRESS.toLowerCase();
  const timestamp = BigInt(block.timestamp);

  const transferId = `${transaction.hash}_${logIndex}`;
  const transfer: Transfer = {
    id: transferId,
    tokenId,
    from,
    to,
    timestamp,
    blockNumber: BigInt(block.number),
    transactionHash: transaction.hash,
    collection,
    chainId,
  };
  context.Transfer.set(transfer);

  const tokenKey = `${collection}_${chainId}_${tokenId}`;
  const existingToken = await context.Token.get(tokenKey);
  const updatedToken: Token = existingToken
    ? {
        ...existingToken,
        owner: to,
        isBurned: to === zero,
        lastTransferTime: timestamp,
      }
    : {
        id: tokenKey,
        collection,
        chainId,
        tokenId,
        owner: to,
        isBurned: to === zero,
        mintedAt: from === zero ? timestamp : BigInt(0),
        lastTransferTime: timestamp,
      };
  context.Token.set(updatedToken);

  const fromHolderId = `${collection}_${chainId}_${from}`;
  const toHolderId = `${collection}_${chainId}_${to}`;
  const fromHolderBefore = from === zero ? undefined : await context.Holder.get(fromHolderId);
  const toHolderBefore = to === zero ? undefined : await context.Holder.get(toHolderId);

  await updateHolder(
    context,
    collection,
    chainId,
    from,
    -1,
    timestamp,
    false,
    zero,
    fromHolderBefore
  );
  await updateHolder(
    context,
    collection,
    chainId,
    to,
    +1,
    timestamp,
    from === zero,
    zero,
    toHolderBefore
  );

  await updateCollectionStats({
    context,
    collection,
    chainId,
    from,
    to,
    timestamp,
    zero,
    fromHolderBefore,
    toHolderBefore,
  });
}

async function updateHolder(
  context: EvmOnEventContext,
  collection: string,
  chainId: number,
  address: string,
  delta: number,
  timestamp: bigint,
  isMint: boolean,
  zero: string,
  existingOverride?: Holder | undefined,
) {
  if (address === zero) return;

  const holderId = `${collection}_${chainId}_${address}`;
  const existing = existingOverride ?? (await context.Holder.get(holderId));

  const balance = Math.max(0, (existing?.balance ?? 0) + delta);
  const baseMinted = existing?.totalMinted ?? 0;
  const totalMinted = isMint ? baseMinted + 1 : baseMinted;
  const firstMintTime = existing?.firstMintTime ?? (isMint ? timestamp : undefined);

  const holder: Holder = {
    id: holderId,
    address,
    balance,
    totalMinted,
    lastActivityTime: timestamp,
    firstMintTime,
    collection,
    chainId,
  };

  context.Holder.set(holder);
}

async function updateCollectionStats({
  context,
  collection,
  chainId,
  from,
  to,
  timestamp,
  zero,
  fromHolderBefore,
  toHolderBefore,
}: {
  context: EvmOnEventContext;
  collection: string;
  chainId: number;
  from: string;
  to: string;
  timestamp: bigint;
  zero: string;
  fromHolderBefore?: Holder;
  toHolderBefore?: Holder;
}) {
  const statsId = `${collection}_${chainId}`;
  const existing = await context.CollectionStat.get(statsId);

  const totalSupply = existing?.totalSupply ?? 0;
  const totalMinted = existing?.totalMinted ?? 0;
  const totalBurned = existing?.totalBurned ?? 0;
  const uniqueHolders = existing?.uniqueHolders ?? 0;
  const lastMintTime = existing?.lastMintTime;

  let newTotalSupply = totalSupply;
  let newTotalMinted = totalMinted;
  let newTotalBurned = totalBurned;
  let newLastMintTime = lastMintTime;
  let uniqueAdjustment = 0;

  if (from === zero) {
    newTotalSupply += 1;
    newTotalMinted += 1;
    newLastMintTime = timestamp;
  } else if (to === zero) {
    newTotalSupply = Math.max(0, newTotalSupply - 1);
    newTotalBurned += 1;
  }

  if (to !== zero) {
    const hadBalanceBefore = (toHolderBefore?.balance ?? 0) > 0;
    if (!hadBalanceBefore) {
      uniqueAdjustment += 1;
    }
  }

  if (from !== zero) {
    const balanceBefore = fromHolderBefore?.balance ?? 0;
    if (balanceBefore === 1) {
      uniqueAdjustment -= 1;
    }
  }

  const stats: CollectionStat = {
    id: statsId,
    collection,
    totalSupply: Math.max(0, newTotalSupply),
    totalMinted: newTotalMinted,
    totalBurned: newTotalBurned,
    uniqueHolders: Math.max(0, uniqueHolders + uniqueAdjustment),
    lastMintTime: newLastMintTime,
    chainId,
  };

  context.CollectionStat.set(stats);
}
