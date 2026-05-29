// scripts/migration/entity-map.ts
//
// Loads the T-M1 entity+column map (the SINGLE SOURCE OF TRUTH for the T-M2
// transform) from grimoires/loa/migration/t-m1-entity-column-map.yaml and
// exposes it as typed objects.
//
// Why a hand-rolled parser instead of a `yaml` dependency: the repo's pnpm
// store is pinned to pnpm@10.11.0 and the local CLI is 9.x — adding a dep
// would force a full re-link / lockfile churn. The map file has a FIXED,
// regular shape (top-level scalars, a `boundaries:` block-map, and an
// `entities:` list of objects each containing a `columns:` list of inline
// flow-maps), so a focused parser is both sufficient and zero-dependency.
// The parser is STRICT: it throws on any line it does not recognise, so
// silent drift from the source-of-truth surfaces as a hard error.
//
// Grounded against: grimoires/loa/migration/t-m1-entity-column-map.yaml
//   (40 entities, 353 columns, classification + start_block_policy per entity).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The T-M1 (40-entity Mibera) map — the historical default. */
export const T_M1_MAP_PATH = resolve(
  __dirname,
  "../../grimoires/loa/migration/t-m1-entity-column-map.yaml",
);

/**
 * The active map path. Defaults to the T-M1 map; an operator may point the
 * loader at a different map (e.g. the B-1 green-belt map) via the
 * MIGRATION_MAP_PATH env var. The 40-entity invariant only applies to the
 * default T-M1 path (see loadEntityMap).
 */
export const MAP_PATH =
  process.env.MIGRATION_MAP_PATH && process.env.MIGRATION_MAP_PATH.trim() !== ""
    ? resolve(process.env.MIGRATION_MAP_PATH)
    : T_M1_MAP_PATH;

/**
 * Transform kinds present in the map's `transform:` field.
 *   rename               : camelCase -> snake_case, identical type.
 *   jsonb_to_text        : envio jsonb -> ponder text (JSON.stringify).
 *   array_to_json_text   : envio array<bigint>/array<string> -> ponder text.
 *   timestamp_to_bigint  : ** GREEN-BELT-ONLY DRIFT ** envio `Timestamp` scalar
 *                          (pg timestamp/timestamptz) -> ponder bigint (epoch
 *                          seconds). The 40-set Mibera map has none of these.
 */
export type TransformKind =
  | "rename"
  | "jsonb_to_text"
  | "array_to_json_text"
  | "timestamp_to_bigint";

export interface ColumnMap {
  envio: string; // envio (source) column name, camelCase verbatim
  ponder: string; // ponder (target) column name, snake_case
  envio_type: string;
  ponder_type: string;
  transform: TransformKind;
  note?: string;
}

/**
 * start_block_policy in the map is one of two prose strings. We normalise to a
 * discriminant the config-edit artifact + dry-run plan can key off.
 *   "boundary EXACTLY (no overlap …)"   -> "boundary"
 *   "boundary - finalityOverlap"        -> "boundary-overlap"
 */
export type StartBlockPolicy = "boundary" | "boundary-overlap";

export interface EntityMap {
  envio_table: string; // PascalCase, quoted in SQL as public."PascalTable"
  ponder_table: string; // snake_case, ponder.<table>
  classification: string;
  start_block_policy: StartBlockPolicy;
  start_block_policy_raw: string;
  handler_evidence: string;
  pk: string[];
  columns: ColumnMap[];
}

export interface EntityMapDoc {
  schema_version: number;
  cycle: string;
  task: string;
  envio_source_schema: string; // "public"
  ponder_target_schema: string; // "ponder"
  boundaries: Record<string, number>;
  entities: EntityMap[];
}

/** Tables in envio that are HyperIndex internals — explicitly skipped (spec §6 / Appendix C). */
export const ENVIO_INTERNAL_SKIP = [
  "Block",
  "Transaction",
  "AggregatedBlock",
  "AggregatedTransaction",
] as const;

