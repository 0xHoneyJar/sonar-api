/*
 * collection-event-webhook.test.ts — pins the load-bearing crash-loop hardening (FAGAN MAJOR-2) and the
 * T-5 multi-collection contract (SDD §2.5).
 *
 * refreshMembers() is the function whose throwing once took the whole realtime service down (a Helius 429
 * "max usage reached" propagated out of main() → process.exit(1) → Railway crash-loop). The invariant is:
 * it NEVER throws — DAS (authoritative) → DB-derived fallback → keep-existing-set, PER COLLECTION. These
 * tests fail if a future edit reintroduces a throw on any path, which "vitest green" alone would not catch.
 *
 * The T-5 additions pin: registry-driven per-collection member sets, delivery routing (event mint →
 * owning collection's key), the `COLLECTION` single-tenant override, the per-collection /health shape,
 * and the per-collection DEGRADED warning.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type http from "node:http";

// Hoisted so the (hoisted) vi.mock factories can close over them (vitest evaluates factories first).
// The webhook module reads HELIUS_WEBHOOK_SECRET at import time — set it here (before the static import
// is evaluated) so the POST-path tests can authenticate.
const { dasSnapshot, fetchMemberMintsFromDbMock, upsertCollectionEventsMock } = vi.hoisted(() => {
  process.env.HELIUS_WEBHOOK_SECRET = "test-secret";
  return {
    dasSnapshot: vi.fn(),
    fetchMemberMintsFromDbMock: vi.fn(),
    upsertCollectionEventsMock: vi.fn(),
  };
});

// Two-collection registry (SDD §2.5): the real registry has one entry today; the multi-collection
// contract needs two DISJOINT member sets to pin routing, so the tests own their registry.
vi.mock("../src/svm/collection-registry", () => {
  const COLLECTIONS = {
    alpha: { collectionKey: "alpha", collectionMint: "MINT_ALPHA", displayName: "Alpha", symbol: "$A", ownership: "external" },
    beta: { collectionKey: "beta", collectionMint: "MINT_BETA", displayName: "Beta", symbol: "$B", ownership: "external" },
  } as const;
  return {
    COLLECTIONS,
    DEFAULT_COLLECTION_KEY: "alpha",
    resolveCollection: (key: string) => {
      const c = COLLECTIONS[key.trim() as keyof typeof COLLECTIONS];
      if (!c) throw new Error(`unknown collection '${key}' (known: ${Object.keys(COLLECTIONS).join(", ")})`);
      return c;
    },
  };
});

vi.mock("../src/svm/nft-collection-source", () => ({
  // snapshot() is keyed by the collection mint the webhook constructed the source with, so alpha and
  // beta can resolve to different member sets (dasSnapshot receives the mint as its argument).
  DasNftCollectionSource: class {
    constructor(
      _rpc: string,
      public readonly mint: string,
    ) {}
    snapshot = () => dasSnapshot(this.mint);
  },
}));

vi.mock("../src/svm/collection-event-writer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/svm/collection-event-writer")>();
  return { ...actual, fetchMemberMintsFromDb: fetchMemberMintsFromDbMock, upsertCollectionEvents: upsertCollectionEventsMock };
});

import { refreshMembers, memberState, handle } from "../src/svm/collection-event-webhook";

const snap = (mints: string[]) => ({ members: mints.map((m) => ({ nftMint: m, owner: "W" })), slot: 1 });
const quota429 = () => new Error('getAssetsByGroup: HTTP 429 {"code":-32429,"message":"max usage reached"}');

/** A minimal Enhanced parsed tx that parseHeliusTx decodes to ONE transfer event on `mint`. */
const transferTx = (mint: string, sig = `SIG_${mint}`) => ({
  signature: sig,
  slot: 100,
  timestamp: 1_700_000_000,
  type: "TRANSFER",
  tokenTransfers: [{ mint, fromUserAccount: "W1", toUserAccount: "W2" }],
});

