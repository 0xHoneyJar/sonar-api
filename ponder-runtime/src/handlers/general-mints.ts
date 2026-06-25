// ponder-runtime/src/handlers/general-mints.ts
//
// PORTED FROM (envio, source-of-truth):
//   - src/handlers/mints.ts     — GeneralMints.Transfer.handler:
//                                  writes MintEvent (id = `${txHash}_${logIndex}`)
//                                  + recordAction("mint") + the gated publish.
//   - src/handlers/vm-minted.ts — GeneralMints.Minted.handler:
//                                  enriches the existing MintEvent with
//                                  encodedTraits, then publishes the shadow
//                                  envelope (encoded_traits-bearing).
//
// Contract: GeneralMints (Berachain 80094). Two registered addresses
// (ponder.config.mibera.ts:70 GENERAL_MINTS):
//   - 0x048327A187b944ddac61c6e202BfccD20d17c008 → mibera_vm  (Mibera Shadows /
//     "VM"). Emits the custom Minted(user, tokenId, traits) event. Its mint is
//     published on the canonical `mibera-shadow` subject by the Minted handler
//     (NOT by the Transfer handler — avoids double-publish, see allowlist below).
//   - 0x230945E0Ed56EF4dE871a6c0695De265DE23D8D8 → mibera_gif. Plain ERC-721
//     Transfer mints only (no Minted event). Published on `mibera-collection`.
//
// envio → ponder API translation (verbatim from the already-ported handlers):
//   - envio: GeneralMints.Transfer.handler(async ({event, context}) => ...)
//     ponder: ponder.on("GeneralMints:Transfer", async ({event, context}) => ...)
//   - event.params            → event.args
//   - event.chainId           → context.chain.id
//   - event.srcAddress        → event.log.address
//   - event.logIndex          → event.log.logIndex
//   - event.block.timestamp   → already bigint (no BigInt() wrap)
//   - context.MintEvent.set   → context.db.insert(mintEvent).values(...).onConflictDoNothing()
//   - context.MintEvent.get   → await context.db.find(mintEvent, { id })
//                               + context.db.update(mintEvent, { id }).set(...)  (Minted enrich)
//   - publishMintEvent({...})  → isLiveEvent-gated reorgSafeEmit(context, envelope, event, chainId)
//     (the mibera-collection.ts:157 emit discipline, copied EXACTLY).

import { ponder } from "ponder:registry";
import { mintEvent, action, token } from "../../ponder.schema";
import { isLiveEvent } from "../lib/sync-status";
import { reorgSafeEmit } from "../lib/reorg-safe-emit";
import { buildMintEnvelope, type CollectionSlug } from "../lib/nats-publisher";
import { tokenRowId, resolveTokenRow } from "./token-projection/shared";
// B1 real-sink burn predicate {0x0, 0x…dead} + mint detection — the SHARED pure
// helpers bd-jyn (mibera-collection §1b) / bd-1jg (tracked-erc721-bera) use. NOT
// a hardcoded to==0x0. Reused, not reimplemented.
import { isMintFromZero, isBurnTransfer } from "./tracked-erc721-bera-collections";

const BERACHAIN_ID = 80094;

// Address → local collectionKey map. Verbatim subset of envio's
// MINT_COLLECTION_KEYS (src/handlers/mints/constants.ts) restricted to the two
// addresses GeneralMints is registered for in ponder.config.mibera.ts:70.
const MINT_COLLECTION_KEYS: Record<string, string> = {
  // mibera_vm / "Mibera Shadows" — the generative VM collection (emits Minted).
  "0x048327a187b944ddac61c6e202bfccd20d17c008": "mibera_vm",
  // mibera_gif.
  "0x230945e0ed56ef4de871a6c0695de265de23d8d8": "mibera_gif",
};

// Mibera-family publish allowlist — verbatim port of envio's
// MINT_PUBLISH_ALLOWLIST (src/handlers/mints.ts:40). Maps the local
// collectionKey → cluster topic specifier (CollectionSlug).
//
// `mibera_vm` is DELIBERATELY OMITTED here: the Minted handler below publishes
// the VM mint on the canonical `mibera-shadow` subject with its trait-enriched
// payload. Publishing it here too would double-publish the same mint with a
// less-enriched envelope (the exact scoping decision documented in envio's
// mints.ts:27-38). `mibera_gif` IS mibera-family → `mibera-collection`.
const MINT_PUBLISH_ALLOWLIST: Record<string, CollectionSlug> = {
  mibera_gif: "mibera-collection",
};

