import { describe, expect, it } from "vitest";

import { resolveCollectionStatus, toStatusResponse } from "./status.js";
import type { IngestJobRecord } from "./types.js";

function job(status: IngestJobRecord["status"]): IngestJobRecord {
  const contract = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" as const;
  return {
    physicalJobId: "ingest_abc_def",
    jobId: "ingest_abc_def",
    key: { chainId: 80094, contract },
    deployment: {
      schema_version: 1,
      network: { schema_version: 1, network_namespace: "eip155", network_reference: "80094" },
      address: contract,
      normalized_address: contract,
      deployment_id: {
        algorithm: "sha-256",
        domain: "collection.deployment",
        major_version: 1,
        digest: "a".repeat(64),
      },
    },
    capabilityId: "ownership_index.v1",
    capabilityVersion: "b".repeat(64),
    tokenStandard: "erc721",
    prepareAdapterId: "belt.evm-erc721",
    prepareAdapterVersion: "belt-config-erc721.v1",
    sourceSequence: "41",
    finalityPolicyVersion: "berachain-finalized.v1",
    status,
    attempt: 1,
    leaseEpoch: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("resolveCollectionStatus", () => {
  it("prefers explicit indexed evidence", () => {
    expect(resolveCollectionStatus({
      indexed: {
        holderCount: 10,
        indexedAtMs: 1,
        readiness: { state: "ready", kind: "indexed_rows", observedAtMs: 1 },
      },
      job: job("queued"),
    })).toBe("indexed");
  });

  it("does not equate holder count alone with readiness", () => {
    expect(resolveCollectionStatus({
      indexed: { holderCount: 10, indexedAtMs: 1 },
      job: job("queued"),
    })).toBe("indexing");
  });

  it("accepts a zero-holder registration marker", () => {
    expect(resolveCollectionStatus({
      indexed: {
        holderCount: 0,
        indexedAtMs: null,
        readiness: { state: "ready", kind: "registration_marker", observedAtMs: 1 },
      },
    })).toBe("indexed");
  });

  it("maps failed and missing states", () => {
    expect(resolveCollectionStatus({
      indexed: { holderCount: 0, indexedAtMs: null },
      job: job("failed"),
    })).toBe("failed");
    expect(resolveCollectionStatus({ indexed: { holderCount: 0, indexedAtMs: null } })).toBe("missing");
  });
});

describe("toStatusResponse", () => {
  it("keeps the legacy indexed response shape", () => {
    expect(toStatusResponse("indexed", {
      holderCount: 1234,
      indexedAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
    })).toEqual({
      status: "indexed",
      holder_count: 1234,
      indexed_at: "2026-07-01T12:00:00.000Z",
    });
  });
});
