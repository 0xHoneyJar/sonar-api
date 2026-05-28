// scripts/migration/transform.ts
//
// T-M2 — Envio → Ponder one-off data transform (copy + camelCase→snake_case
// rename + 4 type-drift conversions). Loads rows from the envio source
// (public.* PascalCase tables) into the ponder target (ponder.* snake_case
// tables) per grimoires/loa/migration/t-m1-entity-column-map.yaml.
//
// THIS IS A ONE-OFF (envio is being retired — see migration spec §1). It is
// NOT reusable migration tooling.
//
// ── Connections (env-var ONLY — never hardcoded, never defaulted to prod) ──
//   SRC_DATABASE_URL  — envio source (read).   In prod = blue Postgres-3vIC.
//   DST_DATABASE_URL  — ponder target (write). In prod = Postgres-vRR1.
// The transform NEVER reads a prod URL from .env/Railway/anywhere on its own.
// The operator supplies these explicitly for each run.
//
// ── Modes ──
//   --dry-run     READ-ONLY. Connects to SRC (and DST read-only for table
//                 existence), prints per-entity source counts + planned ops,
//                 writes NOTHING.
//   (default)     Real run. For each entity: DISABLE TRIGGER USER → keyset-
//                 paginated batched UPSERT ON CONFLICT (id) DO UPDATE →
//                 ENABLE TRIGGER USER. Idempotent (re-run = identical).
//
// ── Load constraints (migration spec Appendix B — MANDATORY) ──
//   - Empty-boot-first: ponder MUST have already booted once on the empty
//     target schema so it owns the tables + _ponder_meta + _ponder_checkpoint
//     + build_id. This transform does NOT create tables and does NOT boot
//     ponder. It asserts the target tables exist; if not, it errors (the
//     operator must boot ponder empty first — documented in the dry-run plan).
//   - Triggers-off bulk load: ponder installs `reorg` + `live_query` per-row
//     triggers; an external INSERT with `live_query` ON fails outright, and
//     `reorg` would make frozen rows reorg-revertable. So we DISABLE TRIGGER
//     USER around the load and re-enable after.
//
// Usage:
//   SRC_DATABASE_URL=... DST_DATABASE_URL=... tsx scripts/migration/transform.ts --dry-run
//   SRC_DATABASE_URL=... DST_DATABASE_URL=... tsx scripts/migration/transform.ts
//   ... --only badge_holder,mibera_loan       (subset of ponder tables)
//   ... --batch 5000                           (rows per batch; default 5000)
//   ... --src-schema public --dst-schema ponder

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "./pg";
import type { Pool as PoolT, PoolClient } from "./pg";
import {
  loadEntityMap,
  type EntityMap,
  type ColumnMap,
} from "./entity-map";

// ── arg parsing ────────────────────────────────────────────────────────────
interface Args {
  dryRun: boolean;
  only: string[] | null;
  batch: number;
  srcSchema: string;
  dstSchema: string;
  onConflict: "update" | "nothing";
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    only: null,
    batch: 5000,
    srcSchema: "public",
    dstSchema: "ponder",
    onConflict: "update",
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === "--only") a.only = argv[++i].split(",").map((s) => s.trim());
    else if (t === "--batch") a.batch = Number(argv[++i]);
    else if (t === "--src-schema") a.srcSchema = argv[++i];
    else if (t === "--dst-schema") a.dstSchema = argv[++i];
    else if (t === "--on-conflict") {
      const v = argv[++i];
      if (v !== "update" && v !== "nothing")
        throw new Error(`--on-conflict must be update|nothing, got ${v}`);
      a.onConflict = v;
    } else throw new Error(`unknown arg: ${t}`);
  }
  if (!Number.isFinite(a.batch) || a.batch < 1)
    throw new Error(`--batch must be a positive integer`);
  return a;
}

