import { beforeEach, describe, expect, it, vi } from "vitest";

// Env must be set BEFORE import (module reads at load) — mirror collection-event-writer's pattern.
process.env.SVM_HASURA_ENDPOINT = "https://hasura.test";
process.env.HASURA_GRAPHQL_ADMIN_SECRET = "s3cret";
const { writeSyncStatus } = await import("../src/svm/sync-status");

const ok = () => new Response(JSON.stringify({ data: { insert_svm_sync_status_one: { collection_key: "x" } } }), { status: 200 });

describe("writeSyncStatus", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchImpl = vi.fn().mockResolvedValue(ok()); });

  it("updates ONLY the patched columns (reconcile write must not clobber event freshness)", async () => {
    await writeSyncStatus({ collectionKey: "pythians", lastReconcileAt: "2026-07-05T00:00:00Z", lastReconcileResult: "passed" }, { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.variables.columns.sort()).toEqual(["last_reconcile_at", "last_reconcile_result", "updated_at"]);
    expect(body.variables.object).not.toHaveProperty("last_event_at");
  });

  it("writes event freshness with source label", async () => {
    await writeSyncStatus({ collectionKey: "mad_lads", lastEventAt: "2026-07-05T01:00:00Z", lastEventSource: "dune-warehouse" }, { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.variables.object.last_event_source).toBe("dune-warehouse");
  });

  it("supports the declared degraded state skipped-no-das", async () => {
    await writeSyncStatus({ collectionKey: "pythians", lastReconcileResult: "skipped-no-das" }, { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.variables.object.last_reconcile_result).toBe("skipped-no-das");
  });

  it("never throws — returns false on transport failure and GraphQL errors", async () => {
    fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(writeSyncStatus({ collectionKey: "x" }, { fetchImpl })).resolves.toBe(false);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "constraint" }] }), { status: 200 }));
    await expect(writeSyncStatus({ collectionKey: "x" }, { fetchImpl })).resolves.toBe(false);
  });
});
