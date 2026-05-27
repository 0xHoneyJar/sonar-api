// ponder-runtime/src/lib/outbox-pruning.ts
//
// Per Sprint A-2 T-A2.10 (SKP-003 HIGH) — pending_emits pruning cron.
//
// AC: cron `DELETE FROM ponder.pending_emits WHERE published_at IS NOT NULL
//      AND published_at < NOW() - INTERVAL '7 days'`.
//
// `pg` is intentionally NOT a direct dependency (avoids pulling node-postgres
// into the Ponder runtime image for a script that runs in a separate cron
// service). The structural type below is the minimum surface we need; callers
// pass any pg-compatible client (real pg.Client, drizzle's query.execute, etc).

interface QueryResult {
  rowCount: number | null;
}

interface QueryClient {
  query: (sql: string) => Promise<QueryResult>;
}

export const PRUNE_CONFIG = {
  retentionDays: Number(process.env.OUTBOX_RETENTION_DAYS ?? "7"),
} as const;

/**
 * The canonical prune SQL. `published_at` column is BIGINT (unix ms), so we
 * convert NOW() to unix ms with `extract(epoch from ...) * 1000`.
 */
export function pruneSql(retentionDays: number = PRUNE_CONFIG.retentionDays): string {
  return `DELETE FROM ponder.pending_emits
WHERE published_at IS NOT NULL
  AND published_at < (extract(epoch from (NOW() - INTERVAL '${retentionDays} days')) * 1000)::bigint`;
}

export async function pruneOutbox(
  client: QueryClient,
  retentionDays: number = PRUNE_CONFIG.retentionDays,
): Promise<{ deleted: number }> {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`pruneOutbox: retentionDays must be a positive integer, got ${retentionDays}`);
  }
  const result = await client.query(pruneSql(retentionDays));
  return { deleted: result.rowCount ?? 0 };
}
