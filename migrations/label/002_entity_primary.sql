-- 002_entity_primary.sql — precedence-resolved primary label per address (SDD §2.4, H-2, DH-6). Idempotent.
-- Read-time revocation: a label signed by a revoked key is excluded HERE (instant), not job-latency-bound.
CREATE OR REPLACE VIEW label.entity_primary AS
WITH scored AS (
  SELECT el.*,
    el.confidence * CASE
      WHEN dc.half_life_days IS NULL THEN 1
      ELSE power(0.5::numeric,
        (GREATEST(0, EXTRACT(EPOCH FROM (now() - el.validity_from)) / 86400.0) / dc.half_life_days)::numeric)
    END AS effective_confidence,
    CASE el.method
      WHEN 'operator-attested' THEN 6 WHEN 'chain-mechanical' THEN 5 WHEN 'program-metadata' THEN 4
      WHEN 'own-indexed' THEN 3 WHEN 'external-attested' THEN 2 ELSE 1 END AS method_rank
  FROM label.entity_label el
  LEFT JOIN label.decay_config dc ON dc.method = el.method
  LEFT JOIN label.signer_key sk ON sk.key_id = el.signing_key_id
  WHERE el.validity_to IS NULL                                            -- active labels only
    AND el.status NOT IN ('contested', 'revoked', 'unverified_permanent') -- exclude bad (dispute, DH-6)
    AND (el.signing_key_id IS NULL OR (sk.key_id IS NOT NULL AND sk.revoked_at IS NULL)) -- m2: fail CLOSED on a missing/dangling key
    AND (el.method <> 'operator-attested' OR el.signature_valid IS TRUE)  -- M2: operator-attested must carry a verified signature
),
ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY address, chain, collection_scope
    ORDER BY method_rank DESC, effective_confidence DESC, validity_from DESC -- precedence (H-2)
  ) AS rn
  FROM scored
)
SELECT address, chain, collection_scope, entity, label, entity_type, method, source,
       confidence, effective_confidence, validity_from, evidence_ref, status, signature_valid
FROM ranked
WHERE rn = 1;

-- DH-3 NULL-scope query contract (documented; consumers MUST OR-in globals):
--   SELECT * FROM label.entity_primary
--   WHERE address = $a AND chain = $c AND (collection_scope = $scope OR collection_scope IS NULL)
--   ORDER BY (collection_scope IS NOT NULL) DESC   -- a collection-specific label outranks a global
--   LIMIT 1;
