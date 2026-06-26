/**
 * ingest.ts — the single authenticated write path into label.entity_label (SDD §3, FR-2, H-7, SP-1/3).
 *
 * Pipeline per row: validate (FR-2) → injected steps (confidence/signing/reconcile — added by S3/S4 and
 * passed by the composition root, NOT imported here, so S3/S4 never edit this file) → idempotent upsert
 * (content-addressed id, mutable cols only — DH-5 also enforced by the DB trigger) → ingest_audit. Every
 * outcome (accepted OR rejected) is audited (SP-3). Writes go through `runSql` (admin-credentialed run_sql,
 * service-only; the public Hasura role is SELECT-only — DH-1), so possession of that credential is the
 * writer-auth floor and the trigger is the invariant floor. The extraction loop (FR-8) calls THIS function
 * — "tooling" gets no bypass (H-7).
 */
import { labelId } from "./id";
import { LabelReject, type IngestResult, type LabelInput, type LabelStep, type RunSql, type StepContext } from "./types";

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

/** Default run_sql against Hasura (admin = the service write credential). Injectable for tests. */
export const defaultRunSql: RunSql = async <T>(sql: string, readOnly = false): Promise<T> => {
  const r = await fetch(`${HASURA}/v2/query`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify({ type: "run_sql", args: { source: "default", sql, read_only: readOnly } }),
  });
  if (!r.ok) throw new Error(`run_sql ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = (await r.json()) as { error?: unknown };
  if (d.error) throw new Error(`run_sql: ${JSON.stringify(d).slice(0, 300)}`);
  return d as T;
};

function sqlStr(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/'/g, "''")}'`; // single-quote escape (values are addresses/labels/refs, not SQL)
}
function sqlNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  const n = Number(v); // self-defending (M5): JSON-sourced values are runtime-untyped — never emit
  return Number.isFinite(n) ? String(n) : "NULL"; // a non-numeric unquoted into run_sql
}
function sqlBool(v: boolean | null | undefined): string {
  return v === null || v === undefined ? "NULL" : v ? "TRUE" : "FALSE";
}

/** FR-2: method + evidence_ref are mandatory; entity/label/entity_type/address/chain must be present. */
function validate(row: LabelInput): void {
  for (const f of ["address", "chain", "entity", "label", "entityType", "method", "evidenceRef"] as const) {
    if (!row[f]) throw new LabelReject("validation", `missing required field: ${f}`);
  }
}

// m4: validity_to ratchets closed-only — a same-evidence re-ingest must NOT reopen a closed window.
const MUTABLE = "label = EXCLUDED.label, confidence = EXCLUDED.confidence, status = EXCLUDED.status, " +
  "signature_valid = EXCLUDED.signature_valid, " +
  "validity_to = COALESCE(entity_label.validity_to, EXCLUDED.validity_to), notes = EXCLUDED.notes, " +
  "updated_at = now()";

export interface IngestOptions {
  writer: string;
  steps?: LabelStep[];
  runSql?: RunSql;
  log?: (m: string) => void;
}

export async function ingestLabels(rows: LabelInput[], opts: IngestOptions): Promise<IngestResult> {
  const runSql = opts.runSql ?? defaultRunSql;
  const log = opts.log ?? (() => {});
  const ctx: StepContext = { runSql, log };
  const steps = opts.steps ?? [];
  const result: IngestResult = { accepted: 0, rejected: [], ids: [] };

  for (const raw of rows) {
    let row = raw;
    let id: string | null = null;
    try {
      validate(row);
      // NEW-1: for operator-attested rows the trust signals (signature_valid/status) are set ONLY by the
      // verified signing step — strip any producer-supplied values so a caller can't preset "verified".
      if (row.method === "operator-attested") row = { ...row, signatureValid: undefined, status: undefined };
      for (const s of steps) row = await s.apply(row, ctx);
      // NEW-1: an operator-attested row that did NOT pass the verified signing step never reaches the table
      // (no signing step in the pipeline, or it didn't set signatureValid=true) → reject, don't serve unverified-as-verified.
      if (row.method === "operator-attested" && row.signatureValid !== true) {
        throw new LabelReject("bad_signature", "operator-attested label not verified by the signing step (signatureValid !== true)");
      }

      const validityFrom = row.validityFrom ?? new Date().toISOString(); // metadata only (NOT in the id, M4)
      id = labelId({
        chain: row.chain, address: row.address, collectionScope: row.collectionScope,
        entityType: row.entityType, method: row.method, evidenceRef: row.evidenceRef,
      });
      await runSql(
        `INSERT INTO label.entity_label
          (id,address,chain,collection_scope,entity,label,entity_type,method,source,confidence,
           validity_from,validity_to,evidence_ref,status,signature,signing_key_id,signature_valid,notes)
         VALUES (${sqlStr(id)},${sqlStr(row.address)},${sqlStr(row.chain)},${sqlStr(row.collectionScope)},
           ${sqlStr(row.entity)},${sqlStr(row.label)},${sqlStr(row.entityType)},${sqlStr(row.method)},
           ${sqlStr(row.source)},${sqlNum(row.confidence ?? 0)},${sqlStr(validityFrom)},${sqlStr(row.validityTo)},
           ${sqlStr(row.evidenceRef)},${sqlStr(row.status ?? "unverified")},${sqlStr(row.signature)},
           ${sqlStr(row.signingKeyId)},${sqlBool(row.signatureValid)},${sqlStr(row.notes)})
         ON CONFLICT (id) DO UPDATE SET ${MUTABLE}`,
        false,
      );
    } catch (e) {
      const reason = e instanceof LabelReject ? e.reason : "trigger";
      const message = (e as Error).message;
      result.rejected.push({ address: row.address ?? "?", reason, message });
      // m5: don't swallow audit failures — surface them (a blind spot is worst when the DB is unhealthy)
      await audit(runSql, opts.writer, "rejected", reason, null).catch((ae) => log(`[label] reject-audit failed: ${(ae as Error).message}`));
      log(`[label] REJECTED ${row.address ?? "?"} (${reason}): ${message}`);
      continue;
    }
    // m3: accepted-audit runs OUTSIDE the mutation try — a post-write audit failure must NOT reclassify a
    // committed insert as rejected. The write already succeeded; an audit error is logged, not fatal.
    result.accepted++;
    result.ids.push(id);
    await audit(runSql, opts.writer, "accepted", null, id).catch((ae) => log(`[label] accept-audit failed for ${id}: ${(ae as Error).message}`));
  }
  return result;
}

/** SP-3: audit accepted AND rejected writes (forgery/abuse is visible, not silent). */
async function audit(runSql: RunSql, writer: string, outcome: "accepted" | "rejected", reason: string | null, labelId: string | null): Promise<void> {
  await runSql(
    `INSERT INTO label.ingest_audit (writer, outcome, reason, label_id)
     VALUES (${sqlStr(writer)},${sqlStr(outcome)},${sqlStr(reason)},${sqlStr(labelId)})`,
    false,
  );
}
