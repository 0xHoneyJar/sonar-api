/**
 * sync-status.ts — writer for svm.sync_status, the per-collection freshness row (SDD §2.7).
 *
 * Every pipe that moves data reports here: the warehouse loader, the webhook (per upsert
 * batch), and the reconcile cron. Consumers (score-api, #121 Q4/Q6) read it via the gateway
 * to distinguish "collection is quiet" from "pipe is down" — the exact question KF-018
 * proved unanswerable without it.
 *
 * Fail-soft: a freshness write must never take down the pipe that's reporting. Callers get
 * a boolean, not an exception (mirrors the events-publisher discipline: truth writes first,
 * telemetry best-effort).
 */

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

export type SyncEventSource = "dune-warehouse" | "helius-webhook" | "helius-backfill";
export type ReconcileResult = "passed" | "failed" | "skipped-no-das";

export interface SyncStatusPatch {
  collectionKey: string;
  lastEventAt?: string; // ISO timestamptz
  lastEventSource?: SyncEventSource;
  lastReconcileAt?: string;
  lastReconcileResult?: ReconcileResult;
}

const UPSERT = `
mutation UpsertSyncStatus($object: svm_sync_status_insert_input!, $columns: [svm_sync_status_update_column!]!) {
  insert_svm_sync_status_one(object: $object, on_conflict: {constraint: sync_status_pkey, update_columns: $columns}) {
    collection_key
  }
}`;

/**
 * Upsert the freshness row, updating ONLY the fields present in the patch (a reconcile
 * writer must not clobber last_event_at written by the webhook seconds earlier).
 * Returns false (and logs) on any failure — never throws.
 */
export async function writeSyncStatus(patch: SyncStatusPatch, deps?: { fetchImpl?: typeof fetch }): Promise<boolean> {
  const f = deps?.fetchImpl ?? fetch;
  if (!HASURA || !SECRET) {
    console.warn(`[sync-status] skipped (${patch.collectionKey}): SVM_HASURA_ENDPOINT/HASURA_GRAPHQL_ADMIN_SECRET unset`);
    return false;
  }
  const object: Record<string, unknown> = { collection_key: patch.collectionKey, updated_at: new Date().toISOString() };
  const columns: string[] = ["updated_at"];
  if (patch.lastEventAt !== undefined) { object.last_event_at = patch.lastEventAt; columns.push("last_event_at"); }
  if (patch.lastEventSource !== undefined) { object.last_event_source = patch.lastEventSource; columns.push("last_event_source"); }
  if (patch.lastReconcileAt !== undefined) { object.last_reconcile_at = patch.lastReconcileAt; columns.push("last_reconcile_at"); }
  if (patch.lastReconcileResult !== undefined) { object.last_reconcile_result = patch.lastReconcileResult; columns.push("last_reconcile_result"); }
  try {
    const res = await f(`${HASURA}/v1/graphql`, {
      method: "POST",
      headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ query: UPSERT, variables: { object, columns } }),
    });
    const d = (await res.json()) as { errors?: unknown };
    if (!res.ok || d.errors) {
      console.warn(`[sync-status] write failed (${patch.collectionKey}): ${JSON.stringify(d.errors ?? res.status).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[sync-status] write failed (${patch.collectionKey}): ${(e as Error).message}`);
    return false;
  }
}