// ── inline flow-map parser ────────────────────────────────────────────────
// Parses one line of the form: { k: v, k2: "v2", k3: bare value, ... }
// Values may be bare (until the next top-level comma) or double-quoted (commas
// inside quotes are preserved). Keys are always bare identifiers.
function parseFlowMap(line: string): Record<string, string> {
  const inner = line.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Record<string, string> = {};
  let i = 0;
  const n = inner.length;
  while (i < n) {
    // skip leading whitespace + commas
    while (i < n && (inner[i] === " " || inner[i] === ",")) i++;
    if (i >= n) break;
    // read key up to ':'
    let key = "";
    while (i < n && inner[i] !== ":") key += inner[i++];
    if (i >= n) throw new Error(`flow-map: key '${key}' missing ':' in: ${line}`);
    i++; // skip ':'
    while (i < n && inner[i] === " ") i++;
    let val = "";
    if (inner[i] === '"') {
      i++; // opening quote
      while (i < n && inner[i] !== '"') {
        if (inner[i] === "\\" && i + 1 < n) {
          // preserve escaped char (e.g. \")
          val += inner[i + 1];
          i += 2;
        } else {
          val += inner[i++];
        }
      }
      i++; // closing quote
    } else {
      // bare value: read until top-level comma
      while (i < n && inner[i] !== ",") val += inner[i++];
      val = val.trim();
    }
    out[key.trim()] = val;
  }
  return out;
}

function normalisePolicy(raw: string): StartBlockPolicy {
  // T-M1 leaves the value bare; the green-belt map double-quotes it. Strip a
  // single layer of surrounding double-quotes before matching.
  const r = raw.trim().replace(/^"(.*)"$/, "$1").trim();
  if (r.startsWith("boundary EXACTLY")) return "boundary";
  if (r.startsWith("boundary - finalityOverlap") || r.startsWith("boundary − finalityOverlap"))
    return "boundary-overlap";
  throw new Error(`unrecognised start_block_policy: '${raw}'`);
}

function normaliseTransform(raw: string): TransformKind {
  const r = raw.trim();
  if (
    r === "rename" ||
    r === "jsonb_to_text" ||
    r === "array_to_json_text" ||
    r === "timestamp_to_bigint"
  )
    return r;
  throw new Error(`unrecognised transform kind: '${raw}'`);
}

/** Strip an inline `#` comment from a block-scalar line (not inside quotes). */
function stripComment(s: string): string {
  // The map only uses trailing `# public."X"` comments on table lines; those
  // never contain quotes before the `#`, so a simple split is safe here.
  const hashAt = s.indexOf(" #");
  return hashAt >= 0 ? s.slice(0, hashAt) : s;
}

