/**
 * reconcile.ts — chain-derived reconcile gate + Helius-outage fallback (SDD §6, FR-4, H-6, DH-7, SP-5).
 *
 * Two reconcile SOURCES by method (SP-5 — not a contradiction): chain-mechanical/program-metadata use
 * on-chain/DAS (Helius — can be unavailable); own-indexed corroborates from our own svm_collection_event
 * (no Helius, always available). The injected `Reconciler` abstracts both and reports `available`.
 *   available && ok  → verified
 *   available && !ok → reject (reconcile) at write; worker bumps attempts then unverified_permanent
 *   !available       → unverified, DON'T block (H-6); the worker retries when Helius recovers
 * operator-attested (signing.ts), external-attested, heuristic pass through unchanged.
 */
import { LabelReject, type LabelInput, type LabelStep, type RunSql } from "./types";

export interface ReconcileOutcome {
  available: boolean; // false = the reconcile source (Helius) is down
  ok: boolean; // true = the label re-derives / corroborates against the source
}
export type Reconciler = (row: LabelInput) => Promise<ReconcileOutcome>;

const CHAIN_DERIVED = new Set(["chain-mechanical", "program-metadata", "own-indexed"]);

export function makeReconcileStep(reconcile: Reconciler): LabelStep {
  return {
    name: "reconcile",
    async apply(row: LabelInput): Promise<LabelInput> {
      if (!CHAIN_DERIVED.has(row.method)) return row;
      const { available, ok } = await reconcile(row);
      if (!available) return { ...row, status: "unverified" }; // H-6: never block on a Helius outage
      if (!ok) throw new LabelReject("reconcile", `chain-derived label failed reconcile: ${row.address}`);
      return { ...row, status: "verified" };
    },
  };
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export interface WorkerResult {
  scanned: number;
  verified: number;
  stillUnverified: number;
  permanent: number;
}

/**
 * reconcileQueueWorker — drains unverified chain-derived labels when Helius recovers (T4.4). Bounded by
 * max_attempts (DH-7): an unverified label that keeps failing reconcile after N attempts is sealed
 * `unverified_permanent` + alerted, never retried forever. `reconcile_queue` tracks per-label attempts.
 */
export async function reconcileQueueWorker(opts: {
  runSql: RunSql;
  reconcile: Reconciler;
  maxAttempts?: number;
  log?: (m: string) => void;
}): Promise<WorkerResult> {
  const { runSql, reconcile } = opts;
  const max = opts.maxAttempts ?? 8;
  const log = opts.log ?? (() => {});
  const res: WorkerResult = { scanned: 0, verified: 0, stillUnverified: 0, permanent: 0 };

  const d = await runSql<{ result?: string[][] }>(
    `SELECT id, address, chain, collection_scope, entity, label, entity_type, method, evidence_ref
     FROM label.entity_label
     WHERE status = 'unverified' AND method IN ('chain-mechanical','program-metadata','own-indexed')
     LIMIT 500`,
    true,
  );
  const rows = (d.result ?? []).slice(1); // drop header
  for (const r of rows) {
    res.scanned++;
    const [id, address, chain, collection_scope, entity, label, entity_type, method, evidence_ref] = r;
    const row = {
      address, chain, collectionScope: collection_scope === "" ? null : collection_scope,
      entity, label, entityType: entity_type as LabelInput["entityType"], method: method as LabelInput["method"], evidenceRef: evidence_ref,
    } as LabelInput;
    const { available, ok } = await reconcile(row);
    if (!available) {
      res.stillUnverified++;
      continue; // Helius still down — leave it, no attempt charged
    }
    if (ok) {
      await runSql(`UPDATE label.entity_label SET status = 'verified', updated_at = now() WHERE id = ${sqlStr(id)}`, false);
      await runSql(`DELETE FROM label.reconcile_queue WHERE label_id = ${sqlStr(id)}`, false); // clear on success
      res.verified++;
      continue;
    }
    // not ok — ONE atomic bump (M3: UNIQUE(label_id) makes this a real upsert; RETURNING reads the
    // authoritative count, not an arbitrary fragmented row). No swallowed writes.
    const bump = await runSql<{ result?: string[][] }>(
      `INSERT INTO label.reconcile_queue (label_id, reason, attempts, max_attempts, last_attempt_at)
       VALUES (${sqlStr(id)}, 'reconcile-retry', 1, ${max}, now())
       ON CONFLICT (label_id) DO UPDATE SET attempts = label.reconcile_queue.attempts + 1, last_attempt_at = now()
       RETURNING attempts, max_attempts`,
      false,
    );
    const br = (bump.result ?? []).slice(1)[0];
    const attempts = br ? Number(br[0]) : 1;
    const maxA = br && br[1] ? Number(br[1]) : max;
    if (attempts >= maxA) {
      await runSql(`UPDATE label.entity_label SET status = 'unverified_permanent', updated_at = now() WHERE id = ${sqlStr(id)}`, false);
      await runSql(`DELETE FROM label.reconcile_queue WHERE label_id = ${sqlStr(id)}`, false); // NEW-4: no residue after seal
      res.permanent++;
      log(`[label] ALERT reconcile exhausted (${attempts}/${maxA}) → unverified_permanent: ${id}`);
    } else {
      res.stillUnverified++;
    }
  }
  return res;
}
