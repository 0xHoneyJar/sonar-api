/**
 * Regression: fetchCursorSlot must coerce Hasura-stringified BIGINTs to Number.
 *
 * belt Hasura runs with HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true, so both cursor
 * sources — svm_sync_status.sqd_cursor_slot and the MAX(slot) fallback — arrive as
 * STRINGS. Un-coerced, the loader's `from` is a string and partitionSlotRange throws
 * "from/to must be integers" (only reproduces on the natural-resume path, i.e. when
 * --from-slot is omitted, which the production backfill worker uses).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OK = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("fetchCursorSlot — Hasura stringified-bigint coercion", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv("SVM_HASURA_ENDPOINT", "https://belt.example");
    vi.stubEnv("HASURA_GRAPHQL_ADMIN_SECRET", "secret");
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("returns a NUMBER (not string) for a stringified durable cursor", async () => {
    fetchMock.mockResolvedValueOnce(OK({ data: { svm_sync_status: [{ sqd_cursor_slot: "431294785" }] } }));
    const { fetchCursorSlot } = await import("../src/svm/sqd-loader");
    const v = await fetchCursorSlot("claynosaurz");
    expect(v).toBe(431294785);
    expect(typeof v).toBe("number");
    expect(Number.isInteger(v)).toBe(true); // the property partitionSlotRange requires
  });

  it("returns a NUMBER for the stringified MAX(slot) fallback (null durable cursor)", async () => {
    fetchMock
      .mockResolvedValueOnce(OK({ data: { svm_sync_status: [{ sqd_cursor_slot: null }] } }))
      .mockResolvedValueOnce(OK({ data: { svm_collection_event: [{ slot: "431249404" }] } }));
    const { fetchCursorSlot } = await import("../src/svm/sqd-loader");
    const v = await fetchCursorSlot("claynosaurz");
    expect(v).toBe(431249404);
    expect(Number.isInteger(v)).toBe(true);
  });

  it("returns null (→ genesis) when no cursor and no rows exist", async () => {
    fetchMock
      .mockResolvedValueOnce(OK({ data: { svm_sync_status: [] } }))
      .mockResolvedValueOnce(OK({ data: { svm_collection_event: [] } }));
    const { fetchCursorSlot } = await import("../src/svm/sqd-loader");
    expect(await fetchCursorSlot("degods")).toBeNull();
  });
});
