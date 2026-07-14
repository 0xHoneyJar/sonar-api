-- 005_collection_nft_image_uri.sql — publish the resolved NFT image URL + canonical metadata URI on
-- svm.collection_nft (PYTH-1). Helius DAS getAssetsByGroup already resolves content.links.image
-- server-side per item (verified against the live production response 2026-07-13); sonar was parsing
-- only content.metadata.name and discarding the rest, so Pythenians members rendered grey/identicon
-- downstream. Both nullable — a burnt/odd asset may lack them; the indexer publishes null rather than
-- fabricating a value. Idempotent (re-runnable), matching the sibling migrations in this directory.
ALTER TABLE svm.collection_nft ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE svm.collection_nft ADD COLUMN IF NOT EXISTS uri text;
