/**
 * Hasura-backed Ownership Snapshot reader (E2 TrackedHolder / E1 hold721 replay).
 */

import {
  OWNERSHIP_SNAPSHOT_MAX_ACTIONS,
  buildOwnershipSnapshot,
  holdersFromBalanceMap,
  parseAsOfToUnixSeconds,
  parseCaip10,
  replayHold721Actions,
  type OwnershipHolderRow,
  type OwnershipSnapshot,
  type OwnershipSnapshotSubject,
} from "./ownership-snapshot.js";
import { beltGraphqlUrlFromEnv } from "./hasura-status-reader.js";

const TRACKED_HOLDER_COUNT_QUERY = `
query TrackedHolderCount($chainId: Int!, $contract: String!) {
  TrackedHolder_aggregate(
    where: { chainId: { _eq: $chainId }, contract: { _eq: $contract } }
  ) {
    aggregate { count }
  }
}
`;

const TRACKED_HOLDERS_QUERY = `
query TrackedHolders($chainId: Int!, $contract: String!, $limit: Int!) {
  TrackedHolder(
    where: { chainId: { _eq: $chainId }, contract: { _eq: $contract } }
    order_by: [{ tokenCount: desc }, { address: asc }]
    limit: $limit
  ) {
    address
    tokenCount
  }
}
`;

const TOKEN_COUNT_QUERY = `
query TokenCount($chainId: Int!, $contract: String!) {
  Token_aggregate(
    where: {
      chainId: { _eq: $chainId }
      collection: { _eq: $contract }
      isBurned: { _eq: false }
    }
  ) {
    aggregate { count }
  }
}
`;

const TOKEN_OWNERS_QUERY = `
query TokenOwners($chainId: Int!, $contract: String!, $limit: Int!) {
  Token(
    where: {
      chainId: { _eq: $chainId }
      collection: { _eq: $contract }
      isBurned: { _eq: false }
    }
    order_by: [{ id: asc }]
    limit: $limit
  ) {
    owner
  }
}
`;

const HOLD721_MIN_TS_QUERY = `
query Hold721MinTs($collection: String!) {
  Action_aggregate(
    where: {
      primaryCollection: { _eq: $collection }
      actionType: { _eq: "hold721" }
    }
  ) {
    aggregate {
      count
      min { timestamp }
    }
  }
}
`;

const HOLD721_PAGE_QUERY = `
query Hold721Page(
  $collection: String!
  $cutoff: numeric!
  $ts: numeric!
  $id: String!
  $limit: Int!
) {
  Action(
    where: {
      primaryCollection: { _eq: $collection }
      actionType: { _eq: "hold721" }
      timestamp: { _lte: $cutoff }
      _or: [
        { timestamp: { _gt: $ts } }
        { timestamp: { _eq: $ts }, id: { _gt: $id } }
      ]
    }
    order_by: [{ timestamp: asc }, { id: asc }]
    limit: $limit
  ) {
    id
    actor
    timestamp
    numeric1
    context
  }
}
`;

function directionFromContext(context: unknown): string | null {
  if (context == null) return null;
  if (typeof context === "object" && !Array.isArray(context)) {
    const dir = (context as { direction?: unknown }).direction;
    return typeof dir === "string" ? dir : null;
  }
  if (typeof context === "string") {
    try {
      const parsed = JSON.parse(context) as { direction?: unknown };
      return typeof parsed.direction === "string" ? parsed.direction : null;
    } catch {
      return null;
    }
  }
  return null;
}

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

export type OwnershipSnapshotReader = {
  readOwnershipSnapshot(args: {
    caip10: string;
    asOfRaw?: string | null;
    referenceDateRaw?: string | null;
    nowMs?: number;
  }): Promise<OwnershipSnapshot | { error: "invalid_caip10" | "invalid_as_of"; message: string }>;
};

async function graphqlRequest<T>(args: {
  url: string;
  fetchFn: typeof fetch;
  adminSecret?: string;
  query: string;
  variables: Record<string, unknown>;
}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.adminSecret) headers["x-hasura-admin-secret"] = args.adminSecret;
  const response = await args.fetchFn(args.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: args.query, variables: args.variables }),
  });
  if (!response.ok) {
    throw new Error(`hasura graphql HTTP ${response.status}`);
  }
  const payload = (await response.json()) as GraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  if (!payload.data) throw new Error("hasura graphql empty data");
  return payload.data;
}

