-- 001_collection_owner_derived.sql — current BENEFICIAL owner per collection NFT, derived from the
-- self-healing svm.collection_event stream. A plain VIEW, so it is ALWAYS fresh by construction (no cron,
-- no DAS, no Helius) — the inverse of the on-demand svm.collection_nft DAS snapshot that goes stale between
-- manual runs and reports the marketplace escrow as owner when an NFT is escrow-listed.
--
-- owner = the `to` of each mint's LATEST ownership-moving event (mint | transfer | sale), ordered by
-- (slot, instruction_index). `list`/`delist` escrow-custody movements are deliberately skipped so a listed
-- NFT's owner stays the lister (beneficial owner), not the escrow; a mint whose latest custody event is a
-- `burn` has no current owner and is excluded.
--
-- This COMPLEMENTS svm.collection_nft (the DAS custodial-owner snapshot); it does not replace it. For
-- Pythenians it agrees with the DAS snapshot for 97.77% of mints; the disagreements are exactly the
-- escrow-listed NFTs, where this view resolves through to the beneficial owner. Idempotent (re-runnable).
CREATE OR REPLACE VIEW svm.collection_owner_derived AS
SELECT collection_key, collection_mint, nft_mint, owner, via_kind, slot, block_time, tx_signature
FROM (
  SELECT DISTINCT ON (collection_key, nft_mint)
    collection_key, collection_mint, nft_mint, "to" AS owner, kind AS via_kind, slot, block_time, tx_signature
  FROM svm.collection_event
  WHERE kind IN ('mint', 'transfer', 'sale', 'burn')
  ORDER BY collection_key, nft_mint, slot DESC, instruction_index DESC
) latest
WHERE via_kind <> 'burn';
