import { and, count, eq, max, sql } from "ponder";
import { trackedHolder, token } from "ponder:schema";

import type { CollectionKey } from "./types";
import type { CollectionStatusReader, IndexedSnapshot } from "./status";

type ReadonlyDb = {
  select: (selection: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<Array<Record<string, unknown>>>;
    };
  };
};

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

export function createPonderCollectionStatusReader(db: ReadonlyDb): CollectionStatusReader {
  return {
    async readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot> {
      const [holderRow] = await db
        .select({ holderCount: count() })
        .from(trackedHolder)
        .where(and(eq(trackedHolder.chainId, key.chainId), eq(trackedHolder.contract, key.contract)));

      const holderCount = toNumber(holderRow?.holderCount);
      if (holderCount > 0) {
        const [indexedRow] = await db
          .select({ indexedAt: max(token.lastTransferTime) })
          .from(token)
          .where(
            and(
              eq(token.chainId, key.chainId),
              eq(token.contract, key.contract),
              eq(token.isBurned, false),
            ),
          );
        const indexedAtMs = indexedRow?.indexedAt ? toNumber(indexedRow.indexedAt) * 1000 : null;
        return { holderCount, indexedAtMs };
      }

      const [tokenRow] = await db
        .select({ holderCount: sql<number>`count(distinct ${token.owner})` })
        .from(token)
        .where(
          and(
            eq(token.chainId, key.chainId),
            eq(token.contract, key.contract),
            eq(token.isBurned, false),
          ),
        );

      const tokenHolderCount = toNumber(tokenRow?.holderCount);
      if (tokenHolderCount <= 0) {
        return { holderCount: 0, indexedAtMs: null };
      }

      const [indexedRow] = await db
        .select({ indexedAt: max(token.lastTransferTime) })
        .from(token)
        .where(
          and(
            eq(token.chainId, key.chainId),
            eq(token.contract, key.contract),
            eq(token.isBurned, false),
          ),
        );

      return {
        holderCount: tokenHolderCount,
        indexedAtMs: indexedRow?.indexedAt ? toNumber(indexedRow.indexedAt) * 1000 : null,
      };
    },
  };
}
