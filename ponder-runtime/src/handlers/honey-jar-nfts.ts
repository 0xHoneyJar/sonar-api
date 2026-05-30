// ponder-runtime/src/handlers/honey-jar-nfts.ts
//
// PORTED FROM: src/handlers/honey-jar-nfts.ts (envio, source-of-truth, 13KB) +
//              src/handlers/crayons.ts (the Crayons factory discovery skeleton).
// Contracts: the HoneyJar collection family across 6 chains —
//   HoneyJar      (ethereum/arbitrum/zora/optimism/base/berachain · multi-addr)
//   HoneyJar2Eth / HoneyJar3Eth / HoneyJar4Eth / HoneyJar5Eth  (ethereum · L0 remints)
//   Honeycomb     (ethereum + berachain)
//   CrayonsFactory (berachain — Factory__NewERC721Base discovery only)
//
// B-1 green-belt (Group B — honeyjar-genesis · the FINAL group · rated L).
// Writes the 6 GENERIC entities (one ponder table each):
//   - transfer         (APPEND;     id = `${txHash}_${logIndex}`)
//   - mint             (APPEND;     id = `${txHash}_${logIndex}_mint`)
//   - token            (ROLLUP-LWW; id = `${collection}_${chainId}_${tokenId}`)
//   - holder           (ROLLUP;     id = `${collection}_${chainId}_${address}`)
//   - user_balance     (ROLLUP;     id = `${generation}_${address}` — CROSS-CHAIN)
//   - collection_stat  (ROLLUP;     id = `${collection}_${chainId}`)
//
// No NATS publish — honey-jar-nfts.ts emits NO events (no pending_emits / no NATS
// path; verified). Therefore NO OutboxFlush / block-tick handler for the two new
// chains (arbitrum / zora): there is nothing to drain. Matches mirror / apdao /
// moneycomb / paddlefi — local indexing only.
//
// ─── API-pivot from envio (verbatim rules — same as moneycomb-vault.ts /
//     fatbera.ts / general-mints.ts) ──────────────────────────────────────────
//   - event.params               → event.args
//   - event.srcAddress           → event.log.address
//   - event.logIndex             → event.log.logIndex
//   - event.chainId              → context.chain.id (ponder per-chain context)
//   - event.block.timestamp      → ALREADY bigint — but envio wrapped it in
//                                    BigInt(event.block.timestamp); ponder decodes
//                                    block.timestamp as bigint already, so the
//                                    BigInt() wrap is dropped (preserving the same
//                                    bigint VALUE the envio handler stored).
//   - event.block.number         → ALREADY bigint (drop envio's BigInt() wrap)
//   - tokenId (uint256 arg)      → ALREADY bigint; envio wrote BigInt(tokenId.toString())
//                                    → here `BigInt(tokenId.toString())` is preserved
//                                    verbatim (a no-op on an already-bigint arg, but
//                                    kept byte-identical to the envio source).
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.set (APPEND)   → context.db.insert(<table>).values(obj).onConflictDoNothing()
//   - context.<E>.set (ROLLUP)   → find → update OR insert (read-modify-write)
//   - context.log.*              → console.* (ponder 0.16.6's indexing context has
//                                    NO .log surface — verified LIVE; bgt.ts:96 /
//                                    moneycomb-vault.ts:32 flagged the same)
//
// ─── THE isPreload ELIMINATION (load-bearing port decision) ──────────────────
// The envio handler does a TWO-PASS `isPreload` dance: it batch-reads fromHolder /
// toHolder via Promise.all to PRIME the preload cache, then `if (context.isPreload)
// return;` before any write; on the real pass it does the writes. Ponder has NO
// preload pass — handlers run ONCE per event, single-pass, in sequential event
// order. So we DROP the preload-return guard AND the redundant pre-batch read
// (it existed only to warm the preload cache). The holders are read INLINE inside
// updateHolderBalances exactly where they are needed, preserving the original
// read-before-write ordering (Holder read → balance mutate → CollectionStat uses
// the pre-mutation balances). NO behavioral change vs the real (non-preload) envio
// pass — we replicate ONLY the write pass.
//
// ─── MILADY EXCLUSION (collision rule) ───────────────────────────────────────
// The envio honey-jar-nfts.ts handler does NOT reference MiladyCollection at all
// (Milady is a SEPARATE envio handler, src/handlers/milady-collection.ts, and
// MiladyCollection is ALREADY registered LIVE in ponder.config.mibera.ts:269 for
// milady-burn tracking). So there is no Milady code path to exclude in THIS file —
// MiladyCollection is simply NOT registered for Group B (re-registering it would
// double-index + collide). milady-collection.ts is NOT ported here.
//
// ─── EXCLUDED dead writes ────────────────────────────────────────────────────
// updateGlobalCollectionStat (envio:451-470) early-returns with NO write (the
// GlobalCollectionStat aggregation was never implemented — "Implementation removed
// due to getMany limitations"). GlobalCollectionStat has 0 writers and is a DEAD
// entity (map line 75). So this handler does NOT call it and does NOT write that
// table. The other unknown-collection guard (`if (generation < 0) return;`) is
// preserved verbatim.