// ── identifier quoting ──────────────────────────────────────────────────────
const qIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const qSchemaTable = (schema: string, table: string) =>
  `${qIdent(schema)}.${qIdent(table)}`;

// ── type-drift converters (migration spec Appendix C — the 4 NON-renames) ──
// `pg` returns:
//   - jsonb columns as already-parsed JS values (default jsonb parser)
//   - numeric[] / bigint[] columns: we force a text-array parse below so each
//     element is a STRING (no float precision loss on uint256-scale ids).
function jsonbToText(v: unknown): string {
  // badge_holder.holdings — envio jsonb -> ponder text: serialize JSON to string.
  if (v === null || v === undefined) return v as unknown as string;
  if (typeof v === "string") return v; // already a JSON string (text-mode parse)
  return JSON.stringify(v);
}

function arrayToJsonText(v: unknown): string {
  // mibera_loan.token_ids / paddle_pawn.nft_ids / paddle_liquidation.nft_ids
  // envio bigint[] -> ponder text: JSON.stringify(ids.map(String)).
  // MUST yield ["1","2"], NOT a pg `::text` cast which yields {1,2}.
  if (v === null || v === undefined) return v as unknown as string;
  const arr = Array.isArray(v) ? v : parsePgArrayLiteral(String(v));
  return JSON.stringify(arr.map((x) => String(x)));
}

// Fallback: parse a pg array literal like `{1,2,3}` into ["1","2","3"].
// Only used if the driver hands us the raw literal instead of a JS array.
function parsePgArrayLiteral(lit: string): string[] {
  const inner = lit.trim().replace(/^\{/, "").replace(/\}$/, "");
  if (inner === "") return [];
  // numeric arrays never contain quotes/commas-in-values, so a plain split is safe.
  return inner.split(",").map((s) => s.trim());
}

function convert(col: ColumnMap, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col.transform) {
    case "jsonb_to_text":
      return jsonbToText(value);
    case "array_to_json_text":
      return arrayToJsonText(value);
    case "rename":
    default:
      // pure rename — pass the value through. pg has already typed it
      // (numeric->string, bigint->string, integer->number, boolean->boolean,
      // text->string). The DST column type accepts the same representation.
      return value;
  }
}

// ── SELECT builder (keyset pagination on text PK `id`) ──────────────────────
// Reading numeric/array columns: we ask pg for text representation of arrays so
// elements survive as strings. The simplest robust approach: cast array columns
// to text[] in SQL (element-wise ::text), which the driver parses to string[].
function buildSelect(e: EntityMap, srcSchema: string): string {
  const sel = e.columns
    .map((c) => {
      const src = qIdent(c.envio);
      if (c.transform === "array_to_json_text") {
        // numeric[]::text[] -> driver parses to JS string[] (uint256-safe).
        return `${src}::text[] AS ${qIdent(c.envio)}`;
      }
      if (c.transform === "jsonb_to_text") {
        // jsonb -> text via ::text so we receive a JSON string directly.
        return `${src}::text AS ${qIdent(c.envio)}`;
      }
      // numeric/bigint columns: cast to text so large uint256 values survive
      // without float coercion; the DST numeric/bigint column accepts the
      // string form on insert.
      const t = c.envio_type.toLowerCase();
      if (t.includes("numeric") || t.includes("bigint")) {
        return `${src}::text AS ${qIdent(c.envio)}`;
      }
      return `${src} AS ${qIdent(c.envio)}`;
    })
    .join(", ");
  return `SELECT ${sel} FROM ${qSchemaTable(srcSchema, e.envio_table)} WHERE "id" > $1 ORDER BY "id" ASC LIMIT $2`;
}

