// ponder-runtime/src/handlers/tracked-erc721-bera.ts
//
// NET-NEW handler (no envio→ponder predecessor was ever ported): the 12
// TrackedErc721Bera contracts (Berachain 80094, ponder.config.mibera.ts:75-87,
// 225-230) were registered on green with NO ponder.on("TrackedErc721Bera:Transfer")
// handler — so their Transfers reached the runtime and VANISHED. This restores
// the per-token CURRENT-OWNER projection (the `token` entity) for all 12.
//
// PORTED FROM: src/handlers/tracked-erc721.ts (the envio twin) — but SCOPED DOWN
// to the per-token `token` projection only (see SCOPE). It reuses the EXACT same
// pure projection as bd-jyn's mibera-collection.ts §1b: token-projection/shared.ts
// (NOT reimplemented — imported + called).
//
// ── SCOPE: token-ONLY (no `action` ledger, no TrackedHolder, no staking) ──────
//   The only consumer of these 12 collections is inventory-api's Stash/gallery,
//   which reads the per-token `token` index filtered on the LOWERCASED CONTRACT
//   ADDRESS:
//     inventory-api/src/inventory.ts:278 (getNftsForOwner) + :192 (getHoldings)
//        → liveSonar.liveOwnerTokenIds(addr, contract)
//     inventory-api/src/live-sonar.ts:87-97
//        → Token(where:{collection:<contractLower>, owner:<addrLower>, isBurned:false}){tokenId}
//   inventory-api NEVER queries TrackedHolder for a tarot/fracture/apdao_seat
//   collectionKey — liveHolderTokenCount (inventory.ts:151) and
//   liveDistinctHolderCount (completeness.ts:32, via inventory.ts:140-144) are
//   only ever passed MIBERA_COLLECTION_KEY ("mibera"). So a token-only handler
//   makes these cards render their owned tokenIds (coherent); writing TrackedHolder
//   / action for these collections would be writes NO consumer reads ("no
//   while-I'm-here"). The envio twin additionally wrote action + TrackedHolder;
//   those are intentionally dropped here. `token` stays reorg-safe via ponder's
//   built-in reorg handling + resolveTokenRow's (blockNumber,logIndex) LWW guard
//   (it is a re-derivable projection — drop + replay the Transfer log to rebuild).
//
// ── FOLDED INVARIANTS (via token-projection/shared.ts, identical to bd-jyn) ──
//   B2  UPSERT — create-if-absent for a token whose mint predates the boundary
//        (prev=null → resolveTokenRow CREATES the row; never update-only).
//   B1  BURN — the collection's REAL sink {0x0, 0x…dead} via isBurnTransfer(),
//        NOT a hardcoded to==0x0. The envio twin uses the SAME isBurnAddress for
//        these 12 collections; isBurned=true flags the row OUT of circulation, it
//        is NOT deleted (consumer filters isBurned:false).
//   B10 LAST-WRITE-WINS by (blockNumber, logIndex) — resolveTokenRow drops an
//        out-of-order / stale event.
//   KEY per (contract, chainId, tokenId) — tokenRowId(contract, chainId, tokenId).
//   apdao_seat is one of the 12 — handled by the same generic per-contract path.

import { ponder } from "ponder:registry";
import { token } from "../../ponder.schema";
import { tokenRowId, resolveTokenRow } from "./token-projection/shared";
import {
  isMintFromZero,
  isBurnTransfer,
  resolveTrackedCollectionKey,
} from "./tracked-erc721-bera-collections";

// All 12 TrackedErc721Bera contracts are registered on Berachain
// (ponder.config.mibera.ts:225-230 — chain: "berachain").
const BERACHAIN_ID = 80094;

ponder.on("TrackedErc721Bera:Transfer", async ({ event, context }: any) => {
  // Multi-address contract: event.log.address is the SPECIFIC emitting contract
  // (one of the 12). Lowercased so it matches the consumer's `collection` filter
  // and the lowercased collection-key map. Same pattern as general-mints.ts:79.
  const contractAddress = event.log.address.toLowerCase();
  const collectionKey = resolveTrackedCollectionKey(contractAddress);
  const from = event.args.from.toLowerCase();
  const to = event.args.to.toLowerCase();
  const tokenId = event.args.tokenId;
  const txHash = event.transaction.hash;
  const blockNumber = event.block.number;
  const logIndex = event.log.logIndex;
  const timestamp = event.block.timestamp;

  const isMint = isMintFromZero(from);
  const isBurn = isBurnTransfer(from, to);

  // ──────────────────────────────────────────────────────────────────────
  // Per-token CURRENT-OWNER projection (token entity — bd-1jg / S1b)
  //
  // Mirrors mibera-collection.ts §1b EXACTLY: same shared helper, same upsert
  // shape (insert().values() / onConflictDoUpdate((row)=>resolveTokenRow(...))).
  // The only difference is the contract / collectionKey are RESOLVED per-event
  // (multi-address) rather than a single hardcoded collection.
  // ──────────────────────────────────────────────────────────────────────
  const tokenTransfer = { to, isMint, isBurn, blockNumber, logIndex, timestamp };
  const tokenRowKey = tokenRowId(contractAddress, BERACHAIN_ID, tokenId);
  const tokenProjected = resolveTokenRow(null, tokenTransfer);
  await context.db
    .insert(token)
    .values({
      id: tokenRowKey,
      owner: tokenProjected.owner as `0x${string}`,
      contract: contractAddress as `0x${string}`,
      // Consumer filters `collection` on the LOWERCASED CONTRACT ADDRESS
      // (inventory-api live-sonar.ts:92-94), NOT the human key — see schema note
      // (ponder.schema.ts:326-334). collectionKey carries the human key.
      collection: contractAddress,
      collectionKey,
      chainId: BERACHAIN_ID,
      tokenId,
      isBurned: tokenProjected.isBurned,
      mintedAt: tokenProjected.mintedAt,
      lastTransferTime: tokenProjected.lastTransferTime,
      lastBlockNumber: tokenProjected.lastBlockNumber,
      lastLogIndex: tokenProjected.lastLogIndex,
    })
    .onConflictDoUpdate((row: any) => {
      const next = resolveTokenRow(
        {
          owner: row.owner,
          isBurned: row.isBurned,
          mintedAt: row.mintedAt,
          lastTransferTime: row.lastTransferTime,
          lastBlockNumber: row.lastBlockNumber,
          lastLogIndex: row.lastLogIndex,
        },
        tokenTransfer,
      );
      // Only the per-transfer mutable fields change; id/contract/collection/
      // collectionKey/chainId/tokenId are stable for a given token id.
      return {
        owner: next.owner as `0x${string}`,
        isBurned: next.isBurned,
        mintedAt: next.mintedAt,
        lastTransferTime: next.lastTransferTime,
        lastBlockNumber: next.lastBlockNumber,
        lastLogIndex: next.lastLogIndex,
      };
    });
});
