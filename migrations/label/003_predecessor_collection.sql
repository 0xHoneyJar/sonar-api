-- 003_predecessor_collection.sql — additive: extend entity_type with 'predecessor_collection'
-- (migration/upgrade lineage — e.g. the Pikenians → Pythenians burn-to-mint predecessor mints).
-- Idempotent + re-runnable: DROP IF EXISTS + re-ADD the CHECK with the full enum. Runs after 001 in
-- sort order, so fresh installs get the widened CHECK too; existing rows all satisfy the superset.
ALTER TABLE label.entity_label DROP CONSTRAINT IF EXISTS entity_label_entity_type_chk;
ALTER TABLE label.entity_label ADD CONSTRAINT entity_label_entity_type_chk CHECK (entity_type IN (
  'collection_authority','creator','royalty_receiver','mint_program','distributor',
  'marketplace_escrow','team','treasury','multisig','cex','bridge','holder','unknown','predecessor_collection'));