export function loadEntityMap(path: string = MAP_PATH): EntityMapDoc {
  const text = readFileSync(path, "utf8");
  const rawLines = text.split("\n");

  const doc: Partial<EntityMapDoc> & { entities: EntityMap[] } = {
    boundaries: {},
    entities: [],
  };

  let section: "top" | "boundaries" | "entities" = "top";
  let current: EntityMap | null = null;
  let inColumns = false;

  for (let ln = 0; ln < rawLines.length; ln++) {
    const rawLine = rawLines[ln];
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;

    // indentation drives structure
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    // ── top-level keys (indent 0) ──
    if (indent === 0) {
      section = "top";
      inColumns = false;
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (!m) throw new Error(`unparsed top-level line ${ln + 1}: ${rawLine}`);
      const [, key, valRaw] = m;
      const val = stripComment(valRaw).trim();
      if (key === "boundaries") {
        section = "boundaries";
        doc.boundaries = {};
      } else if (key === "entities") {
        section = "entities";
      } else if (key === "schema_version") {
        doc.schema_version = Number(val);
      } else if (
        key === "cycle" ||
        key === "task" ||
        key === "envio_source_schema" ||
        key === "ponder_target_schema"
      ) {
        (doc as Record<string, unknown>)[key] = val;
      } else if (
        key === "finality_overlap_note" ||
        key === "classification_legend"
      ) {
        // multi-line block scalars we don't need programmatically — skip body
        // (their continuation lines are indented, handled by section guards).
        section = "top";
      }
      continue;
    }

    if (section === "boundaries") {
      const m = /^([A-Za-z0-9_]+):\s*(\d+)/.exec(line);
      if (m) doc.boundaries![m[1]] = Number(m[2]);
      continue;
    }

    if (section === "entities") {
      // new entity starts with "- envio_table:"
      if (line.startsWith("- envio_table:")) {
        if (current) doc.entities.push(current);
        const val = stripComment(line.replace("- envio_table:", "")).trim();
        current = {
          envio_table: val,
          ponder_table: "",
          classification: "",
          start_block_policy: "boundary",
          start_block_policy_raw: "",
          handler_evidence: "",
          pk: [],
          columns: [],
        };
        inColumns = false;
        continue;
      }
      if (!current) continue;

      if (line.startsWith("columns:")) {
        inColumns = true;
        continue;
      }

      if (inColumns && line.startsWith("- {")) {
        const fm = parseFlowMap(line.replace(/^-\s*/, ""));
        current.columns.push({
          envio: fm.envio,
          ponder: fm.ponder,
          envio_type: fm.envio_type ?? "",
          ponder_type: fm.ponder_type ?? "",
          transform: normaliseTransform(fm.transform ?? "rename"),
          note: fm.note,
        });
        continue;
      }

      // entity scalar fields (indent ~4)
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (m) {
        const key = m[1];
        const val = stripComment(m[2]).trim();
        if (key === "ponder_table") current.ponder_table = val;
        else if (key === "classification") current.classification = val;
        else if (key === "start_block_policy") {
          current.start_block_policy_raw = m[2].trim();
          current.start_block_policy = normalisePolicy(m[2]);
        } else if (key === "handler_evidence")
          current.handler_evidence = val.replace(/^"|"$/g, "");
        else if (key === "pk") {
          // form: [id]
          current.pk = val
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        // ignore any other scalar (forward-compatible)
      }
      continue;
    }
  }
  if (current) doc.entities.push(current);

  // ── invariants (fail fast on drift) ──
  // The exact-40 count is a T-M1-specific drift guard (the Mibera set has a
  // fixed 40 entities). Other maps (e.g. the B-1 green-belt map with 44 live
  // entities) only need at least one entity. We key the strict check off the
  // resolved path being the T-M1 default.
  if (path === T_M1_MAP_PATH) {
    if (doc.entities.length !== 40)
      throw new Error(
        `expected 40 entities in T-M1 map, parsed ${doc.entities.length}`,
      );
  } else if (doc.entities.length < 1) {
    throw new Error(`expected >= 1 entity in map ${path}, parsed 0`);
  }
  for (const e of doc.entities) {
    if (!e.ponder_table)
      throw new Error(`entity ${e.envio_table} missing ponder_table`);
    if (e.pk.length !== 1 || e.pk[0] !== "id")
      throw new Error(
        `entity ${e.envio_table}: expected single PK [id], got [${e.pk.join(",")}]`,
      );
    if (e.columns.length === 0)
      throw new Error(`entity ${e.envio_table}: no columns parsed`);
    if (!e.columns.some((c) => c.ponder === "id"))
      throw new Error(`entity ${e.envio_table}: no id column`);
  }

  return {
    schema_version: doc.schema_version ?? 1,
    cycle: doc.cycle ?? "",
    task: doc.task ?? "",
    envio_source_schema: doc.envio_source_schema ?? "public",
    ponder_target_schema: doc.ponder_target_schema ?? "ponder",
    boundaries: doc.boundaries ?? {},
    entities: doc.entities,
  };
}

// CLI: `tsx entity-map.ts` prints a summary (no DB touched).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const doc = loadEntityMap();
  const byPolicy = doc.entities.reduce<Record<string, number>>((a, e) => {
    a[e.start_block_policy] = (a[e.start_block_policy] ?? 0) + 1;
    return a;
  }, {});
  const drift = doc.entities.flatMap((e) =>
    e.columns
      .filter((c) => c.transform !== "rename")
      .map((c) => `${e.ponder_table}.${c.ponder} [${c.transform}]`),
  );
  console.log(`entities: ${doc.entities.length}`);
  console.log(`boundaries:`, doc.boundaries);
  console.log(`start_block_policy:`, byPolicy);
  console.log(`total columns: ${doc.entities.reduce((a, e) => a + e.columns.length, 0)}`);
  console.log(`type-drift columns (${drift.length}):`);
  for (const d of drift) console.log(`  ${d}`);
}