// ──────────────────────────────────────────────────────────────────────────
// GeneralMints:Transfer — port of src/handlers/mints.ts
// ──────────────────────────────────────────────────────────────────────────
ponder.on("GeneralMints:Transfer", async ({ event, context }: any) => {
  const { from, to, tokenId } = event.args;

  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const contractAddress = event.log.address.toLowerCase();
  const collectionKey = MINT_COLLECTION_KEYS[contractAddress] ?? contractAddress;

  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const id = `${txHash}_${logIndex}`;
  const timestamp = event.block.timestamp; // already bigint
  const blockNumber = event.block.number;
  const chainId = context.chain.id;

  // isMint == the original `fromLower === ZERO` mint gate (re-applied, negated,
  // below). isBurn = the SHARED real-sink predicate {0x0, 0x…dead} (B1), NOT a
  // hardcoded to==0x0 — identical to bd-jyn / bd-1jg.
  const isMint = isMintFromZero(fromLower);
  const isBurn = isBurnTransfer(fromLower, toLower);

  // ──────────────────────────────────────────────────────────────────────
  // 1b. Per-token CURRENT-OWNER projection (token entity — bd-d2b / S1c)
  //
  // Runs for EVERY GeneralMints Transfer (mint, secondary sale, AND burn) so a
  // token minted to A then sold to B reflects owner=B. The mint-ONLY ledger
  // below previously early-returned on every non-mint transfer, leaving MST/GIF
  // entirely ABSENT from the per-token ownership index. This projection is the
  // fix and is the ONLY token write for GeneralMints (the Minted handler does
  // not touch `token`).
  //
  // ERC-721 ONLY: both registered GeneralMints addresses — MST/mibera_vm
  // (0x048327…) and GIF/mibera_gif (0x230945…) — emit the 721
  // `Transfer(from,to,indexed tokenId)` event (abis/MiberaAbis.ts:52). No ERC-1155
  // TransferSingle/TransferBatch is registered under GeneralMintsAbi, so the
  // per-token-721 projection applies to BOTH contracts (no 1155 exclusion).
  //
  //   UPSERT (B2): insert().onConflictDoUpdate() — a token whose mint predates
  //     this index boundary has NO prior row; resolveTokenRow(prev=null,…) CREATES
  //     it on the first transfer seen (never update-only / silently dropped).
  //   BURN (B1): isBurn is the SHARED isBurnTransfer() real sink {0x0, 0x…dead},
  //     NOT to==0x0. isBurned=true flags the row OUT of circulation; the row is
  //     NOT deleted (consumer filters isBurned:false).
  //   LAST-WRITE-WINS (B10): resolveTokenRow drops an out-of-order event whose
  //     (blockNumber, logIndex) is older than the stored pair — ordering is the
  //     (blockNumber, logIndex) key, NOT insert order and NOT timestamp.
  //   KEYING: id = `${contract}_${chainId}_${tokenId}`, per (contract, chainId,
  //     tokenId). collection = the LOWERCASED CONTRACT ADDRESS (consumer filter,
  //     inventory-api live-sonar.ts:92-94); collectionKey = the human key.
  //   mintedAt threaded (isMint?timestamp:preserve) by resolveTokenRow exactly as
  //     mibera-collection.ts §1b.
  // ──────────────────────────────────────────────────────────────────────
  const tokenTransfer = { to: toLower, isMint, isBurn, blockNumber, logIndex, timestamp };
  const tokenRowKey = tokenRowId(contractAddress, chainId, tokenId);
  const tokenProjected = resolveTokenRow(null, tokenTransfer);
  await context.db
    .insert(token)
    .values({
      id: tokenRowKey,
      owner: tokenProjected.owner as `0x${string}`,
      contract: contractAddress as `0x${string}`,
      collection: contractAddress,
      collectionKey,
      chainId,
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

  // ──────────────────────────────────────────────────────────────────────
  // MINT-ONLY ledger + publish (port of envio mints.ts) — behavior UNCHANGED.
  // Non-mint transfers + burns are already captured by the token projection
  // above; the mintEvent / mint-action / mibera-family publish stay gated to
  // mints EXACTLY as the original `if (fromLower !== ZERO) return` did — here
  // `!isMint` is `fromLower !== ZERO` (isMint === isMintFromZero(fromLower)).
  // ──────────────────────────────────────────────────────────────────────
  if (!isMint) {
    return; // Skip non-mint transfers for the mint ledger/publish (envio mints.ts:51)
  }

  const minter = toLower;

  // MintEvent.set → idempotent insert (reorg-replay: same deterministic id).
  // encodedTraits left null here; the Minted handler enriches VM mints.
  await context.db
    .insert(mintEvent)
    .values({
      id,
      collectionKey,
      tokenId: BigInt(tokenId.toString()),
      minter: minter as `0x${string}`,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId,
      encodedTraits: null,
    })
    .onConflictDoNothing();

  // recordAction("mint") — parity with envio mints.ts:77. Inlined to match the
  // mibera-collection.ts action-insert shape (id = `${txHash}_${logIndex}_mint`
  // would collide with the mint_event id only by suffix; envio used the bare
  // `${txHash}_${logIndex}` id for the action. Preserve envio's id EXACTLY).
  await context.db
    .insert(action)
    .values({
      id,
      actionType: "mint",
      actor: minter as `0x${string}`,
      primaryCollection: collectionKey,
      timestamp,
      chainId,
      txHash: txHash as `0x${string}`,
      numeric1: 1n,
      numeric2: null,
      context: JSON.stringify({
        tokenId: tokenId.toString(),
        contract: contractAddress,
      }),
    })
    .onConflictDoNothing();

  // Events-pillar v1: gated publish for the mibera-family allowlist only.
  // Non-allowlisted collections (and mibera_vm — published by the Minted
  // handler instead) fall through unchanged; the indexer DB write above is the
  // durable record. SDD §4.2 HISTORICAL SYNC GATE — gate behind isLiveEvent.
  const publishSlug = MINT_PUBLISH_ALLOWLIST[collectionKey];
  if (publishSlug && (await isLiveEvent(event, context))) {
    const envelope = buildMintEnvelope(publishSlug, {
      chain_id: chainId,
      contract: contractAddress,
      token_id: tokenId.toString(),
      minter,
      block_number: Number(blockNumber),
      transaction_hash: txHash,
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
    });
    await reorgSafeEmit(context, envelope, event, chainId);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GeneralMints:Minted — port of src/handlers/vm-minted.ts
//
// The VM contract fires Minted(user, tokenId, traits) right after its Transfer.
// envio (no in-handler queries) used the predictable id pattern: the Transfer
// MintEvent is at logIndex - 1. We replicate that lookup, enrich with
// encodedTraits, then publish the trait-bearing `mibera-shadow` envelope.
// ──────────────────────────────────────────────────────────────────────────
ponder.on("GeneralMints:Minted", async ({ event, context }: any) => {
  const { user, tokenId, traits } = event.args;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const timestamp = event.block.timestamp; // already bigint
  const blockNumber = event.block.number;
  const chainId = context.chain.id;
  const contractAddress = event.log.address.toLowerCase();
  const minter = user.toLowerCase();

  // Find the MintEvent created by the Transfer handler. envio used the
  // predictable id: Transfer fires immediately before Minted, so its logIndex
  // is event.logIndex - 1 (vm-minted.ts:30).
  const transferLogIndex = logIndex - 1;
  const transferEventId = `${txHash}_${transferLogIndex}`;

  const existingMintEvent = await context.db.find(mintEvent, {
    id: transferEventId,
  });

  if (existingMintEvent) {
    // Enrich the existing MintEvent with encoded traits (vm-minted.ts:37).
    await context.db
      .update(mintEvent, { id: transferEventId })
      .set({ encodedTraits: traits });
    console.log(
      `[GeneralMints:Minted] Enriched traits for tokenId ${tokenId}: ${traits}`,
    );
  } else {
    // Transfer handler should have created it. Warn but do NOT create here —
    // creation stays the Transfer handler's responsibility (vm-minted.ts:44).
    console.warn(
      `[GeneralMints:Minted] No existing MintEvent for txHash ${txHash}, ` +
        `tokenId ${tokenId}. Expected at logIndex ${transferLogIndex}.`,
    );
  }

  // Events-pillar v1: publish the trait-enriched MST/VM mint envelope on the
  // canonical `mibera-shadow` subject (vm-minted.ts:55). SDD §4.2 HISTORICAL
  // SYNC GATE — gate behind isLiveEvent, mirror mibera-collection.ts:157.
  if (await isLiveEvent(event, context)) {
    const envelope = buildMintEnvelope("mibera-shadow", {
      chain_id: chainId,
      contract: contractAddress,
      token_id: tokenId.toString(),
      minter,
      block_number: Number(blockNumber),
      transaction_hash: txHash,
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      encoded_traits: traits,
    });
    await reorgSafeEmit(context, envelope, event, chainId);
  }
});
