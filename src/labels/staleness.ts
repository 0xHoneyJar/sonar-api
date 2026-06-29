/**
 * staleness.ts — validity-window CLOSE trigger (SDD §6, H-8, T6.4).
 *
 * FR-5 windows are inert without a close trigger (FAGAN SKP-003 staleness). When the periodic
 * extraction-loop re-run detects a role change (e.g. a changed Metaplex authority, an address that stopped
 * behaving like an escrow), it CLOSES the open label by setting `validity_to` (a mutable col per DH-5/SP-2);
 * the next ingest opens a fresh label (new `validity_from` → new content-addressed id). Old attributions are
 * preserved (history), not overwritten.
 */
import type { RunSql } from "./types";

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export interface CloseTarget {
  address: string;
  chain: string;
  collectionScope: string | null;
  entityType?: string; // optional: close only labels of this type
  asOf?: string; // close instant (ISO); defaults to now()
}

/** Close active (validity_to IS NULL) labels for the target. Returns the run_sql result (caller logs counts). */
export async function closeStaleLabels(runSql: RunSql, t: CloseTarget): Promise<void> {
  const scope = t.collectionScope === null
    ? "collection_scope IS NULL"
    : `collection_scope = ${sqlStr(t.collectionScope)}`;
  const typeClause = t.entityType ? ` AND entity_type = ${sqlStr(t.entityType)}` : "";
  const asOf = t.asOf ? sqlStr(t.asOf) : "now()";
  await runSql(
    `UPDATE label.entity_label
     SET validity_to = ${asOf}
     WHERE address = ${sqlStr(t.address)} AND chain = ${sqlStr(t.chain)} AND ${scope}${typeClause}
       AND validity_to IS NULL`,
    false,
  );
}