function aggregateTokenOwners(
  rows: Array<{ owner: string }>,
): OwnershipHolderRow[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const addr = row.owner.toLowerCase();
    if (!addr || addr === "0x0000000000000000000000000000000000000000") continue;
    map.set(addr, (map.get(addr) ?? 0) + 1);
  }
  return holdersFromBalanceMap(map);
}

export function createHasuraOwnershipSnapshotReader(args?: {
  url?: string;
  fetchFn?: typeof fetch;
  adminSecret?: string;
  /** Max Action rows for as-of replay. */
  maxActions?: number;
  /** Page size for hold721 keyset walk. */
  pageSize?: number;
  /** Cap for TrackedHolder / Token pull (E2). */
  currentHolderLimit?: number;
}): OwnershipSnapshotReader {
  const url = args?.url ?? beltGraphqlUrlFromEnv();
  const fetchFn = args?.fetchFn ?? fetch;
  const adminSecret = args?.adminSecret?.trim();
  const maxActions = args?.maxActions ?? OWNERSHIP_SNAPSHOT_MAX_ACTIONS;
  const pageSize = args?.pageSize ?? 2000;
  const currentHolderLimit = args?.currentHolderLimit ?? 100_000;

  async function gq<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return graphqlRequest<T>({ url, fetchFn, adminSecret, query, variables });
  }

  async function readCurrentHolders(
    subject: OwnershipSnapshotSubject,
  ): Promise<
    | { ok: true; holders: OwnershipHolderRow[] }
    | { ok: false; reason: string }
  > {
    const chainId = Number(subject.network_reference);
    const contract = subject.address;
    const trackedCountPayload = await gq<{
      TrackedHolder_aggregate?: { aggregate?: { count?: number | null } | null };
    }>(TRACKED_HOLDER_COUNT_QUERY, { chainId, contract });
    const trackedCount = toNumber(trackedCountPayload.TrackedHolder_aggregate?.aggregate?.count);

    if (trackedCount > currentHolderLimit) {
      return {
        ok: false,
        reason: `contract too large for on-demand ownership snapshot (${trackedCount} holders > ${currentHolderLimit})`,
      };
    }

    if (trackedCount > 0) {
      const tracked = await gq<{
        TrackedHolder?: Array<{ address: string; tokenCount: number | string }>;
      }>(TRACKED_HOLDERS_QUERY, { chainId, contract, limit: currentHolderLimit });

      const trackedRows = tracked.TrackedHolder ?? [];
      return {
        ok: true,
        holders: trackedRows
          .map((r) => ({
            address: r.address.toLowerCase(),
            balance: toNumber(r.tokenCount),
          }))
          .filter((r) => r.balance > 0),
      };
    }

    const tokenCountPayload = await gq<{
      Token_aggregate?: { aggregate?: { count?: number | null } | null };
    }>(TOKEN_COUNT_QUERY, { chainId, contract });
    const tokenCount = toNumber(tokenCountPayload.Token_aggregate?.aggregate?.count);
    if (tokenCount > currentHolderLimit) {
      return {
        ok: false,
        reason: `contract too large for on-demand ownership snapshot (${tokenCount} tokens > ${currentHolderLimit})`,
      };
    }

    const tokens = await gq<{ Token?: Array<{ owner: string }> }>(TOKEN_OWNERS_QUERY, {
      chainId,
      contract,
      limit: currentHolderLimit,
    });
    return { ok: true, holders: aggregateTokenOwners(tokens.Token ?? []) };
  }

  async function readAsOfHolders(
    subject: OwnershipSnapshotSubject,
    cutoffUnixSeconds: number,
  ): Promise<
    | { ok: true; holders: OwnershipHolderRow[] }
    | { ok: false; reason: string }
  > {
    const collection = subject.address;
    const agg = await gq<{
      Action_aggregate?: {
        aggregate?: {
          count?: number | null;
          min?: { timestamp?: string | number | null } | null;
        } | null;
      };
    }>(HOLD721_MIN_TS_QUERY, { collection });

    const total = toNumber(agg.Action_aggregate?.aggregate?.count);
    if (total <= 0) {
      return {
        ok: false,
        reason: "contract not indexed upstream (no hold721 actions for this address)",
      };
    }
    if (total > maxActions) {
      return {
        ok: false,
        reason: `contract too large for on-demand as-of replay (${total} hold721 actions > ${maxActions})`,
      };
    }

    const minTs = toNumber(agg.Action_aggregate?.aggregate?.min?.timestamp);
    if (minTs > 0 && minTs > cutoffUnixSeconds) {
      return {
        ok: false,
        reason: "indexed history starts after as_of",
      };
    }

    const actions: Array<{
      id: string;
      actor: string;
      timestamp: number;
      numeric1: number | null;
      direction?: string | null;
    }> = [];

    let cursorTs = -1;
    let cursorId = "";
    while (true) {
      const page = await gq<{
        Action?: Array<{
          id: string;
          actor: string;
          timestamp: string | number;
          numeric1: string | number | null;
          context?: unknown;
        }>;
      }>(HOLD721_PAGE_QUERY, {
        collection,
        cutoff: cutoffUnixSeconds,
        ts: cursorTs,
        id: cursorId,
        limit: pageSize,
      });
      const rows = page.Action ?? [];
      if (rows.length === 0) break;
      for (const r of rows) {
        actions.push({
          id: r.id,
          actor: r.actor,
          timestamp: toNumber(r.timestamp),
          numeric1: r.numeric1 == null ? null : toNumber(r.numeric1),
          direction: directionFromContext(r.context),
        });
      }
      if (actions.length > maxActions) {
        return {
          ok: false,
          reason: `contract too large for on-demand as-of replay (${actions.length}+ hold721 rows > ${maxActions})`,
        };
      }
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1]!;
      cursorTs = toNumber(last.timestamp);
      cursorId = last.id;
    }

    if (actions.length === 0) {
      return {
        ok: false,
        reason: "no hold721 actions at or before as_of (cannot reconstruct ownership)",
      };
    }

    const balances = replayHold721Actions(actions, cutoffUnixSeconds);
    return { ok: true, holders: holdersFromBalanceMap(balances) };
  }

  return {
    async readOwnershipSnapshot(args) {
      const subject = parseCaip10(args.caip10);
      if (!subject) {
        return { error: "invalid_caip10", message: "caip10 must be eip155:<chainId>:0x…" };
      }

      const asOfRaw = args.asOfRaw?.trim() || args.referenceDateRaw?.trim() || null;
      let asOfUnixSeconds: number | null = null;
      if (asOfRaw) {
        asOfUnixSeconds = parseAsOfToUnixSeconds(asOfRaw);
        if (asOfUnixSeconds == null) {
          return { error: "invalid_as_of", message: "as_of / reference_date must be YYYY-MM-DD or ISO datetime" };
        }
      }

      try {
        if (asOfUnixSeconds != null) {
          const dated = await readAsOfHolders(subject, asOfUnixSeconds);
          if (!dated.ok) {
            return buildOwnershipSnapshot({
              subject,
              holders: [],
              asOfUnixSeconds,
              observedAtMs: args.nowMs,
              insufficient: { status: "insufficient_data", reason: dated.reason },
            });
          }
          return buildOwnershipSnapshot({
            subject,
            holders: dated.holders,
            asOfUnixSeconds,
            observedAtMs: args.nowMs,
          });
        }

        const current = await readCurrentHolders(subject);
        if (!current.ok) {
          return buildOwnershipSnapshot({
            subject,
            holders: [],
            asOfUnixSeconds: null,
            observedAtMs: args.nowMs,
            insufficient: { status: "insufficient_data", reason: current.reason },
          });
        }
        if (current.holders.length === 0) {
          return buildOwnershipSnapshot({
            subject,
            holders: [],
            asOfUnixSeconds: null,
            observedAtMs: args.nowMs,
            insufficient: {
              status: "insufficient_data",
              reason: "contract not indexed upstream (no TrackedHolder / Token rows)",
            },
          });
        }
        return buildOwnershipSnapshot({
          subject,
          holders: current.holders,
          asOfUnixSeconds: null,
          observedAtMs: args.nowMs,
        });
      } catch (err) {
        // Do not leak upstream URLs / GraphQL internals to API clients.
        const kind = err instanceof Error && /HTTP \d+/.test(err.message)
          ? "upstream_http_error"
          : "upstream_error";
        return buildOwnershipSnapshot({
          subject,
          holders: [],
          asOfUnixSeconds,
          observedAtMs: args.nowMs,
          insufficient: {
            status: "insufficient_data",
            reason: `ownership snapshot ${kind}`,
          },
        });
      }
    },
  };
}
