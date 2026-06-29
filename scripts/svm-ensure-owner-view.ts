#!/usr/bin/env tsx
/**
 * svm-ensure-owner-view.ts — deploy the event-derived beneficial-owner view (idempotent, re-runnable).
 *   1. apply migrations/svm/001_collection_owner_derived.sql (CREATE OR REPLACE VIEW)
 *   2. pg_track_table + a SELECT-only public permission at the belt-gateway
 * Mirrors src/labels/ensure-schema.ts. Uses the same Hasura env the SVM webhook/indexers use.
 *   SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET   (injected by `railway run --service svm-webhook`)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";
if (!HASURA || !SECRET) throw new Error("SVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET required");

async function runSql(sql: string): Promise<void> {
  const r = await fetch(`${HASURA}/v2/query`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify({ type: "run_sql", args: { source: "default", sql, read_only: false } }),
  });
  if (!r.ok) throw new Error(`run_sql ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function meta(type: string, args: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${HASURA}/v1/metadata`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify({ type, args }),
  });
  if (!r.ok) {
    const b = await r.text();
    if (!/already.(tracked|exists|defined)/i.test(b)) throw new Error(`metadata ${type} ${r.status}: ${b.slice(0, 200)}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
await runSql(readFileSync(join(here, "../migrations/svm/001_collection_owner_derived.sql"), "utf8"));
const table = { schema: "svm", name: "collection_owner_derived" };
await meta("pg_track_table", { source: "default", table });
await meta("pg_create_select_permission", {
  source: "default",
  table,
  role: "public",
  permission: { columns: "*", filter: {}, allow_aggregations: true },
});
console.log("deployed + tracked: svm.collection_owner_derived (SELECT-only public)");