// ── INSERT builder (multi-row, ON CONFLICT (id) DO UPDATE/NOTHING) ──────────
function buildInsert(
  e: EntityMap,
  dstSchema: string,
  rowCount: number,
  onConflict: "update" | "nothing",
): string {
  const cols = e.columns.map((c) => c.ponder);
  const colList = cols.map(qIdent).join(", ");
  const params: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const tuple = cols.map(() => `$${p++}`).join(", ");
    params.push(`(${tuple})`);
  }
  let conflict: string;
  if (onConflict === "nothing") {
    conflict = `ON CONFLICT ("id") DO NOTHING`;
  } else {
    // DO UPDATE over every non-PK column → second run is byte-identical.
    const setList = cols
      .filter((c) => c !== "id")
      .map((c) => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`)
      .join(", ");
    conflict = `ON CONFLICT ("id") DO UPDATE SET ${setList}`;
  }
  return `INSERT INTO ${qSchemaTable(dstSchema, e.ponder_table)} (${colList}) VALUES ${params.join(", ")} ${conflict}`;
}

function rowToParams(e: EntityMap, row: Record<string, unknown>): unknown[] {
  return e.columns.map((c) => convert(c, row[c.envio]));
}

// ── per-entity load ──────────────────────────────────────────────────────
interface EntityResult {
  entity: string;
  sourceCount: number;
  rowsWritten: number;
  postCount: number;
  skipped?: string;
}

async function tableExists(
  pool: PoolT,
  schema: string,
  table: string,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return r.rowCount! > 0;
}

async function count(
  pool: PoolT,
  schema: string,
  table: string,
): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::bigint AS n FROM ${qSchemaTable(schema, table)}`,
  );
  return Number(r.rows[0].n);
}

