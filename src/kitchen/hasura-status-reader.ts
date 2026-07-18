import type { CollectionKey } from "./types.js";
import type { CollectionStatusReader, IndexedSnapshot } from "./status.js";
import { collectionKeyId } from "./normalize.js";

const COLLECTION_SNAPSHOT_QUERY = `
query CollectionSnapshot($chainId: Int!, $contract: String!) {
  tracked: TrackedHolder_aggregate(
    where: { chainId: { _eq: $chainId }, contract: { _eq: $contract } }
  ) {
    aggregate { count }
  }
  tokens: Token_aggregate(
    where: {
      chainId: { _eq: $chainId }
      collection: { _eq: $contract }
      isBurned: { _eq: false }
    }
  ) {
    aggregate {
      count
      max { lastTransferTime }
    }
  }
}
`;

type AggregateValue = {
  aggregate?: {
    count?: number | null;
    max?: { lastTransferTime?: string | number | null } | null;
  } | null;
};

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function snapshotFromAggregates(
  tracked: AggregateValue | undefined,
  tokens: AggregateValue | undefined,
): IndexedSnapshot {
  const trackedCount = toNumber(tracked?.aggregate?.count);
  const tokenCount = toNumber(tokens?.aggregate?.count);
  const holderCount = trackedCount > 0 ? trackedCount : tokenCount;
  const base = {
    holderCount,
    tokenCount,
    trackedHolderCount: trackedCount,
  };

  if (holderCount <= 0) {
    return { ...base, indexedAtMs: null };
  }

  const lastTransfer = tokens?.aggregate?.max?.lastTransferTime;
  const indexedAtMs =
    lastTransfer !== undefined && lastTransfer !== null
      ? toNumber(lastTransfer) * 1000
      : null;

  if (indexedAtMs === null) {
    return { ...base, indexedAtMs: null };
  }

  return {
    ...base,
    indexedAtMs,
    readiness: {
      state: "ready",
      kind: "indexed_rows",
      observedAtMs: indexedAtMs,
    },
  };
}

export function beltGraphqlUrlFromEnv(): string {
  return (
    process.env.BELT_GRAPHQL_URL?.trim() ||
    "http://belt-hasura-selfhost.railway.internal:8080/v1/graphql"
  );
}

export function createHasuraCollectionStatusReader(args?: {
  url?: string;
  fetchFn?: typeof fetch;
  batchSize?: number;
}): CollectionStatusReader {
  const url = args?.url ?? beltGraphqlUrlFromEnv();
  const fetchFn = args?.fetchFn ?? fetch;
  const batchSize = Math.max(1, args?.batchSize ?? 100);

  async function execute(body: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<Record<string, AggregateValue>> {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`hasura graphql HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: Record<string, AggregateValue>;
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    return payload.data ?? {};
  }

  return {
    async readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot> {
      const data = await execute({
        query: COLLECTION_SNAPSHOT_QUERY,
        variables: { chainId: key.chainId, contract: key.contract },
      });
      return snapshotFromAggregates(data.tracked, data.tokens);
    },

    async readIndexedSnapshots(
      keys: CollectionKey[],
    ): Promise<Map<string, IndexedSnapshot>> {
      const snapshots = new Map<string, IndexedSnapshot>();
      for (let offset = 0; offset < keys.length; offset += batchSize) {
        const chunk = keys.slice(offset, offset + batchSize);
        const selections = chunk
          .map((key, index) => {
            const chainId = Number(key.chainId);
            const contract = JSON.stringify(key.contract);
            return `
  tracked_${index}: TrackedHolder_aggregate(
    where: { chainId: { _eq: ${chainId} }, contract: { _eq: ${contract} } }
  ) { aggregate { count } }
  tokens_${index}: Token_aggregate(
    where: {
      chainId: { _eq: ${chainId} }
      collection: { _eq: ${contract} }
      isBurned: { _eq: false }
    }
  ) { aggregate { count max { lastTransferTime } } }`;
          })
          .join("\n");
        const data = await execute({
          query: `query CollectionSnapshots {${selections}\n}`,
        });
        for (let index = 0; index < chunk.length; index += 1) {
          snapshots.set(
            collectionKeyId(chunk[index]),
            snapshotFromAggregates(
              data[`tracked_${index}`],
              data[`tokens_${index}`],
            ),
          );
        }
      }
      return snapshots;
    },
  };
}