/** Fake req/res pair for the exported handle() — no port binding. */
function makeReq(opts: { method: string; url: string; body?: string; auth?: string }): http.IncomingMessage {
  const req = Readable.from(opts.body !== undefined ? [opts.body] : []) as unknown as http.IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.auth !== undefined ? { authorization: opts.auth } : {};
  return req;
}
function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
      return res;
    },
  };
  return res as typeof res & http.ServerResponse;
}

const authedPost = (payload: unknown) => makeReq({ method: "POST", url: "/", body: JSON.stringify(payload), auth: "test-secret" });

beforeEach(async () => {
  dasSnapshot.mockReset();
  fetchMemberMintsFromDbMock.mockReset();
  upsertCollectionEventsMock.mockReset();
  upsertCollectionEventsMock.mockResolvedValue(1);
  // Reset BOTH collections to a known DAS-authoritative baseline (module state persists across tests):
  // alpha = {A1, A2}, beta = {B1}. Individual tests re-refresh to build their own scenario on top.
  dasSnapshot.mockImplementation((mint: string) => Promise.resolve(mint === "MINT_ALPHA" ? snap(["A1", "A2"]) : snap(["B1"])));
  await refreshMembers("alpha");
  await refreshMembers("beta");
});

describe("refreshMembers (crash-loop hardening, per collection)", () => {
  it("DAS success → authoritative set, source=das, DB never consulted", async () => {
    dasSnapshot.mockResolvedValue(snap(["A", "B"]));
    await expect(refreshMembers("alpha")).resolves.toBeUndefined();
    expect(memberState("alpha")).toMatchObject({ size: 2, source: "das" });
    expect(fetchMemberMintsFromDbMock).not.toHaveBeenCalled();
  });

  it("DAS 429 → falls back to the DB-derived set, source=db-fallback (the outage path)", async () => {
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockResolvedValue(["X", "Y", "Z"]);
    await expect(refreshMembers("alpha")).resolves.toBeUndefined();
    expect(memberState("alpha")).toMatchObject({ size: 3, source: "db-fallback" });
  });

  it("DAS 429 + DB throws → NEVER throws; retains the prior set (the invariant)", async () => {
    // establish a known DAS set first
    dasSnapshot.mockResolvedValueOnce(snap(["A", "B"]));
    await refreshMembers("alpha");
    const before = memberState("alpha");
    // now both sources fail
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockRejectedValue(new Error("hasura: HTTP 500"));
    await expect(refreshMembers("alpha")).resolves.toBeUndefined();
    // set retained, loadedAt unchanged (so the next request self-heals by retrying)
    expect(memberState("alpha")).toEqual(before);
  });

  it("DAS 429 + DB returns [] → NEVER throws; retains the prior set", async () => {
    dasSnapshot.mockResolvedValueOnce(snap(["A", "B", "C"]));
    await refreshMembers("alpha");
    const before = memberState("alpha");
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockResolvedValue([]);
    await expect(refreshMembers("alpha")).resolves.toBeUndefined();
    expect(memberState("alpha")).toEqual(before);
  });

  it("one collection's failure never degrades a sibling (per-collection isolation)", async () => {
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockRejectedValue(new Error("hasura: HTTP 500"));
    await expect(refreshMembers("beta")).resolves.toBeUndefined();
    // beta retained its baseline; alpha untouched and still authoritative
    expect(memberState("beta")).toMatchObject({ size: 1, source: "das" });
    expect(memberState("alpha")).toMatchObject({ size: 2, source: "das" });
  });
});

