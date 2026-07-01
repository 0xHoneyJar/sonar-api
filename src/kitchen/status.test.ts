import { describe, expect, it } from "vitest";

import { resolveCollectionStatus, toStatusResponse } from "./status.js";
import type { IngestJobRecord } from "./types.js";

const KEY = {
  chainId: 80094,
  contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" as const,
};

function job(status: IngestJobRecord["status"]): IngestJobRecord {
  return {
    jobId: "ingest_80094_4b08a069",
    key: KEY,
    orderId: "order-1",
    source: "ordering-service",
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("resolveCollectionStatus", () => {
  it("prefers indexed when holders exist", () => {
    expect(
      resolveCollectionStatus({
        indexed: { holderCount: 10, indexedAtMs: 1 },
        job: job("queued"),
      }),
    ).toBe("indexed");
  });

  it("maps queued jobs to indexing", () => {
    expect(
      resolveCollectionStatus({
        indexed: { holderCount: 0, indexedAtMs: null },
        job: job("queued"),
      }),
    ).toBe("indexing");
  });

  it("maps failed jobs to failed", () => {
    expect(
      resolveCollectionStatus({
        indexed: { holderCount: 0, indexedAtMs: null },
        job: job("failed"),
      }),
    ).toBe("failed");
  });

  it("returns missing when no holders and no job", () => {
    expect(resolveCollectionStatus({ indexed: { holderCount: 0, indexedAtMs: null } })).toBe(
      "missing",
    );
  });
});

describe("toStatusResponse", () => {
  it("includes holder_count and indexed_at for indexed collections", () => {
    const response = toStatusResponse("indexed", {
      holderCount: 1234,
      indexedAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
    });
    expect(response).toEqual({
      status: "indexed",
      holder_count: 1234,
      indexed_at: "2026-07-01T12:00:00.000Z",
    });
  });
});