import { ponder } from "ponder:registry";
import {
  transfer,
  mint,
  token,
  holder,
  userBalance,
  collectionStat,
} from "../../ponder.schema";

// ─────────────────────────────────────────────────────────────────────────
// Collection-resolution constants — inlined VERBATIM from the envio
// src/handlers/constants.ts (the ponder tsconfig excludes ../src; prior groups
// inline their constants the same way, e.g. badges1155.ts / general-mints.ts).
// ─────────────────────────────────────────────────────────────────────────
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BERACHAIN_TESTNET_ID = 80094; // envio constant name; 80094 is mainnet (see constants.ts:6-8)

// Address → collection mapping (envio constants.ts:23-49). Lowercased keys.
const ADDRESS_TO_COLLECTION: Record<string, string> = {
  // Ethereum mainnet
  "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d": "HoneyJar1",
  "0x98dc31a9648f04e23e4e36b0456d1951531c2a05": "HoneyJar6",
  "0xcb0477d1af5b8b05795d89d59f4667b59eae9244": "Honeycomb",
  // Ethereum L0 reminted contracts (when bridged from native chains)
  "0x3f4dd25ba6fb6441bfd1a869cbda6a511966456d": "HoneyJar2",
  "0x49f3915a52e137e597d6bf11c73e78c68b082297": "HoneyJar3",
  "0x0b820623485dcfb1c40a70c55755160f6a42186d": "HoneyJar4",
  "0x39eb35a84752b4bd3459083834af1267d276a54c": "HoneyJar5",
  // Arbitrum
  "0x1b2751328f41d1a0b91f3710edcd33e996591b72": "HoneyJar2",
  // Zora
  "0xe798c4d40bc050bc93c7f3b149a0dfe5cfc49fb0": "HoneyJar3",
  // Optimism
  "0xe1d16cc75c9f39a2e0f5131eb39d4b634b23f301": "HoneyJar4",
  // Base
  "0xbad7b49d985bbfd3a22706c447fb625a28f048b4": "HoneyJar5",
  // Berachain
  "0xedc5dfd6f37464cc91bbce572b6fe2c97f1bc7b3": "HoneyJar1",
  "0x1c6c24cac266c791c4ba789c3ec91f04331725bd": "HoneyJar2",
  "0xf1e4a550772fabfc35b28b51eb8d0b6fcd1c4878": "HoneyJar3",
  "0xdb602ab4d6bd71c8d11542a9c8c936877a9a4f45": "HoneyJar4",
  "0x0263728e7f59f315c17d3c180aeade027a375f17": "HoneyJar5",
  "0xb62a9a21d98478f477e134e175fd2003c15cb83a": "HoneyJar6",
  "0x886d2176d899796cd1affa07eff07b9b2b80f1be": "Honeycomb",
};