describe("multi-collection delivery routing (SDD §2.5)", () => {
  it("an event on a beta-member mint upserts with beta's key/mint, not the default collection's", async () => {
    const res = makeRes();
    await handle(authedPost([transferTx("B1")]), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, events: 1, upserted: 1 });
    expect(upsertCollectionEventsMock).toHaveBeenCalledTimes(1);
    const [events, key, mint, source] = upsertCollectionEventsMock.mock.calls[0];
    expect(key).toBe("beta");
    expect(mint).toBe("MINT_BETA");
    expect(source).toBe("helius-webhook");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nftMint: "B1", kind: "transfer" });
  });

  it("a mixed delivery splits into one upsert per collection, each with its own key", async () => {
    const res = makeRes();
    await handle(authedPost([transferTx("A1"), transferTx("B1")]), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, events: 2, upserted: 2 });
    const calls = upsertCollectionEventsMock.mock.calls.map(([evs, key, mint]) => ({ key, mint, mints: evs.map((e: { nftMint: string }) => e.nftMint) }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { key: "alpha", mint: "MINT_ALPHA", mints: ["A1"] },
        { key: "beta", mint: "MINT_BETA", mints: ["B1"] },
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it("a non-member mint decodes to nothing (no upsert)", async () => {
    const res = makeRes();
    await handle(authedPost([transferTx("NOT_A_MEMBER")]), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, events: 0, upserted: 0 });
    expect(upsertCollectionEventsMock).not.toHaveBeenCalled();
  });
});

describe("COLLECTION single-tenant override (back-compat)", () => {
  it("COLLECTION=alpha → only alpha is watched: beta events are ignored, /health shows alpha only", async () => {
    process.env.COLLECTION = "alpha";
    vi.resetModules();
    try {
      // A fresh module instance re-reads COLLECTION at import (same mocks still apply after resetModules).
      const mod = await import("../src/svm/collection-event-webhook");
      await mod.refreshMembers("alpha");
      expect(mod.memberState("alpha")).toMatchObject({ size: 2, source: "das" });
      // beta is NOT watched in override mode
      expect(() => mod.memberState("beta")).toThrow(/unwatched/);
      // a beta-member event is filtered out exactly as today (single-tenant behavior)
      const post = makeRes();
      await mod.handle(authedPost([transferTx("B1")]), post);
      expect(JSON.parse(post.body)).toMatchObject({ ok: true, events: 0, upserted: 0 });
      expect(upsertCollectionEventsMock).not.toHaveBeenCalled();
      // /health carries only the override collection's block
      const health = makeRes();
      await mod.handle(makeReq({ method: "GET", url: "/health" }), health);
      expect(Object.keys(JSON.parse(health.body).collections)).toEqual(["alpha"]);
    } finally {
      delete process.env.COLLECTION;
      vi.resetModules();
    }
  });
});

describe("/health per-collection shape (SDD §2.5)", () => {
  it("emits {ok, collections: {<key>: {members, loadedAt, source}}} for every watched collection", async () => {
    // baseline from beforeEach: alpha das(2), beta das(1); degrade beta to db-fallback for contrast
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockResolvedValue(["B1", "B2"]);
    await refreshMembers("beta");
    const res = makeRes();
    await handle(makeReq({ method: "GET", url: "/health" }), res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.collections.alpha).toMatchObject({ members: 2, source: "das" });
    expect(body.collections.alpha.loadedAt).toBeGreaterThan(0);
    expect(body.collections.beta).toMatchObject({ members: 2, source: "db-fallback" });
    expect(body.collections.beta.loadedAt).toBeGreaterThan(0);
  });
});

describe("DEGRADED member-set warning (MINOR-1, per collection)", () => {
  it("a delivery against a degraded collection warns with THAT collection's key; healthy siblings stay silent", async () => {
    // degrade beta only
    dasSnapshot.mockRejectedValue(quota429());
    fetchMemberMintsFromDbMock.mockResolvedValue(["B1"]);
    await refreshMembers("beta");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = makeRes();
      await handle(authedPost([transferTx("B1")]), res);
      expect(res.statusCode).toBe(200);
      const degradedWarnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("DEGRADED member set"));
      expect(degradedWarnings).toHaveLength(1);
      expect(degradedWarnings[0]).toContain("DEGRADED member set for beta (source=db-fallback");
      expect(degradedWarnings[0]).not.toContain("alpha");
    } finally {
      warn.mockRestore();
    }
  });
});
