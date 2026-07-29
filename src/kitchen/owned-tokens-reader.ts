/**
 * Owned Tokens — per-owner token enumeration over the belt's `Token` entity.
 *
 * Answers "which tokenIds does this wallet hold in this collection?" — the step
 * consumers cannot derive from `/v2/ownership-snapshot`, whose `holders` rows
 * carry `{address, balance}` (counts, never token identity) and are capped at
 * `HOLDERS_RESPONSE_CAP`.
 *
 * The data already exists: `updateTokenOwnership` writes `Token{collection,
 * chainId, tokenId, owner, isBurned}` from every ERC-721 handler
 * (tracked-erc721, mibera-collection, honey-jar-nfts), and `owner` is indexed.
 * This reader exposes it; it does not compute anything new.
 *
 * HONESTY INVARIANT — an empty result is only a negative answer when the
 * collection is actually indexed. If the belt holds no `Token` rows for the
 * collection at all, we cannot distinguish "owns none" from "never indexed",
 * so coverage is `unavailable` and `token_ids` is empty. A consumer MUST NOT
 * read `unavailable` as "holds nothing" — that conflation is the defect
 * freeside-nano#21 documents on the snapshot path.
 *
 * See freeside-nano#17 (enumeration) and freeside-nano#21 (truncated holder set).
 */

import { parseCaip10, type OwnershipSnapshotSubject } from "./ownership-snapshot.js";
import { beltGraphqlUrlFromEnv } from "./hasura-status-reader.js";

/** Max token ids returned in one page. */
export const OWNED_TOKENS_MAX_LIMIT = 1000;
/** Default page size when the caller does not ask for one. */
export const OWNED_TOKENS_DEFAULT_LIMIT = 500;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export type OwnedTokens = {
  schema_version: 1;
  plane: "sonar_kitchen_ownership";
  subject: OwnershipSnapshotSubject;
  owner: string;
  observed_at: string;
  coverage: {
    /** `unavailable` = the collection has no indexed tokens; NOT "owns none". */
    ownership: "available" | "unavailable";
  };
  token_count: number;
  /** Stringified — tokenId is a uint256 and would lose precision as a JSON number. */
  token_ids: string[];
  /** Keyset cursor: pass back as `cursor` for the next page. Null when exhausted. */
  next_cursor: string | null;
};

export type OwnedTokensError = {
  error: "invalid_caip10" | "invalid_owner" | "invalid_limit" | "invalid_cursor";
  message: string;
};

export type OwnedTokensReader = {
  readOwnedTokens(args: {
    caip10: string;
    ownerRaw?: string | null;
    limitRaw?: string | null;
    cursorRaw?: string | null;
    nowMs?: number;
  }): Promise<OwnedTokens | OwnedTokensError>;
};

// Does the belt know this collection at all? Counts burned rows too: a fully
// burned collection is still *indexed*, and answering `unavailable` for it
// would understate what we know.
const COLLECTION_KNOWN_QUERY = `
query CollectionKnown($chainId: Int!, $contract: String!) {
  Token_aggregate(
    where: { chainId: { _eq: $chainId }, collection: { _eq: $contract } }
  ) {
    aggregate { count }
  }
}
`;

// Keyset walk on tokenId. `owner` and `isBurned` are both indexed.
const OWNED_TOKENS_QUERY = `
query OwnedTokens(
  $chainId: Int!
  $contract: String!
  $owner: String!
  $after: numeric!
  $limit: Int!
) {
  Token(
    where: {
      chainId: { _eq: $chainId }
      collection: { _eq: $contract }
      owner: { _eq: $owner }
      isBurned: { _eq: false }
      tokenId: { _gt: $after }
    }
    order_by: [{ tokenId: asc }]
    limit: $limit
  ) {
    tokenId
  }
}
`;

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
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

function toCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

/** tokenId arrives as string | number depending on Hasura's numeric mapping. */
function toTokenIdString(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "bigint") return value.toString();
  // A JSON number past 2^53 has already lost precision — refuse rather than
  // emit a silently-wrong tokenId.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

