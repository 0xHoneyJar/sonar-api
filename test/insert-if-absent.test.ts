/**
 * T-4: INSERT_IF_ABSENT semantics — ON CONFLICT DO NOTHING.
 *
 * Verifies that when `upsertCollectionEvents` is called with `ifAbsentOnly: true`,
 * it issues the INSERT_IF_ABSENT mutation (update_columns: []) rather than the full UPSERT
 * mutation, ensuring existing rows survive a second write with the same PK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertCollectionEvents } from "../src/svm/collection-event-writer";
import type { CollectionEvent } from "../src/svm/collection-event-source";

const EVENT: CollectionEvent = {
  nftMint: "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w",
  kind: "transfer",
  from: "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac",
  to: "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2",
  instructionIndex: 0,
  price: null,
  marketplace: null,
  slot: 428886218,
  blockTime: 1782422682,
  txSignature: "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn",
};

const COLLECTION_KEY = "pythians";
const COLLECTION_MINT = "ALf8rcmMF8CkGRUH1jWbXHqKmeCp7GGxbUNmE4VLGNBQ";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Patch env vars required by upsertCollectionEvents
  process.env.SVM_HASURA_ENDPOINT = "http://localhost:8080";
  process.env.HASURA_GRAPHQL_ADMIN_SECRET = "test-secret";
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { insert_svm_collection_event: { affected_rows: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SVM_HASURA_ENDPOINT;
  delete process.env.HASURA_GRAPHQL_ADMIN_SECRET;
});

describe("upsertCollectionEvents — INSERT_IF_ABSENT (ifAbsentOnly: true)", () => {
  it("uses INSERT_IF_ABSENT mutation (update_columns: []) when ifAbsentOnly=true", async () => {
    await upsertCollectionEvents([EVENT], COLLECTION_KEY, COLLECTION_MINT, "sqd-stream", { ifAbsentOnly: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // INSERT_IF_ABSENT mutation has update_columns: [] in its GraphQL string
    expect(body.query).toContain("update_columns: []");
    // Must NOT contain the full-overwrite update_columns list
    expect(body.query).not.toContain("update_columns: [collection_key");
  });

  it("uses full UPSERT mutation when ifAbsentOnly is omitted", async () => {
    await upsertCollectionEvents([EVENT], COLLECTION_KEY, COLLECTION_MINT, "helius-backfill");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Full UPSERT has update_columns with field list
    expect(body.query).not.toContain("update_columns: []");
    expect(body.query).toContain("update_columns:");
  });

  it("sqd-stream source is recorded in the inserted object", async () => {
    await upsertCollectionEvents([EVENT], COLLECTION_KEY, COLLECTION_MINT, "sqd-stream", { ifAbsentOnly: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const objects = body.variables.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].source).toBe("sqd-stream");
  });

  it("first-writer-wins: helius row written first survives sqd upsert (contract test)", async () => {
    // This test verifies the SEMANTICS by checking mutation selection:
    // When the sqd lane calls with ifAbsentOnly=true, it uses DO NOTHING — so a pre-existing
    // helius row with the same PK would survive (DB enforced, not testable without a real DB).
    // Here we verify the mutation string selection is correct — the contract is at the DB level.
    await upsertCollectionEvents([EVENT], COLLECTION_KEY, COLLECTION_MINT, "sqd-stream", { ifAbsentOnly: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The critical invariant: update_columns MUST be empty for the absent-only path
    const queryHasEmptyUpdateCols = /update_columns:\s*\[\s*\]/.test(body.query);
    expect(queryHasEmptyUpdateCols).toBe(true);
  });
});