const COLLECTION_TO_GENERATION: Record<string, number> = {
  HoneyJar1: 1,
  HoneyJar2: 2,
  HoneyJar3: 3,
  HoneyJar4: 4,
  HoneyJar5: 5,
  HoneyJar6: 6,
  Honeycomb: 0,
};

const HOME_CHAIN_IDS: Record<number, number> = {
  1: 1, // Gen 1 - Ethereum
  2: 42161, // Gen 2 - Arbitrum
  3: 7777777, // Gen 3 - Zora
  4: 10, // Gen 4 - Optimism
  5: 8453, // Gen 5 - Base
  6: 1, // Gen 6 - Ethereum
  0: 1, // Honeycomb - Ethereum
};

// ─────────────────────────────────────────────────────────────────────────
// Row types — mirror the envio entity shapes (for the read-modify-write
// helpers). nullable columns use `| null` (envio used `undefined` for unset
// firstMintTime; the null-vs-undefined deviation is documented — ponder's
// db.find returns null for an absent column, and we WRITE null, which Hasura/
// Postgres stores identically to envio's "unset BigInt" → NULL).
// ─────────────────────────────────────────────────────────────────────────
type TokenRow = {
  id: string;
  collection: string;
  chainId: number;
  tokenId: bigint;
  owner: string;
  isBurned: boolean;
  mintedAt: bigint;
  lastTransferTime: bigint;
};

type HolderRow = {
  id: string;
  address: string;
  balance: number;
  totalMinted: number;
  lastActivityTime: bigint;
  firstMintTime: bigint | null;
  collection: string;
  chainId: number;
};

type CollectionStatRow = {
  id: string;
  collection: string;
  totalSupply: number;
  totalMinted: number;
  totalBurned: number;
  uniqueHolders: number;
  lastMintTime: bigint | null;
  chainId: number;
};

type UserBalanceRow = {
  id: string;
  address: string;
  generation: number;
  balanceHomeChain: number;
  balanceEthereum: number;
  balanceBerachain: number;
  balanceTotal: number;
  mintedHomeChain: number;
  mintedEthereum: number;
  mintedBerachain: number;
  mintedTotal: number;
  lastActivityTime: bigint;
  firstMintTime: bigint | null;
};

