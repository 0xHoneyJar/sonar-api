import type { CollectionKey } from "./types.js";
import type { CollectionStatusReader, IndexedSnapshot } from "./status.js";

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

type GraphqlResponse = {
  data?: {
    tracked?: { aggregate?: { count?: number | null } | null };
    tokens?: {
      aggregate?: {
        count?: number | null;
        max?: { lastTransferTime?: string | number | null } | null;
      } | null;
    };
  };
  errors?: Array<{ message: string }>;
};

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
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
}): CollectionStatusReader {
  const url = args?.url ?? beltGraphqlUrlFromEnv();
  const fetchFn = args?.fetchFn ?? fetch;

  return {
    async readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot> {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: COLLECTION_SNAPSHOT_QUERY,
          variables: { chainId: key.chainId, contract: key.contract },
        }),
      });

      if (!response.ok) {
        throw new Error(`hasura graphql HTTP ${response.status}`);
      }

      const payload = (await response.json()) as GraphqlResponse;
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((e) => e.message).join("; "));
      }

      const trackedCount = toNumber(payload.data?.tracked?.aggregate?.count);
      const tokenCount = toNumber(payload.data?.tokens?.aggregate?.count);
      const holderCount = trackedCount > 0 ? trackedCount : tokenCount;

      if (holderCount <= 0) {
        return { holderCount: 0, indexedAtMs: null };
      }

      const lastTransfer = payload.data?.tokens?.aggregate?.max?.lastTransferTime;
      const indexedAtMs =
        lastTransfer !== undefined && lastTransfer !== null
          ? toNumber(lastTransfer) * 1000
          : null;

      return {
        holderCount,
        indexedAtMs,
        readiness: {
          state: "ready",
          kind: "indexed_rows",
          observedAtMs: indexedAtMs ?? Date.now(),
        },
      };
    },
  };
}
