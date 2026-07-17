/**
 * ensure-schema.ts — apply the L2 label registry schema at deploy, idempotently (SDD §2, T1.1/T1.3).
 *
 * Mirrors ensure-kind-constraint.ts: additive run_sql + Hasura metadata track. NO destructive ops.
 *   1. run the 001_init.sql DDL (CREATE … IF NOT EXISTS / CREATE OR REPLACE) — re-runnable
 *   2. GRANTs (DH-1): writes only via the `labeler` role; the Hasura anon/public role gets SELECT-only
 *   3. pg_track_table + a SELECT-only public permission on the registry surfaces
 * Called once at service start (or via a deploy hook). Returns {applied, tracked}.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

async function runSql<T = unknown>(sql: string, readOnly = false): Promise<T> {
  const r = await /* @non-metadata-fetch Hasura schema */ fetch(`${HASURA}/v2/query`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify({ type: "run_sql", args: { source: "default", sql, read_only: readOnly } }),
  });
  if (!r.ok) throw new Error(`run_sql ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = (await r.json()) as { error?: unknown };
  if (d.error) throw new Error(`run_sql: ${JSON.stringify(d).slice(0, 300)}`);
  return d as T;
}

/** Track a table + grant the public role SELECT-only (no insert/update/delete exposed — DH-1).
 *  `columns` restricts the anon-visible column set (NEW-3) — defaults to all for already-curated views. */
async function trackSelectOnly(name: string, columns: string[] | "*" = "*"): Promise<void> {
  const meta = async (type: string, args: Record<string, unknown>) => {
    const r = await /* @non-metadata-fetch Hasura schema */ fetch(`${HASURA}/v1/metadata`, {
      method: "POST",
      headers: { "x-hasura-admin-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify({ type, args }),
    });
    // tolerate "already-tracked"/"already-exists" — idempotent
    if (!r.ok) {
      const body = await r.text();
      if (!/already.tracked|already.exists|already.defined/i.test(body)) {
        throw new Error(`metadata ${type} ${r.status}: ${body.slice(0, 200)}`);
      }
    }
  };
  const table = { schema: "label", name };
  await meta("pg_track_table", { source: "default", table });
  await meta("pg_create_select_permission", {
    source: "default",
    table,
    role: "public",
    permission: { columns, filter: {}, allow_aggregations: true },
  });
}

// NEW-3: the anon-visible entity_label columns — provenance-complete MINUS the internal/sensitive fields
// (signature, signing_key_id, notes). entity_primary is a view that already selects only curated columns.
const ENTITY_LABEL_PUBLIC_COLS = [
  "id", "address", "chain", "collection_scope", "entity", "label", "entity_type", "method", "source",
  "confidence", "validity_from", "validity_to", "evidence_ref", "status", "signature_valid",
];

export interface EnsureSchemaResult {
  applied: boolean;
  tracked: string[];
}

export async function ensureLabelSchema(
  opts?: { log?: (m: string) => void; migrationDir?: string },
): Promise<EnsureSchemaResult> {
  const log = opts?.log ?? (() => {});
  if (!HASURA) throw new Error("SVM_HASURA_ENDPOINT required");
  if (!SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required");

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = opts?.migrationDir ?? join(here, "../../migrations/label");

  // m1/NEW-5: the seam's manual '' escaping is only safe under standard_conforming_strings=on. Assert it
  // BEFORE applying ANY SQL (fail closed), else a backslash payload could break out of run_sql (DB-wide).
  const scs = await runSql<{ result?: string[][] }>("SHOW standard_conforming_strings", true);
  const scsVal = (scs.result ?? []).slice(1)[0]?.[0];
  if (scsVal !== "on") {
    throw new Error(`refusing to apply: standard_conforming_strings='${scsVal}' (need 'on' for safe SQL escaping)`);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    log(`[label] applying ${f} (idempotent)…`);
    await runSql(readFileSync(join(dir, f), "utf8"));
  }

  // M1/m5: least-privilege roles. `labeler` is the write SEAM (entity_label INSERT/UPDATE for the upsert;
  // ingest_audit INSERT-only = append-only; reconcile_queue for the worker; SELECT-only on signer_key).
  // signer_key WRITES — the trust root (a forged/un-revoked key forges operator-attested trust) — belong
  // to a SEPARATE `label_operator` role, so holding the write credential cannot mint/un-revoke keys.
  // NEW-1: three least-privilege roles so a constrained write credential cannot forge operator-attested
  // trust. labeler (chain-derived seam) is COLUMN-restricted and cannot write signature/signing_key_id/
  // signature_valid. label_verifier (the operator-attested seam, post-crypto-verify in signing.ts) is the
  // ONLY role that may write those trust columns. label_operator owns key lifecycle + dispute/close.
  // (In v1 all writes use the admin secret, which bypasses these — they future-proof the labeler path;
  //  the v1-effective control is the ingest.ts seam clamp + the DB trigger.)
  // R3-NIT: the labeler INSERT grant is not yet *exercisable* — the seam's INSERT names all columns
  // (incl. the trust cols), so running the chain-derived path AS labeler will need a future change to omit
  // signature/signing_key_id/signature_valid from the non-operator-attested INSERT shape. Today the seam's
  // INSERT requires label_verifier (or admin in v1). These grants document the target least-privilege model.
  log("[label] applying least-privilege GRANTs (labeler / label_verifier / label_operator)…");
  await runSql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labeler') THEN CREATE ROLE labeler NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_verifier') THEN CREATE ROLE label_verifier NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_operator') THEN CREATE ROLE label_operator NOLOGIN; END IF;
    END $$;
    GRANT USAGE ON SCHEMA label TO labeler, label_verifier, label_operator;
    -- labeler: NON-trust columns only — cannot write signature/signing_key_id/signature_valid (NEW-1)
    GRANT INSERT (id,address,chain,collection_scope,entity,label,entity_type,method,source,confidence,validity_from,validity_to,evidence_ref,status,notes)
      ON label.entity_label TO labeler;
    GRANT UPDATE (label,confidence,status,validity_to,notes,updated_at) ON label.entity_label TO labeler;
    GRANT INSERT ON label.ingest_audit TO labeler;                          -- append-only (no UPDATE/DELETE)
    GRANT SELECT, INSERT, UPDATE, DELETE ON label.reconcile_queue TO labeler;
    GRANT SELECT ON label.signer_key, label.decay_config TO labeler;        -- read keys, NEVER write them
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA label TO labeler, label_verifier;
    -- label_verifier: the ONLY role that writes the trust columns, and only post-crypto-verify (signing.ts)
    GRANT INSERT ON label.entity_label TO label_verifier;
    GRANT UPDATE (signature,signing_key_id,signature_valid,label,confidence,status,validity_to,notes,updated_at)
      ON label.entity_label TO label_verifier;
    GRANT INSERT ON label.ingest_audit TO label_verifier;
    GRANT SELECT ON label.signer_key, label.decay_config TO label_verifier;
    -- label_operator: key lifecycle (trust root) + dispute/close
    GRANT SELECT, INSERT, UPDATE ON label.signer_key TO label_operator;
    GRANT SELECT, UPDATE ON label.entity_label TO label_operator;
  `);

  // m6: expose ONLY the consumer surfaces to the public role — NOT signer_key (the seam reads it via
  // admin run_sql; the public role has no business reading key owners/revocation rows).
  const tracked: string[] = [];
  await trackSelectOnly("entity_label", ENTITY_LABEL_PUBLIC_COLS); // NEW-3: no notes/signature/signing_key_id to anon
  await trackSelectOnly("entity_primary"); // a view — already curated columns
  tracked.push("entity_label", "entity_primary");
  log(`[label] tracked (SELECT-only public): ${tracked.join(", ")}`);
  return { applied: true, tracked };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  ensureLabelSchema({ log: (m) => console.log(m) })
    .then((r) => console.log(`✅ label schema ensured (tracked: ${r.tracked.join(", ")})`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
