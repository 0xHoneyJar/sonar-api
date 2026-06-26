-- 001_init.sql — L2 entity-label registry (SDD §2, §12). Additive + idempotent (re-runnable).
-- Applied at deploy via src/labels/ensure-schema.ts (run_sql), mirroring ensure-kind-constraint.ts.
-- NO destructive ops. GRANTs + Hasura tracking are applied by ensure-schema.ts (need elevated/metadata).

CREATE SCHEMA IF NOT EXISTS label;

-- 2.2 signer authority (public keys only; private keys live off-DB — DH-1/SP-4)
CREATE TABLE IF NOT EXISTS label.signer_key (
  key_id      text PRIMARY KEY,
  public_key  text NOT NULL,         -- ed25519 public key (base64/hex)
  owner       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz            -- non-null = revoked (read-time invalidation, DH-6)
);

-- 2.1 the registry
CREATE TABLE IF NOT EXISTS label.entity_label (
  id                text PRIMARY KEY,                 -- content-addressed (DH-2 / src/labels/id.ts)
  address           text NOT NULL,
  chain             text NOT NULL,
  collection_scope  text,                             -- NULL = global (DH-1/H-1)
  entity            text NOT NULL,
  label             text NOT NULL,
  entity_type       text NOT NULL,
  method            text NOT NULL,
  source            text,
  confidence        numeric(4,3) NOT NULL DEFAULT 0,  -- derived per method (H-5)
  validity_from     timestamptz NOT NULL DEFAULT now(),
  validity_to       timestamptz,                      -- mutable (H-8 staleness close)
  evidence_ref      text NOT NULL,                    -- mandatory (FR-2)
  status            text NOT NULL DEFAULT 'unverified',
  signature         text,
  signing_key_id    text REFERENCES label.signer_key(key_id),
  signature_valid   boolean,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_label_entity_type_chk CHECK (entity_type IN (
    'collection_authority','creator','royalty_receiver','mint_program','distributor',
    'marketplace_escrow','team','treasury','multisig','cex','bridge','holder','unknown')),
  CONSTRAINT entity_label_method_chk CHECK (method IN (
    'chain-mechanical','program-metadata','own-indexed','external-attested','operator-attested','heuristic')),
  CONSTRAINT entity_label_status_chk CHECK (status IN (
    'verified','unverified','unverified_permanent','contested','revoked')),
  CONSTRAINT entity_label_confidence_rng CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX IF NOT EXISTS entity_label_lookup_idx ON label.entity_label (address, chain, collection_scope);
CREATE INDEX IF NOT EXISTS entity_label_entity_idx ON label.entity_label (entity);
CREATE INDEX IF NOT EXISTS entity_label_scope_type_idx ON label.entity_label (collection_scope, entity_type);
CREATE INDEX IF NOT EXISTS entity_label_active_idx ON label.entity_label (address, chain) WHERE validity_to IS NULL;

-- 2.3 reconcile dead-letter (Helius-outage fallback — H-6/DH-7)
CREATE TABLE IF NOT EXISTS label.reconcile_queue (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label_id        text NOT NULL UNIQUE REFERENCES label.entity_label(id) ON DELETE CASCADE, -- M3: one row/label
  reason          text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 8,             -- DH-7 bound
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz
);

-- 2.x per-method confidence decay (H-5/DH-4). half_life_days NULL = no decay (∞).
CREATE TABLE IF NOT EXISTS label.decay_config (
  method          text PRIMARY KEY,
  half_life_days  numeric                              -- NULL = no decay
);
INSERT INTO label.decay_config (method, half_life_days) VALUES
  ('chain-mechanical', NULL),
  ('operator-attested', NULL),
  ('program-metadata', 365),
  ('own-indexed', 180),
  ('external-attested', 90),
  ('heuristic', 60)
ON CONFLICT (method) DO NOTHING;

-- append-only ingest audit incl. REJECTIONS (DH-1/SP-3)
CREATE TABLE IF NOT EXISTS label.ingest_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  writer      text NOT NULL,
  outcome     text NOT NULL,                           -- accepted | rejected
  reason      text,                                    -- validation | bad_signature | trigger | reconcile (rejections)
  label_id    text,
  count       int NOT NULL DEFAULT 1,
  at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_audit_outcome_chk CHECK (outcome IN ('accepted','rejected'))
);

-- T1.2 write-guard: enforces operator-attested key-presence/non-revocation, freezes immutable cols on
-- UPDATE, and makes terminal status sticky. NOTE (NEW-1): Postgres cannot Ed25519-verify, so a TRUE
-- signature_valid is established by the verified APP SEAM (signing.ts), NOT by this trigger. The v1 trust
-- root is the admin write credential; the future labeler/label_verifier column-GRANT split (ensure-schema)
-- is what makes a constrained write credential unable to forge signature_valid. (DH-1/DH-5/SP-2)
CREATE OR REPLACE FUNCTION label.entity_label_write_guard() RETURNS trigger AS $$
DECLARE
  key_ok boolean;
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF NEW.method = 'operator-attested' THEN
      -- operator-attested REQUIRES a present signature + a non-revoked registered key
      IF NEW.signing_key_id IS NULL OR NEW.signature IS NULL THEN
        RAISE EXCEPTION 'operator-attested label requires signature + signing_key_id';
      END IF;
      SELECT (revoked_at IS NULL) INTO key_ok FROM label.signer_key WHERE key_id = NEW.signing_key_id;
      IF key_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'operator-attested label references missing/revoked signing key %', NEW.signing_key_id;
      END IF;
      -- signature_valid is set by the seam AFTER crypto verify; a direct INSERT may not assert it true
      -- unless the key is valid + sig present (cryptographic truth is the seam's job; this is the floor).
    ELSE
      -- non-operator-attested rows carry no signature material
      NEW.signature := NULL; NEW.signing_key_id := NULL; NEW.signature_valid := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP = 'UPDATE') THEN
    -- DH-5/SP-2: only {label, confidence, status, signature_valid, validity_to, notes, updated_at} mutate.
    IF NEW.id <> OLD.id OR NEW.address <> OLD.address OR NEW.chain <> OLD.chain
       OR NEW.entity <> OLD.entity OR NEW.entity_type <> OLD.entity_type OR NEW.method <> OLD.method
       OR NEW.evidence_ref <> OLD.evidence_ref OR NEW.validity_from <> OLD.validity_from
       OR NEW.collection_scope IS DISTINCT FROM OLD.collection_scope
       OR NEW.signature IS DISTINCT FROM OLD.signature
       OR NEW.signing_key_id IS DISTINCT FROM OLD.signing_key_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'immutable column changed on label.entity_label (content-addressed/provenance fields are frozen)';
    END IF;
    -- NEW-1: terminal status is sticky — a normal write can't un-contest/un-revoke/un-seal a label.
    IF OLD.status IN ('contested', 'revoked', 'unverified_permanent') THEN
      NEW.status := OLD.status;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_label_write_guard_trg ON label.entity_label;
CREATE TRIGGER entity_label_write_guard_trg
  BEFORE INSERT OR UPDATE ON label.entity_label
  FOR EACH ROW EXECUTE FUNCTION label.entity_label_write_guard();

-- m5: ingest_audit is append-only — forbid UPDATE/DELETE on ANY path (defense beyond GRANTs).
CREATE OR REPLACE FUNCTION label.ingest_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'label.ingest_audit is append-only (% forbidden)', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ingest_audit_append_only_trg ON label.ingest_audit;
CREATE TRIGGER ingest_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON label.ingest_audit
  FOR EACH ROW EXECUTE FUNCTION label.ingest_audit_append_only();
