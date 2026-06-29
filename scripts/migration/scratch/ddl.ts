// scripts/migration/scratch/ddl.ts
//
// Builds scratch DDL for a representative SUBSET of entities, driven by the
// T-M1 map so the synthetic schema's column types match the real ones.
//
//   SOURCE (envio):  public."<PascalTable>" with camelCase columns + the real
//                    envio types (jsonb / numeric[] / numeric / integer / text /
//                    boolean). Mirrors envio's HyperIndex Postgres shape.
//   TARGET (ponder): ponder.<snake_table> with snake_case columns + the real
//                    ponder types (text / numeric(78,0) / bigint / integer /
//                    boolean), PLUS two USER triggers named like ponder's
//                    `reorg` + `live_query` so the DISABLE/ENABLE TRIGGER USER
//                    cycle is genuinely exercised.
//
// This is SCRATCH-ONLY. The real target tables are created by ponder itself
// (empty-boot-first, Appendix B) — the transform never issues DDL in prod.

import {
  loadEntityMap,
  type EntityMap,
  type ColumnMap,
} from "../entity-map";

// Representative subset (covers every required validation surface):
//   badge_holder       — jsonb→text drift; additive-rollup (no-handler)
//   mibera_loan        — bigint[]→text drift; rollup-lww
//   paddle_pawn        — bigint[]→text drift; append-only
//   paddle_liquidation — bigint[]→text drift; append-only
//   mibera_transfer    — append-only (onConflictDoNothing) — overlap-safe class
//   tracked_holder     — additive-rollup (boundary-exactly) — overlap-sensitive
//   action             — largest real table (2.4M); used here to exercise batching
export const SCRATCH_SUBSET = [
  "badge_holder",
  "mibera_loan",
  "paddle_pawn",
  "paddle_liquidation",
  "mibera_transfer",
  "tracked_holder",
  "action",
];

// ── map the map's prose types to concrete pg DDL types ──
function envioPgType(c: ColumnMap): string {
  const t = c.envio_type.toLowerCase();
  if (c.transform === "jsonb_to_text") return "jsonb";
  if (c.transform === "array_to_json_text") return "numeric[]"; // envio bigint[] == pg numeric[]
  if (t.includes("integer") || t.includes("int4")) return "integer";
  if (t.includes("boolean")) return "boolean";
  if (t.includes("numeric") || t.includes("bigint")) return "numeric";
  return "text"; // text / hex-as-text
}

function ponderPgType(c: ColumnMap): string {
  const t = c.ponder_type.toLowerCase();
  if (c.transform === "jsonb_to_text" || c.transform === "array_to_json_text")
    return "text";
  if (t.includes("integer") || t.includes("int4")) return "integer";
  if (t.includes("boolean")) return "boolean";
  if (t.includes("numeric")) return "numeric(78,0)";
  if (t.includes("bigint") || t.includes("int8")) return "bigint";
  return "text";
}

const nullableOf = (typeStr: string) =>
  /not null/i.test(typeStr) ? " NOT NULL" : "";

const qIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function buildSourceDDL(entities: EntityMap[]): string {
  const stmts: string[] = [`CREATE SCHEMA IF NOT EXISTS public;`];
  for (const e of entities) {
    const cols = e.columns
      .map((c) => {
        const pk = c.ponder === "id" ? " PRIMARY KEY" : "";
        return `  ${qIdent(c.envio)} ${envioPgType(c)}${nullableOf(c.envio_type)}${pk}`;
      })
      .join(",\n");
    stmts.push(
      `DROP TABLE IF EXISTS public.${qIdent(e.envio_table)};\nCREATE TABLE public.${qIdent(e.envio_table)} (\n${cols}\n);`,
    );
  }
  return stmts.join("\n\n");
}

export function buildTargetDDL(entities: EntityMap[]): string {
  const stmts: string[] = [`CREATE SCHEMA IF NOT EXISTS ponder;`];
  // A trivial trigger function that mimics the SHAPE of ponder's per-row
  // triggers. The `live_query`-style one RAISES on direct external INSERT
  // (matching Appendix B: "an external INSERT with it on fails outright"),
  // which is exactly what the DISABLE TRIGGER USER cycle must suppress.
  stmts.push(`
CREATE OR REPLACE FUNCTION ponder._scratch_live_query() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'live_query trigger: external INSERT refused (ponder-session-only relation missing)';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ponder._scratch_reorg() RETURNS trigger AS $$
BEGIN
  -- ponder's reorg trigger records ops into _reorg__<table>; here a no-op
  -- that merely PROVES a USER trigger fires (and is disabled by the cycle).
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`);

  for (const e of entities) {
    const cols = e.columns
      .map((c) => {
        const pk = c.ponder === "id" ? " PRIMARY KEY" : "";
        return `  ${qIdent(c.ponder)} ${ponderPgType(c)}${nullableOf(c.ponder_type)}${pk}`;
      })
      .join(",\n");
    const tbl = `ponder.${qIdent(e.ponder_table)}`;
    stmts.push(
      `DROP TABLE IF EXISTS ${tbl} CASCADE;\nCREATE TABLE ${tbl} (\n${cols}\n);`,
    );
    // Attach the two ponder-shaped USER triggers.
    stmts.push(
      `CREATE TRIGGER "reorg" AFTER INSERT OR UPDATE OR DELETE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ponder._scratch_reorg();`,
    );
    stmts.push(
      `CREATE TRIGGER "live_query" BEFORE INSERT ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ponder._scratch_live_query();`,
    );
  }
  return stmts.join("\n\n");
}

export function subsetEntities(only: string[]): EntityMap[] {
  const doc = loadEntityMap();
  const want = new Set(only);
  return doc.entities.filter((e) => want.has(e.ponder_table));
}
