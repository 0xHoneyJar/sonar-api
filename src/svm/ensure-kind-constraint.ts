/**
 * ensure-kind-constraint.ts — idempotent, widen-before-write guard for the svm.collection_event `kind`
 * CHECK constraint (#85). The marketplace-kinds cutover (list/delist) is otherwise an ordering footgun:
 * a `list` row written against the un-widened live CHECK (mint/transfer/burn/sale) fails the WHOLE
 * atomic batch upsert + triggers a Helius 500 retry-storm (FAGAN MAJOR-1).
 *
 * Calling this at the START of the backfill runner AND the webhook server — before any write — makes the
 * cutover SAFE-BY-CONSTRUCTION: the constraint is always ensured before list/delist emission, regardless
 * of deploy order. No manual ALTER, no permission gate — flipping SVM_EMIT_MARKETPLACE_KINDS=true can
 * never trip the CHECK because the constraint is widened in the same process startup, first.
 *
 * Idempotent: it READS the current constraint definition and only ALTERs when list/delist aren't already
 * allowed (steady-state is a single cheap SELECT, no-op). The widen is one run_sql statement, so Postgres
 * applies the DROP+ADD in a single implicit transaction — the constraint is never absent to a concurrent
 * writer. ADD validates existing rows, which are all in the widened set, so it always succeeds.
 *
 * PRECONDITION (FAGAN MINOR-2): this is the repo's only consumer of Hasura's `/v2/query` `run_sql`
 * admin API (every other DB call uses `/v1/graphql`). It requires belt-hasura v2 with the schema/SQL
 * admin API enabled on the `default` source — which it is, since migrations need it. If that API were
 * ever disabled, both write entrypoints crash-loop at startup (fail-loud), even for the ownership-only
 * 99% case; the HTTP-error message hints at this.
 */

/** The full kind set the live CHECK must permit (ownership + #85 marketplace-state). */
export const REQUIRED_KINDS = ["mint", "transfer", "burn", "sale", "list", "delist"] as const;
const CONSTRAINT = "collection_event_kind_chk";
const TABLE = "svm.collection_event";

interface EnsureOpts {
  endpoint?: string;
  adminSecret?: string;
  /** Test seam: inject a run_sql executor (returns the Hasura `result` rows). */
  runSql?: (sql: string) => Promise<unknown[][]>;
  log?: (msg: string) => void;
}

function defAllowsAllKinds(def: string): boolean {
  // pg_get_constraintdef renders the CHECK as `... ARRAY['mint'::text, 'transfer'::text, ...]`,
  // so each allowed literal appears as `'<kind>'`. All required → already widened.
  return REQUIRED_KINDS.every((k) => def.includes(`'${k}'`));
}

/**
 * Ensure svm.collection_event's `kind` CHECK permits all {@link REQUIRED_KINDS}. Returns whether it
 * had to widen. Throws on a missing endpoint/secret or a run_sql failure (the caller fails loud at
 * startup rather than later poisoning a batch).
 */
export async function ensureKindConstraint(opts: EnsureOpts = {}): Promise<{ widened: boolean }> {
  const endpoint = (opts.endpoint ?? process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
  const secret = opts.adminSecret ?? process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";
  const log = opts.log ?? (() => {});

  const runSql =
    opts.runSql ??
    (async (sql: string): Promise<unknown[][]> => {
      if (!endpoint || !secret) {
        throw new Error("ensureKindConstraint: SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET required");
      }
      const res = await fetch(`${endpoint}/v2/query`, {
        method: "POST",
        headers: { "x-hasura-admin-secret": secret, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "run_sql", args: { source: "default", sql, read_only: false } }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ensureKindConstraint run_sql: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      const d = (await res.json()) as { result?: unknown[][]; error?: string };
      if (d.error) throw new Error(`ensureKindConstraint run_sql: ${d.error}`);
      return d.result ?? [];
    });

  // 1. Read the current constraint definition. Hasura run_sql returns a header row + data rows:
  //    [["pg_get_constraintdef"], ["CHECK ((kind = ANY (ARRAY['mint'::text, ...])))"]]. Absent → 1 row.
  const rows = await runSql(
    `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '${CONSTRAINT}' AND conrelid = '${TABLE}'::regclass;`,
  );
  const def = rows.length > 1 ? String((rows[1] as unknown[])[0] ?? "") : "";

  if (def && defAllowsAllKinds(def)) {
    log(`[ensure-kind-constraint] CHECK already permits ${REQUIRED_KINDS.join("/")} — no-op`);
    return { widened: false };
  }

  // 2. Widen atomically (single run_sql → one implicit tx; DROP IF EXISTS tolerates a missing/old
  // constraint). SET LOCAL lock_timeout (scoped to this tx) bounds the ACCESS EXCLUSIVE wait: if a
  // concurrent long txn holds the table lock, the ALTER fails FAST and the caller crash-loops visibly
  // (fail-loud, like the rest of the design) instead of hanging startup forever (FAGAN MINOR-1).
  await runSql(
    `SET LOCAL lock_timeout = '5s';
     ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT};
     ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT}
       CHECK (kind IN (${REQUIRED_KINDS.map((k) => `'${k}'`).join(",")}));`,
  );
  log(`[ensure-kind-constraint] widened ${TABLE}.${CONSTRAINT} to permit list/delist (#85)`);
  return { widened: true };
}
