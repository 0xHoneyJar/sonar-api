import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  createHasuraOwnedTokensReader,
  OWNED_TOKENS_MAX_LIMIT,
  type OwnedTokensReader,
} from "./owned-tokens-reader.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import { createKitchenApp } from "./routes.js";
import type { CollectionStatusReader } from "./status.js";

const TOKEN = "kitchen-test-token";
const CAIP10 = "eip155:1:0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9";
const OWNER = "0x1111111111111111111111111111111111111111";
const URL = "https://belt.example/v1/graphql";

const reader: CollectionStatusReader = {
  readIndexedSnapshot: async () => ({ holderCount: 42, indexedAtMs: 1_700_000_000_000 }),
};

/**
 * Fake Hasura. `knownCount` drives the collection-known probe; `tokenIds` is
 * the belt's answer for the owner, already keyset-filtered by the caller's
 * `after`/`limit` the way Postgres would.
 */
function fakeBelt(opts: { knownCount: number; tokenIds?: Array<string | number> }) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push(body.variables);
    if (body.query.includes("CollectionKnown")) {
      return new Response(
        JSON.stringify({ data: { Token_aggregate: { aggregate: { count: opts.knownCount } } } }),
        { status: 200 },
      );
    }
    const after = BigInt(String(body.variables.after));
    const limit = Number(body.variables.limit);
    const rows = (opts.tokenIds ?? [])
      .filter((id) => BigInt(String(id)) > after)
      .slice(0, limit)
      .map((tokenId) => ({ tokenId }));
    return new Response(JSON.stringify({ data: { Token: rows } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const readerFor = (opts: { knownCount: number; tokenIds?: Array<string | number> }) =>
  createHasuraOwnedTokensReader({ url: URL, fetchFn: fakeBelt(opts).fetchFn });

describe("GET /v2/owned-tokens", () => {
  beforeEach(() => vi.stubEnv("SERVICE_TOKEN", TOKEN));
  afterEach(() => vi.unstubAllEnvs());

  function app(ownedTokensReader?: OwnedTokensReader) {
    return createKitchenApp({
      store: new MemoryIngestJobStore(),
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
      ownedTokensReader,
    });
  }

  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
  const q = (extra: string) => `/v2/owned-tokens?caip10=${encodeURIComponent(CAIP10)}${extra}`;

  type Body = {
    coverage: { ownership: string };
    token_count: number;
    token_ids: string[];
    next_cursor: string | null;
  };
  /** Hono's `request` returns `Response | Promise<Response>`; normalize + type. */
  async function getJson(a: ReturnType<typeof app>, path: string): Promise<Body> {
    const res = await a.request(path, auth);
    return (await res.json()) as Body;
  }

  it("rejects unauthenticated reads", async () => {
    const res = await app(readerFor({ knownCount: 1 })).request(q(`&owner=${OWNER}`));
    expect(res.status).toBe(401);
  });

  it("returns 503 when the reader is not configured", async () => {
    const res = await app().request(q(`&owner=${OWNER}`), auth);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: "owned_tokens_unavailable" },
    });
  });

  it("requires caip10", async () => {
    const res = await app(readerFor({ knownCount: 1 })).request("/v2/owned-tokens", auth);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("rejects a malformed owner", async () => {
    const res = await app(readerFor({ knownCount: 1 })).request(q("&owner=not-an-address"), auth);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_owner" } });
  });

  it("rejects the zero address — burns write owner=ZERO and are not a holding", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const res = await app(readerFor({ knownCount: 1 })).request(q(`&owner=${zero}`), auth);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_owner" } });
  });

  it("rejects a limit above the cap", async () => {
    const res = await app(readerFor({ knownCount: 1 })).request(
      q(`&owner=${OWNER}&limit=${OWNED_TOKENS_MAX_LIMIT + 1}`),
      auth,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_limit" } });
  });

  it("returns owned token ids as strings", async () => {
    const res = await app(readerFor({ knownCount: 9, tokenIds: [1, 7, 42] })).request(
      q(`&owner=${OWNER}`),
      auth,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      coverage: { ownership: "available" },
      owner: OWNER,
      token_count: 3,
      token_ids: ["1", "7", "42"],
      next_cursor: null,
    });
  });

  // The distinction this endpoint exists to preserve — and the one whose
  // absence on the snapshot path is freeside-nano#21.
  describe("empty is only a negative answer when the collection is indexed", () => {
    it("indexed collection + owner holds none → available, a SOUND negative", async () => {
      const body = await getJson(
        app(readerFor({ knownCount: 5000, tokenIds: [] })),
        q(`&owner=${OWNER}`),
      );
      expect(body).toMatchObject({
        coverage: { ownership: "available" },
        token_count: 0,
        token_ids: [],
      });
    });

    it("collection not indexed → unavailable, NOT 'owns none'", async () => {
      const body = await getJson(
        app(readerFor({ knownCount: 0, tokenIds: [] })),
        q(`&owner=${OWNER}`),
      );
      expect(body).toMatchObject({
        coverage: { ownership: "unavailable" },
        token_count: 0,
        token_ids: [],
      });
      // Both cases return an empty array; only `coverage` separates them, so a
      // consumer keying off `token_ids.length` alone would conflate the two.
      expect(body.coverage.ownership).not.toBe("available");
    });
  });

  it("paginates by keyset and stops cleanly", async () => {
    const ids = [1, 2, 3, 4, 5];
    const belt = () => app(readerFor({ knownCount: 9, tokenIds: ids }));

    const page1 = await getJson(belt(), q(`&owner=${OWNER}&limit=2`));
    expect(page1).toMatchObject({ token_ids: ["1", "2"], next_cursor: "2" });

    const page2 = await getJson(belt(), q(`&owner=${OWNER}&limit=2&cursor=${page1.next_cursor}`));
    expect(page2).toMatchObject({ token_ids: ["3", "4"], next_cursor: "4" });

    const page3 = await getJson(belt(), q(`&owner=${OWNER}&limit=2&cursor=${page2.next_cursor}`));
    // Exactly one row left: no over-fetch surplus, so the walk terminates.
    expect(page3).toMatchObject({ token_ids: ["5"], next_cursor: null });
  });

  it("tokenId 0 is reachable — the initial keyset floor must sit below it", async () => {
    const res = await app(readerFor({ knownCount: 9, tokenIds: [0, 1] })).request(
      q(`&owner=${OWNER}`),
      auth,
    );
    expect(await res.json()).toMatchObject({ token_ids: ["0", "1"] });
  });

  it("preserves a uint256 tokenId past 2^53 without precision loss", async () => {
    // A JSON number here would round; the belt returns numerics as strings and
    // the reader must pass them through untouched.
    const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const body = await getJson(app(readerFor({ knownCount: 9, tokenIds: [big] })), q(`&owner=${OWNER}`));
    expect(body.token_ids).toEqual([big]);
    expect(body.token_ids[0]).toHaveLength(78);
  });

  it("lowercases the owner before querying — the belt stores lowercase", async () => {
    const belt = fakeBelt({ knownCount: 9, tokenIds: [3] });
    const r = createHasuraOwnedTokensReader({ url: URL, fetchFn: belt.fetchFn });
    const out = await r.readOwnedTokens({ caip10: CAIP10, ownerRaw: OWNER.toUpperCase() });
    expect("error" in out).toBe(false);
    const ownerVars = belt.calls.find((v) => "owner" in v);
    expect(ownerVars?.owner).toBe(OWNER);
  });
});
