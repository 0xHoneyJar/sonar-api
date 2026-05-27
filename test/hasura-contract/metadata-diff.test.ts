// test/hasura-contract/metadata-diff.test.ts
//
// T-A3.3 — Hasura metadata diff test.
//
// Per SDD §4.3 + COOKBOOK §C-6. Captures the Hasura metadata BEFORE and AFTER
// cutover and asserts the expected divergence pattern:
//
//   - SCHEMA NAMESPACE: must flip "public" → "ponder" on the swapped tables.
//   - CUSTOM ROOT FIELDS: must appear (post-cutover) baked into each table to
//     remap `ponder_X` → unprefixed `X`. (cookbook §C-6 — the load-bearing fix.)
//   - RELATIONSHIPS: count must NOT change (zero relationships dropped).
//   - PERMISSIONS: per-role per-table permission keys MUST be identical
//     (the cutover script must preserve them via replace_metadata).
//
// Inputs:
//   HASURA_BEFORE_METADATA_PATH — JSON file: metadata snapshot pre-cutover
//   HASURA_AFTER_METADATA_PATH  — JSON file: metadata snapshot post-cutover
// OR (live mode):
//   HASURA_URL + HASURA_ADMIN_SECRET — runs export_metadata once and the
//   operator must invoke the test twice with snapshot writes around the
//   cutover. The runbook (docs/A-3-staging-dryrun-runbook.md) walks this.
//
// Suite skips cleanly when neither path nor URL is provided.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const BEFORE_PATH = process.env.HASURA_BEFORE_METADATA_PATH;
const AFTER_PATH = process.env.HASURA_AFTER_METADATA_PATH;