// ─────────────────────────────────────────────────────────────────────────
// Main transfer handler for all HoneyJar NFT contracts.
//   envio: src/handlers/honey-jar-nfts.ts:34-135 (handleTransfer)
// ─────────────────────────────────────────────────────────────────────────
async function handleTransfer(
  event: any,
  context: any,
  collectionOverride?: string
): Promise<void> {
  const { from, to, tokenId } = event.args;
  const contractAddress = event.log.address.toLowerCase();
  const collection =
    collectionOverride || ADDRESS_TO_COLLECTION[contractAddress] || "Unknown";
  const generation = COLLECTION_TO_GENERATION[collection] ?? -1;
  const timestamp = event.block.timestamp; // already bigint (envio wrapped BigInt(...))
  const chainId = context.chain.id;

  // Skip unknown collections (envio:48).
  if (generation < 0) return;

  // ── 1. Transfer record (APPEND; id = `${txHash}_${logIndex}`). ──────────
  const transferId = `${event.transaction.hash}_${event.log.logIndex}`;
  await context.db
    .insert(transfer)
    .values({
      id: transferId,
      tokenId: BigInt(tokenId.toString()),
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      timestamp,
      blockNumber: event.block.number, // already bigint
      transactionHash: event.transaction.hash,
      collection,
      chainId,
    })
    .onConflictDoNothing();

  // ── 2. Mint (from zero address). ────────────────────────────────────────
  if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    await handleMint(event, context, collection, to, tokenId, timestamp, chainId);
  }

  // ── 3. Burn (to zero address). ──────────────────────────────────────────
  if (to.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    await handleBurn(context, collection, tokenId, chainId);
  }

  // ── 4. Token ownership. ─────────────────────────────────────────────────
  await updateTokenOwnership(
    context,
    collection,
    tokenId,
    from,
    to,
    timestamp,
    chainId
  );

  // ── 5. Holder reads (INLINE — replaces envio's preload-priming batch read).
  //      The isPreload two-pass is dropped: ponder is single-pass, so we read
  //      the holders here exactly where the write pass needs them, preserving
  //      the read-before-write ordering. ────────────────────────────────────
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const fromHolderId = `${collection}_${chainId}_${fromLower}`;
  const toHolderId = `${collection}_${chainId}_${toLower}`;

  const fromHolder =
    fromLower !== ZERO_ADDRESS.toLowerCase()
      ? ((await context.db.find(holder, { id: fromHolderId })) as HolderRow | null)
      : null;
  const toHolder =
    toLower !== ZERO_ADDRESS.toLowerCase()
      ? ((await context.db.find(holder, { id: toHolderId })) as HolderRow | null)
      : null;

  // ── 6. Holder balances (returns the updated holders). ───────────────────
  const updatedHolders = await updateHolderBalances(
    context,
    collection,
    fromHolder,
    toHolder,
    fromHolderId,
    toHolderId,
    fromLower,
    toLower,
    generation,
    timestamp,
    chainId
  );

  // ── 7. Collection statistics. Passes updatedHolders.fromHolder / .toHolder —
  //      the POST-mutation holders (envio reassigns the references before
  //      returning; see updateHolderBalances' CRITICAL FAITHFULNESS NOTE). The
  //      uniqueHolders balance===0 / balance===1 checks therefore see the
  //      post-mutation balances, replicating the envio quirk byte-for-byte. ──
  await updateCollectionStats(
    context,
    collection,
    fromLower,
    toLower,
    updatedHolders.fromHolder,
    updatedHolders.toHolder,
    timestamp,
    chainId
  );

  // ── 8. Global collection statistics — envio's updateGlobalCollectionStat
  //      early-returns with NO write (dead path; GlobalCollectionStat has 0
  //      writers). NOT ported. ───────────────────────────────────────────────
}

// ─────────────────────────────────────────────────────────────────────────
// Mint events (APPEND; id = `${txHash}_${logIndex}_mint`).
//   envio: src/handlers/honey-jar-nfts.ts:140-161 (handleMint)
// ─────────────────────────────────────────────────────────────────────────
async function handleMint(
  event: any,
  context: any,
  collection: string,
  to: string,
  tokenId: any,
  timestamp: bigint,
  chainId: number
): Promise<void> {
  const mintId = `${event.transaction.hash}_${event.log.logIndex}_mint`;
  await context.db
    .insert(mint)
    .values({
      id: mintId,
      tokenId: BigInt(tokenId.toString()),
      to: to.toLowerCase(),
      timestamp,
      blockNumber: event.block.number, // already bigint
      transactionHash: event.transaction.hash,
      collection,
      chainId,
    })
    .onConflictDoNothing();
}