async function loadEntity(
  src: PoolT,
  dst: PoolT,
  e: EntityMap,
  args: Args,
): Promise<EntityResult> {
  const sourceCount = await count(src, args.srcSchema, e.envio_table);

  if (args.dryRun) {
    return {
      entity: e.ponder_table,
      sourceCount,
      rowsWritten: 0,
      postCount: -1, // not measured in dry-run
    };
  }

  // real run — use ONE dedicated client for the trigger toggle + load so the
  // DISABLE/ENABLE is scoped to this session and survives across batches.
  const client: PoolClient = await dst.connect();
  let rowsWritten = 0;
  try {
    await client.query(
      `ALTER TABLE ${qSchemaTable(args.dstSchema, e.ponder_table)} DISABLE TRIGGER USER`,
    );

    const selectSql = buildSelect(e, args.srcSchema);
    let cursor = ""; // text PK; "" sorts before any real id
    // Stable insert statement is rebuilt per batch (row count varies on last batch).
    for (;;) {
      const page = await src.query(selectSql, [cursor, args.batch]);
      if (page.rowCount === 0) break;
      const rows = page.rows as Record<string, unknown>[];

      const insertSql = buildInsert(e, args.dstSchema, rows.length, args.onConflict);
      const flatParams: unknown[] = [];
      for (const row of rows) flatParams.push(...rowToParams(e, row));
      const ins = await client.query(insertSql, flatParams);
      rowsWritten += ins.rowCount ?? 0;

      cursor = String(rows[rows.length - 1]["id"]);
      if (rows.length < args.batch) break;
    }
  } finally {
    // ALWAYS re-enable, even on error.
    await client.query(
      `ALTER TABLE ${qSchemaTable(args.dstSchema, e.ponder_table)} ENABLE TRIGGER USER`,
    );
    client.release();
  }

  const postCount = await count(dst, args.dstSchema, e.ponder_table);
  return { entity: e.ponder_table, sourceCount, rowsWritten, postCount };
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const SRC = process.env.SRC_DATABASE_URL;
  const DST = process.env.DST_DATABASE_URL;
  if (!SRC) throw new Error("SRC_DATABASE_URL is required (envio source, read).");
  if (!DST)
    throw new Error("DST_DATABASE_URL is required (ponder target). In --dry-run it is opened READ-ONLY.");

  // Safety: refuse obvious prod hostnames so a fat-fingered run can't hit prod.
  // (The transform never *fetches* prod URLs; this is belt-and-suspenders for
  // the operator-supplied values.)
  for (const [name, url] of [["SRC", SRC], ["DST", DST]] as const) {
    if (/3vic|vrr1/i.test(url) && process.env.TM2_ALLOW_PROD !== "I_UNDERSTAND") {
      throw new Error(
        `${name}_DATABASE_URL appears to point at a production Postgres (3vIC/vRR1). ` +
          `T-M2 scratch/dry-run must not connect to prod. The PROD run is a separate ` +
          `operator-paired session. Refusing.`,
      );
    }
  }

  const doc = loadEntityMap();
  let entities = doc.entities;
  if (args.only) {
    const want = new Set(args.only);
    entities = entities.filter(
      (e) => want.has(e.ponder_table) || want.has(e.envio_table),
    );
    if (entities.length === 0)
      throw new Error(`--only matched no entities: ${args.only.join(",")}`);
  }

  console.log(
    `T-M2 transform — mode=${args.dryRun ? "DRY-RUN (read-only)" : "REAL"} ` +
      `entities=${entities.length}/${doc.entities.length} batch=${args.batch} ` +
      `onConflict=${args.onConflict} src.${args.srcSchema} → dst.${args.dstSchema}`,
  );

  const src = new Pool({ connectionString: SRC, application_name: "tm2-transform-src" });
  const dst = new Pool({ connectionString: DST, application_name: "tm2-transform-dst" });

  // Force numeric arrays to come back as JS arrays of strings (pg parses
  // ::text[] casts natively; this is just defensive for non-cast paths).

  const results: EntityResult[] = [];
  try {
    // Preflight: assert empty-boot prerequisite — every target table must exist.
    const missing: string[] = [];
    for (const e of entities) {
      if (!(await tableExists(dst, args.dstSchema, e.ponder_table)))
        missing.push(`${args.dstSchema}.${e.ponder_table}`);
    }
    if (missing.length) {
      throw new Error(
        `Empty-boot prerequisite FAILED: ${missing.length} target table(s) do not exist:\n  ` +
          missing.join("\n  ") +
          `\nPonder must boot ONCE on the empty target schema first (it creates the ` +
          `tables + _ponder_meta + _ponder_checkpoint + build_id). See the dry-run plan.`,
      );
    }

    for (const e of entities) {
      try {
        const r = await loadEntity(src, dst, e, args);
        results.push(r);
        if (args.dryRun) {
          console.log(
            `  [dry-run] ${r.entity.padEnd(28)} src=${r.sourceCount.toString().padStart(10)} ` +
              `→ would UPSERT (ON CONFLICT id DO ${args.onConflict.toUpperCase()}) ` +
              `[triggers OFF during load]`,
          );
        } else {
          const ok = r.postCount >= r.sourceCount ? "OK" : "CHECK";
          console.log(
            `  ${r.entity.padEnd(28)} src=${r.sourceCount.toString().padStart(10)} ` +
              `written=${r.rowsWritten.toString().padStart(10)} ` +
              `post=${r.postCount.toString().padStart(10)} [${ok}]`,
          );
        }
      } catch (err) {
        console.error(`  ERROR on ${e.ponder_table}: ${(err as Error).message}`);
        throw err;
      }
    }
  } finally {
    await src.end();
    await dst.end();
  }

  // summary
  const totalSrc = results.reduce((a, r) => a + r.sourceCount, 0);
  const totalWritten = results.reduce((a, r) => a + r.rowsWritten, 0);
  console.log(
    `\nDONE. entities=${results.length} total_source_rows=${totalSrc}` +
      (args.dryRun ? " (dry-run: nothing written)" : ` total_written=${totalWritten}`),
  );
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error("\nFATAL:", err.message);
    process.exit(1);
  });
}

export { parseArgs, buildSelect, buildInsert, convert, jsonbToText, arrayToJsonText };