export function parseOwnedTokensRequest(args: {
  caip10: string;
  ownerRaw?: string | null;
  limitRaw?: string | null;
  cursorRaw?: string | null;
}):
  | { subject: OwnershipSnapshotSubject; owner: string; limit: number; after: string }
  | OwnedTokensError {
  const subject = parseCaip10(args.caip10);
  if (!subject) {
    return {
      error: "invalid_caip10",
      message: "caip10 must be eip155:<chainId>:0x… (40 hex address)",
    };
  }

  const owner = (args.ownerRaw ?? "").trim().toLowerCase();
  if (!EVM_ADDRESS.test(owner)) {
    return {
      error: "invalid_owner",
      message: "owner must be a 0x-prefixed 40-hex EVM address",
    };
  }
  if (owner === ZERO_ADDRESS) {
    // Burns write owner=ZERO; enumerating it would return the burn pile as if
    // an account held it.
    return {
      error: "invalid_owner",
      message: "owner must not be the zero address (burn sentinel)",
    };
  }

  let limit = OWNED_TOKENS_DEFAULT_LIMIT;
  const limitRaw = args.limitRaw?.trim();
  if (limitRaw) {
    if (!/^\d+$/.test(limitRaw)) {
      return { error: "invalid_limit", message: "limit must be a positive integer" };
    }
    limit = Number(limitRaw);
    if (limit < 1 || limit > OWNED_TOKENS_MAX_LIMIT) {
      return {
        error: "invalid_limit",
        message: `limit must be between 1 and ${OWNED_TOKENS_MAX_LIMIT}`,
      };
    }
  }

  let after = "-1"; // tokenId 0 is valid, so the initial keyset floor is below it
  const cursorRaw = args.cursorRaw?.trim();
  if (cursorRaw) {
    if (!/^\d+$/.test(cursorRaw)) {
      return { error: "invalid_cursor", message: "cursor must be a token id" };
    }
    after = cursorRaw;
  }

  return { subject, owner, limit, after };
}

export function createHasuraOwnedTokensReader(args?: {
  url?: string;
  fetchFn?: typeof fetch;
  adminSecret?: string;
}): OwnedTokensReader {
  const url = args?.url ?? beltGraphqlUrlFromEnv();
  const fetchFn = args?.fetchFn ?? fetch;
  const adminSecret = args?.adminSecret?.trim();

  async function gq<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return graphqlRequest<T>({ url, fetchFn, adminSecret, query, variables });
  }

  return {
    async readOwnedTokens(input) {
      const parsed = parseOwnedTokensRequest(input);
      if ("error" in parsed) return parsed;
      const { subject, owner, limit, after } = parsed;

      const chainId = Number(subject.network_reference);
      const contract = subject.address;
      const observed_at = new Date(input.nowMs ?? Date.now()).toISOString();

      const knownPayload = await gq<{
        Token_aggregate?: { aggregate?: { count?: number | null } | null };
      }>(COLLECTION_KNOWN_QUERY, { chainId, contract });
      const known = toCount(knownPayload.Token_aggregate?.aggregate?.count) > 0;

      if (!known) {
        // Not indexed — we do not know that the owner holds nothing.
        return {
          schema_version: 1,
          plane: "sonar_kitchen_ownership",
          subject,
          owner,
          observed_at,
          coverage: { ownership: "unavailable" },
          token_count: 0,
          token_ids: [],
          next_cursor: null,
        };
      }

      // Over-fetch by one to learn whether another page exists without a
      // second round trip.
      const rows = await gq<{ Token: Array<{ tokenId: unknown }> }>(OWNED_TOKENS_QUERY, {
        chainId,
        contract,
        owner,
        after,
        limit: limit + 1,
      });

      const all = rows.Token ?? [];
      const page = all.slice(0, limit);
      const token_ids: string[] = [];
      for (const row of page) {
        const id = toTokenIdString(row.tokenId);
        if (id === null) throw new Error("belt returned a non-integer tokenId");
        token_ids.push(id);
      }

      const hasMore = all.length > limit;
      return {
        schema_version: 1,
        plane: "sonar_kitchen_ownership",
        subject,
        owner,
        observed_at,
        coverage: { ownership: "available" },
        token_count: token_ids.length,
        token_ids,
        next_cursor: hasMore ? (token_ids[token_ids.length - 1] ?? null) : null,
      };
    },
  };
}