// ─────────────────────────────────────────────────────────────────────────
// Burn events — flip token to burned + owner = ZERO (only if the token exists).
//   envio: src/handlers/honey-jar-nfts.ts:166-183 (handleBurn)
// ─────────────────────────────────────────────────────────────────────────
async function handleBurn(
  context: any,
  collection: string,
  tokenId: any,
  chainId: number
): Promise<void> {
  const tokenIdStr = `${collection}_${chainId}_${tokenId}`;
  const existing = (await context.db.find(token, {
    id: tokenIdStr,
  })) as TokenRow | null;
  if (existing) {
    await context.db
      .update(token, { id: tokenIdStr })
      .set({
        isBurned: true,
        owner: ZERO_ADDRESS,
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Token ownership (ROLLUP-LWW; id = `${collection}_${chainId}_${tokenId}`).
//   envio: src/handlers/honey-jar-nfts.ts:188-222 (updateTokenOwnership)
// ─────────────────────────────────────────────────────────────────────────
async function updateTokenOwnership(
  context: any,
  collection: string,
  tokenId: any,
  from: string,
  to: string,
  timestamp: bigint,
  chainId: number
): Promise<void> {
  const tokenIdStr = `${collection}_${chainId}_${tokenId}`;
  const existing = (await context.db.find(token, {
    id: tokenIdStr,
  })) as TokenRow | null;

  if (!existing) {
    await context.db
      .insert(token)
      .values({
        id: tokenIdStr,
        collection,
        chainId,
        tokenId: BigInt(tokenId.toString()),
        owner: to.toLowerCase(),
        isBurned: to.toLowerCase() === ZERO_ADDRESS.toLowerCase(),
        mintedAt:
          from.toLowerCase() === ZERO_ADDRESS.toLowerCase()
            ? timestamp
            : BigInt(0),
        lastTransferTime: timestamp,
      })
      .onConflictDoNothing();
  } else {
    await context.db
      .update(token, { id: tokenIdStr })
      .set({
        owner: to.toLowerCase(),
        isBurned: to.toLowerCase() === ZERO_ADDRESS.toLowerCase(),
        lastTransferTime: timestamp,
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Holder balances (ROLLUP; id = `${collection}_${chainId}_${address}`).
// Accepts the PRE-loaded holders (read inline in handleTransfer step 5).
//   envio: src/handlers/honey-jar-nfts.ts:228-309 (updateHolderBalances)
//
// ── CRITICAL FAITHFULNESS NOTE (the uniqueHolders / POST-mutation quirk) ──
// The envio source REASSIGNS `fromHolder = updatedFromHolder` (envio:254) and
// `toHolder = updatedToHolder` (envio:294) before returning them, then
// updateCollectionStats reads `.balance` off these returned values. So despite
// the envio comments (envio:424/430) CLAIMING "balance is BEFORE the transfer",
// the values actually passed to updateCollectionStats are the POST-mutation
// balances:
//   - a brand-new receiver returns toHolder.balance === 1 (0 + 1), so the
//     stats check `toHolder.balance === 0` is FALSE → uniqueHolders does NOT
//     increment for new holders (an envio quirk — the comment lies, the code
//     wins).
//   - a from-holder dropping to 0 returns fromHolder.balance === (n-1); the
//     stats check `fromHolder.balance === 1` only fires when the PRE-balance
//     was 2 (post = 1).
// This port REPLICATES THE ACTUAL ENVIO CODE BEHAVIOR byte-for-byte (returns the
// POST-mutation holders), NOT the comment's intent. Any divergence here would
// silently change uniqueHolders counts vs the frozen blue import. ** RLAI-grade
// uniqueHolders parity vs blue at green-v3 boot. **
//
// One subtlety: envio only reassigns `fromHolder` when balance > 0 (inside the
// `if (fromHolder.balance > 0)` block, envio:246-255). If a from-holder already
// had balance 0 (an anomalous re-transfer-out), envio leaves fromHolder at its
// pre-value (0) and writes nothing. We replicate that exactly.
// ─────────────────────────────────────────────────────────────────────────
async function updateHolderBalances(
  context: any,
  collection: string,
  fromHolder: HolderRow | null,
  toHolder: HolderRow | null,
  fromHolderId: string,
  toHolderId: string,
  fromLower: string,
  toLower: string,
  generation: number,
  timestamp: bigint,
  chainId: number
): Promise<{ fromHolder: HolderRow | null; toHolder: HolderRow | null }> {
  const isMint = fromLower === ZERO_ADDRESS.toLowerCase();
  const isBurn = toLower === ZERO_ADDRESS.toLowerCase();

  // ── 'from' holder (if not zero address). ────────────────────────────────
  if (!isMint && fromHolder) {
    if (fromHolder.balance > 0) {
      const updatedFromHolder: HolderRow = {
        ...fromHolder,
        balance: fromHolder.balance - 1,
        lastActivityTime: timestamp,
      };
      await context.db
        .update(holder, { id: fromHolderId })
        .set({
          balance: updatedFromHolder.balance,
          lastActivityTime: updatedFromHolder.lastActivityTime,
        });
      fromHolder = updatedFromHolder; // envio:254 — update reference for caller
    }

    // Update user balance.
    await updateUserBalance(
      context,
      fromLower,
      generation,
      chainId,
      -1,
      false,
      timestamp
    );
  }

  // ── 'to' holder (if not zero address). ──────────────────────────────────
  if (!isBurn) {
    let toExisted = toHolder !== null; // distinguishes update vs insert
    if (!toHolder) {
      // envio default row (balance:0, totalMinted:0). envio:271-282.
      toHolder = {
        id: toHolderId,
        address: toLower,
        balance: 0,
        totalMinted: 0,
        lastActivityTime: timestamp,
        firstMintTime: isMint ? timestamp : null,
        collection,
        chainId,
      };
    }

    // Build the fully-updated 'to' holder (verbatim from envio's spread).
    const updatedToHolder: HolderRow = {
      ...toHolder,
      balance: toHolder.balance + 1,
      lastActivityTime: timestamp,
      totalMinted: isMint ? toHolder.totalMinted + 1 : toHolder.totalMinted,
      firstMintTime:
        isMint && !toHolder.firstMintTime ? timestamp : toHolder.firstMintTime,
    };

    if (toExisted) {
      await context.db
        .update(holder, { id: toHolderId })
        .set({
          balance: updatedToHolder.balance,
          lastActivityTime: updatedToHolder.lastActivityTime,
          totalMinted: updatedToHolder.totalMinted,
          firstMintTime: updatedToHolder.firstMintTime,
        });
    } else {
      await context.db
        .insert(holder)
        .values(updatedToHolder)
        .onConflictDoNothing();
    }
    toHolder = updatedToHolder; // envio:294 — update reference for caller

    // Update user balance.
    await updateUserBalance(
      context,
      toLower,
      generation,
      chainId,
      1,
      isMint,
      timestamp
    );
  }

  // Return the POST-mutation holders (envio:308). updateCollectionStats reads
  // `.balance` off these — see the CRITICAL FAITHFULNESS NOTE above.
  return { fromHolder, toHolder };
}

// ─────────────────────────────────────────────────────────────────────────
// User balance — CROSS-CHAIN per-generation aggregate.
//   id = `${generation}_${address}`  (NO chainId — aggregates across all chains)
//   envio: src/handlers/honey-jar-nfts.ts:314-384 (updateUserBalance)
// ─────────────────────────────────────────────────────────────────────────
async function updateUserBalance(
  context: any,
  address: string,
  generation: number,
  chainId: number,
  balanceDelta: number,
  isMint: boolean,
  timestamp: bigint
): Promise<void> {
  const userBalanceId = `${generation}_${address}`;
  const existing = (await context.db.find(userBalance, {
    id: userBalanceId,
  })) as UserBalanceRow | null;

  const base: UserBalanceRow =
    existing ??
    ({
      id: userBalanceId,
      address,
      generation,
      balanceHomeChain: 0,
      balanceEthereum: 0,
      balanceBerachain: 0,
      balanceTotal: 0,
      mintedHomeChain: 0,
      mintedEthereum: 0,
      mintedBerachain: 0,
      mintedTotal: 0,
      lastActivityTime: timestamp,
      firstMintTime: isMint ? timestamp : null,
    } as UserBalanceRow);

  // Update balances based on chain (verbatim from envio's spread + Math.max).
  const homeChainId = HOME_CHAIN_IDS[generation];

  const updated: UserBalanceRow = {
    ...base,
    balanceHomeChain:
      chainId === homeChainId
        ? Math.max(0, base.balanceHomeChain + balanceDelta)
        : base.balanceHomeChain,
    balanceEthereum:
      chainId === 1
        ? Math.max(0, base.balanceEthereum + balanceDelta)
        : base.balanceEthereum,
    balanceBerachain:
      chainId === BERACHAIN_TESTNET_ID
        ? Math.max(0, base.balanceBerachain + balanceDelta)
        : base.balanceBerachain,
    balanceTotal: Math.max(0, base.balanceTotal + balanceDelta),
    mintedHomeChain:
      chainId === homeChainId && isMint
        ? base.mintedHomeChain + 1
        : base.mintedHomeChain,
    mintedEthereum:
      chainId === 1 && isMint
        ? base.mintedEthereum + 1
        : base.mintedEthereum,
    mintedBerachain:
      chainId === BERACHAIN_TESTNET_ID && isMint
        ? base.mintedBerachain + 1
        : base.mintedBerachain,
    mintedTotal: isMint ? base.mintedTotal + 1 : base.mintedTotal,
    firstMintTime:
      isMint && !base.firstMintTime ? timestamp : base.firstMintTime,
    lastActivityTime: timestamp,
  };

  if (existing) {
    await context.db
      .update(userBalance, { id: userBalanceId })
      .set({
        balanceHomeChain: updated.balanceHomeChain,
        balanceEthereum: updated.balanceEthereum,
        balanceBerachain: updated.balanceBerachain,
        balanceTotal: updated.balanceTotal,
        mintedHomeChain: updated.mintedHomeChain,
        mintedEthereum: updated.mintedEthereum,
        mintedBerachain: updated.mintedBerachain,
        mintedTotal: updated.mintedTotal,
        firstMintTime: updated.firstMintTime,
        lastActivityTime: updated.lastActivityTime,
      });
  } else {
    await context.db
      .insert(userBalance)
      .values(updated)
      .onConflictDoNothing();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Collection statistics (ROLLUP; id = `${collection}_${chainId}`).
// Accepts the POST-mutation holders (envio reassigns the refs before return).
//   envio: src/handlers/honey-jar-nfts.ts:390-446 (updateCollectionStats)
// ─────────────────────────────────────────────────────────────────────────
async function updateCollectionStats(
  context: any,
  collection: string,
  fromLower: string,
  toLower: string,
  fromHolder: HolderRow | null,
  toHolder: HolderRow | null,
  timestamp: bigint,
  chainId: number
): Promise<void> {
  const statsId = `${collection}_${chainId}`;
  const existing = (await context.db.find(collectionStat, {
    id: statsId,
  })) as CollectionStatRow | null;

  const base: CollectionStatRow =
    existing ??
    ({
      id: statsId,
      collection,
      totalSupply: 0,
      totalMinted: 0,
      totalBurned: 0,
      uniqueHolders: 0,
      lastMintTime: null,
      chainId,
    } as CollectionStatRow);

  const isMint = fromLower === ZERO_ADDRESS.toLowerCase();
  const isBurn = toLower === ZERO_ADDRESS.toLowerCase();

  // Unique-holders adjustment (verbatim from envio:419-433). NOTE: `toHolder` /
  // `fromHolder` here are the POST-mutation holders (envio reassigns the refs);
  // the balance===0 / balance===1 checks below operate on those post-values —
  // see updateHolderBalances' CRITICAL FAITHFULNESS NOTE. Ported byte-for-byte.
  let uniqueHoldersAdjustment = 0;

  // envio:425 (comment says "balance is BEFORE the transfer" — the code passes
  // the AFTER value; we replicate the code, not the comment).
  if (!isBurn && toHolder && toHolder.balance === 0) {
    uniqueHoldersAdjustment += 1;
  }

  // envio:431 (same comment caveat).
  if (!isMint && fromHolder && fromHolder.balance === 1) {
    uniqueHoldersAdjustment -= 1;
  }

  const updated: CollectionStatRow = {
    ...base,
    totalSupply: isMint
      ? base.totalSupply + 1
      : isBurn
      ? base.totalSupply - 1
      : base.totalSupply,
    totalMinted: isMint ? base.totalMinted + 1 : base.totalMinted,
    totalBurned: isBurn ? base.totalBurned + 1 : base.totalBurned,
    lastMintTime: isMint ? timestamp : base.lastMintTime,
    uniqueHolders: Math.max(0, base.uniqueHolders + uniqueHoldersAdjustment),
  };

  if (existing) {
    await context.db
      .update(collectionStat, { id: statsId })
      .set({
        totalSupply: updated.totalSupply,
        totalMinted: updated.totalMinted,
        totalBurned: updated.totalBurned,
        lastMintTime: updated.lastMintTime,
        uniqueHolders: updated.uniqueHolders,
      });
  } else {
    await context.db
      .insert(collectionStat)
      .values(updated)
      .onConflictDoNothing();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-contract handler registrations. The envio source exported one handler per
// contract NAME (HoneyJar / Honeycomb / HoneyJar2..5Eth), each delegating to
// handleTransfer with the appropriate collectionOverride. The two L0-remint /
// native paths that DON'T override let ADDRESS_TO_COLLECTION resolve the
// collection from event.log.address (so the multi-chain HoneyJar entry resolves
// HoneyJar1..6 per address). Ported VERBATIM.
//   envio: src/handlers/honey-jar-nfts.ts:472-507
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HoneyJar:Transfer", async ({ event, context }) => {
  try {
    await handleTransfer(event, context);
  } catch (error) {
    console.error(
      `[HoneyJar] Transfer handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

ponder.on("Honeycomb:Transfer", async ({ event, context }) => {
  try {
    await handleTransfer(event, context);
  } catch (error) {
    console.error(
      `[Honeycomb] Transfer handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

ponder.on("HoneyJar2Eth:Transfer", async ({ event, context }) => {
  try {
    await handleTransfer(event, context, "HoneyJar2");
  } catch (error) {
    console.error(
      `[HoneyJar2Eth] Transfer handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

ponder.on("HoneyJar3Eth:Transfer", async ({ event, context }) => {
  try {
    await handleTransfer(event, context, "HoneyJar3");
  } catch (error) {
    console.error(
      `[HoneyJar3Eth] Transfer handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

ponder.on("HoneyJar4Eth:Transfer", async ({ event, context }) => {
  try {
    await handleTransfer(event, context, "HoneyJar4");
  } catch (error) {
    console.error(
      `[HoneyJar4Eth] Transfer handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

ponder.on("HoneyJar5Eth:Transfer", async ({ event, context }) => {
  try {
    await handleTransfer(event, context, "HoneyJar5");
  } catch (error) {
    console.error(
      `[HoneyJar5Eth] Transfer handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Crayons factory — records the new-ERC721-Base discovery event as a Transfer
// row (the envio skeleton, src/handlers/crayons.ts:7-25). tokenId 0n; from =
// owner; to = the newly-deployed collection address; collection = "crayons_factory".
// APPEND (id = `${txHash}_crayons_factory_${erc721Base.toLowerCase()}`).
//   envio: src/handlers/crayons.ts (handleCrayonsFactoryNewBase)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("CrayonsFactory:Factory__NewERC721Base", async ({ event, context }) => {
  try {
    const { owner, erc721Base } = event.args;

    await context.db
      .insert(transfer)
      .values({
        id: `${event.transaction.hash}_crayons_factory_${erc721Base.toLowerCase()}`,
        tokenId: 0n,
        from: owner.toLowerCase(),
        to: erc721Base.toLowerCase(),
        timestamp: event.block.timestamp, // already bigint
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash.toLowerCase(),
        collection: "crayons_factory",
        chainId: context.chain.id,
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error(
      `[CrayonsFactory] Factory__NewERC721Base handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});