// snake_to_pascal — TS mirror of the jq def in scripts/cutover-hasura-tracking.sh.
// Maps Ponder's snake_case Postgres table names to PascalCase GraphQL root
// fields (`mint_event` → `MintEvent`). The assertion below pins this mapping
// so the test refuses to pass unless the cutover script bakes the correct
// remap (closes runbook §Flag 1, CRITICAL load-bearing).
function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((p) => (p.length === 0 ? "" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

interface MetadataTable {
  table: { schema: string; name: string };
  configuration?: {
    custom_root_fields?: Record<string, string>;
    custom_name?: string;
  };
  object_relationships?: unknown[];
  array_relationships?: unknown[];
  select_permissions?: Array<{ role: string }>;
  insert_permissions?: Array<{ role: string }>;
  update_permissions?: Array<{ role: string }>;
  delete_permissions?: Array<{ role: string }>;
}

interface MetadataDoc {
  metadata?: {
    sources?: Array<{ name: string; tables: MetadataTable[] }>;
  };
  // export_metadata returns { resource_version, metadata } OR raw metadata
  // depending on Hasura version. We accept either shape via .metadata or root.
  sources?: Array<{ name: string; tables: MetadataTable[] }>;
}

function loadMetadata(path: string): MetadataDoc {
  if (!existsSync(path)) {
    throw new Error(`Metadata snapshot not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as MetadataDoc;
}

function extractTables(doc: MetadataDoc): MetadataTable[] {
  const sources = doc.metadata?.sources ?? doc.sources ?? [];
  return sources.flatMap((s) => s.tables ?? []);
}

function tableKey(t: MetadataTable): string {
  return t.table.name;
}

function permissionRoleSet(t: MetadataTable): {
  select: string[];
  insert: string[];
  update: string[];
  delete: string[];
} {
  return {
    select: (t.select_permissions ?? []).map((p) => p.role).sort(),
    insert: (t.insert_permissions ?? []).map((p) => p.role).sort(),
    update: (t.update_permissions ?? []).map((p) => p.role).sort(),
    delete: (t.delete_permissions ?? []).map((p) => p.role).sort(),
  };
}

function relationshipCount(t: MetadataTable): number {
  return (t.object_relationships?.length ?? 0) + (t.array_relationships?.length ?? 0);
}

describe.skipIf(!BEFORE_PATH || !AFTER_PATH)("Hasura metadata-diff (T-A3.3)", () => {
  // Vitest's describe.skipIf still evaluates the describe body — the skip
  // applies to tests, not setup. Defer all file loads to beforeAll so the
  // tests can be discovered (and skipped) without throwing at collection time.
  let beforeTables: MetadataTable[] = [];
  let afterTables: MetadataTable[] = [];
  let beforeByName: Map<string, MetadataTable> = new Map();
  let afterByName: Map<string, MetadataTable> = new Map();

  beforeAll(() => {
    beforeTables = extractTables(loadMetadata(BEFORE_PATH!));
    afterTables = extractTables(loadMetadata(AFTER_PATH!));
    beforeByName = new Map(beforeTables.map((t) => [tableKey(t), t]));
    afterByName = new Map(afterTables.map((t) => [tableKey(t), t]));
  });

  it("captures both metadata snapshots", () => {
    expect(beforeTables.length, "before snapshot empty").toBeGreaterThan(0);
    expect(afterTables.length, "after snapshot empty").toBeGreaterThan(0);
  });

  it("flips schema namespace public → ponder on all tracked tables", () => {
    // Find tables with the same name in both.
    const common = [...beforeByName.keys()].filter((n) => afterByName.has(n));
    expect(common.length, "no overlap between before/after").toBeGreaterThan(0);

    const flipped: string[] = [];
    const stuck: string[] = [];
    for (const name of common) {
      const b = beforeByName.get(name)!;
      const a = afterByName.get(name)!;
      if (b.table.schema === "public" && a.table.schema === "ponder") {
        flipped.push(name);
      } else if (b.table.schema === a.table.schema) {
        stuck.push(name);
      }
    }
    expect(flipped.length, "no tables flipped public → ponder").toBeGreaterThan(0);
    expect(
      stuck,
      `tables stuck on same schema (should have flipped): ${stuck.join(",")}`,
    ).toEqual([]);
  });

  it("adds custom_root_fields on every post-cutover table (cookbook §C-6)", () => {
    // Stricter than the original "select == table.name" shape check: every
    // tracked ponder table must remap ALL 8 root fields to the PascalCase
    // (`MintEvent`) form, not the snake_case Postgres name (`mint_event`).
    // This is the assertion that closes runbook §Flag 1 — without the
    // snake_to_pascal jq transform in cutover-hasura-tracking.sh, consumer
    // queries like `{ MintEvent { ... } }` 404 because Hasura would expose
    // `mint_event` instead.
    const missing: string[] = [];
    for (const t of afterTables) {
      if (t.table.schema !== "ponder") continue;
      const crf = t.configuration?.custom_root_fields;
      const pascal = snakeToPascal(t.table.name);
      if (!crf) {
        missing.push(`${t.table.name} (no custom_root_fields)`);
        continue;
      }
      const expected: Record<string, string> = {
        select: pascal,
        select_by_pk: `${pascal}_by_pk`,
        select_aggregate: `${pascal}_aggregate`,
        insert: `insert_${pascal}`,
        insert_one: `insert_${pascal}_one`,
        update: `update_${pascal}`,
        update_by_pk: `update_${pascal}_by_pk`,
        delete: `delete_${pascal}`,
        delete_by_pk: `delete_${pascal}_by_pk`,
      };
      for (const [field, want] of Object.entries(expected)) {
        const got = crf[field];
        if (got !== want) {
          missing.push(`${t.table.name}.${field} expected=${want} got=${got ?? "<unset>"}`);
        }
      }
      // custom_name must ALSO be PascalCase — Hasura uses it for the GraphQL
      // type name (the value returned in `{ MintEvent { __typename } }`).
      if (t.configuration?.custom_name !== pascal) {
        missing.push(
          `${t.table.name}.custom_name expected=${pascal} got=${t.configuration?.custom_name ?? "<unset>"}`,
        );
      }
    }
    expect(
      missing,
      `tables missing/mismatched custom_root_fields after cutover (PascalCase remap):\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("preserves relationship count per common table (zero dropped)", () => {
    const drift: Array<{ table: string; before: number; after: number }> = [];
    for (const name of beforeByName.keys()) {
      if (!afterByName.has(name)) continue;
      const b = relationshipCount(beforeByName.get(name)!);
      const a = relationshipCount(afterByName.get(name)!);
      if (b !== a) drift.push({ table: name, before: b, after: a });
    }
    expect(drift, `relationship count drift: ${JSON.stringify(drift)}`).toEqual([]);
  });

  it("preserves per-role permission set per common table", () => {
    const drift: Array<{ table: string; before: unknown; after: unknown }> = [];
    for (const name of beforeByName.keys()) {
      if (!afterByName.has(name)) continue;
      const b = permissionRoleSet(beforeByName.get(name)!);
      const a = permissionRoleSet(afterByName.get(name)!);
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        drift.push({ table: name, before: b, after: a });
      }
    }
    expect(drift, `permission drift: ${JSON.stringify(drift)}`).toEqual([]);
  });
});
