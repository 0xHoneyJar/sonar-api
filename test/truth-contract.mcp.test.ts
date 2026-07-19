import { Effect, Layer, Schema } from "effect";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TruthInspectionSnapshotV1,
} from "../src/truth-contract/schemas/inspection.js";
import {
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";
import {
  compileProjectionEventV1,
} from "../src/truth-contract/invalidation.js";
import {
  TruthInspector,
  compileTruthInspectionEnvelopeV1,
  projectionDigestForInspectionV1,
  truthInspectorLayer,
  verifyTruthInspectionEnvelopeV1,
  type TruthInspectorService,
} from "../src/truth-contract/status-reader.js";
import {
  makeSonarTruthRuntime,
  type SonarTruthRuntime,
} from "../src/truth-contract/cli/runtime.js";
import {
  SonarTruthMcpBudget,
  assertCredentialFreeEnvironment,
  callSonarTruthMcpTool,
  collectSonarTruthMcpTools,
  serveSonarTruthMcp,
} from "../src/truth-contract/cli/mcp.js";
import {
  runSonarTruthCli,
} from "../src/truth-contract/cli/sonar-truth.js";

const digest = (character: string) => character.repeat(64);
const NOW = "2026-08-10T00:00:00.000Z";
const ROOT = digest("a");
const PRODUCER = digest("b");
const RECONCILIATION = digest("c");
const PUBLISHER = LocalEd25519TrustSigner.fromSeedHex(
  "ac".repeat(32),
  "sonar-staged-publisher",
);
const ARTIFACTS = [
  {
    artifact_hash: PRODUCER,
    artifact_kind: "producer_readiness",
    effective_status: "READY",
    reason_codes: ["PRODUCER_READY"],
    expires_at: "2026-08-11T00:00:00.000Z",
    dependencies: [],
    evidence_refs: [digest("f")],
  },
  {
    artifact_hash: RECONCILIATION,
    artifact_kind: "reconciliation",
    effective_status: "READY",
    reason_codes: ["RECONCILED_STAGED"],
    expires_at: "2026-08-11T00:00:00.000Z",
    dependencies: [PRODUCER],
    evidence_refs: [digest("1")],
  },
] as const;
const PROJECTION = projectionDigestForInspectionV1(ARTIFACTS as never);

const snapshot = Schema.decodeUnknownSync(TruthInspectionSnapshotV1, {
  errors: "all",
  onExcessProperty: "error",
})({
  schema_version: 1,
  environment: "staging",
  collection_id: "mibera",
  canonical_address: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
  chain_id: "80094",
  event_signature: "Transfer(address,address,uint256)",
  validity_class: "STAGED_CURRENT",
  producer_root_hash: ROOT,
  producer_generation: "1",
  invalidation_epoch: "0",
  identity_snapshot_hash: digest("d"),
  reconciliation_hash: RECONCILIATION,
  score_receipt_hash: digest("e"),
  score_state: "NOT_CONSUMED",
  score_owner: "bd-v54z.1",
  score_deadline: "2026-08-17T00:00:00.000Z",
  publisher_key_id: PUBLISHER.keyId,
  trust_root_generation: "1",
  revocation_sequence: "0",
  cache_kind: "EXPLICIT_OFFLINE_CACHE",
  cached_at: "2026-08-09T23:59:30.000Z",
  authority_validity: "STAGED_VALID",
  production_authority: false,
  observed_at: "2026-08-09T23:59:00.000Z",
  expires_at: "2026-08-11T00:00:00.000Z",
  artifacts: ARTIFACTS,
  served_projection_digest: PROJECTION,
  rebuilt_projection_digest: PROJECTION,
});

const event = (
  sequence: "1" | "2",
  artifactHash: string,
  lifecycle: "PRODUCED" | "RECONCILED",
  authority: "PRODUCER" | "RECONCILER",
  reasonCode: string,
  dependencies: readonly string[],
  previous: ReturnType<typeof compileProjectionEventV1> | null,
) =>
  compileProjectionEventV1(
    {
      schema_version: 1,
      sequence,
      previous_event_hash:
        previous === null ? null : sha256Hex(jcsCanonicalize(previous)),
      event_id: `mcp-inspection-${sequence}`,
      kind: "ARTIFACT_ACTIVATED",
      environment: "staging",
      artifact_hash: artifactHash,
      generation: "1",
      invalidation_epoch: "0",
      authority,
      lifecycle_state: lifecycle,
      local_status: "READY",
      state_floor: "READY",
      reason_code: reasonCode,
      cause_event_id: null,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      depends_on: dependencies,
      occurred_at: NOW,
      production_authority: false,
    },
    PUBLISHER,
  );
const producerEvent = event(
  "1",
  PRODUCER,
  "PRODUCED",
  "PRODUCER",
  "PRODUCER_READY",
  [],
  null,
);
const reconciliationEvent = event(
  "2",
  RECONCILIATION,
  "RECONCILED",
  "RECONCILER",
  "RECONCILED_STAGED",
  [PRODUCER],
  producerEvent,
);
const signedEnvelope = Effect.runSync(
  compileTruthInspectionEnvelopeV1(
    snapshot,
    [producerEvent, reconciliationEvent],
    [
      {
        key_id: PUBLISHER.keyId,
        public_key_hex: PUBLISHER.publicKeyHex(),
        authorities: ["PRODUCER", "RECONCILER"],
      },
    ],
    PUBLISHER,
  ),
);
const source = Effect.runSync(
  verifyTruthInspectionEnvelopeV1(signedEnvelope, {
    keyId: PUBLISHER.keyId,
    publicKeyHex: PUBLISHER.publicKeyHex(),
    envelopeHash: signedEnvelope.envelope_hash,
    trustRootGeneration: "1",
    revocationSequence: "0",
  }),
);

const runtimes: SonarTruthRuntime[] = [];
const runtime = () => {
  const value = makeSonarTruthRuntime(truthInspectorLayer(source));
  runtimes.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.dispose()));
});

describe("sonar-truth local MCP", () => {
  it("exposes exactly the five allowlisted read tools", () => {
    const tools = collectSonarTruthMcpTools(runtime(), {
      environment: {},
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "dependencies",
      "explain",
      "rebuild-status",
      "status",
      "verify",
    ]);
  });

  it("returns the same versioned envelope and semantic exit as the CLI", async () => {
    const shared = runtime();
    const params = {
      collection: "mibera",
      environment: "staging",
      targetState: "produced",
    };
    const mcp = await callSonarTruthMcpTool(shared, "status", params, {
      environment: {},
      now: () => NOW as never,
    });
    const cli = await runSonarTruthCli(
      shared,
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "produced",
      ],
      { environment: {}, now: () => NOW as never },
    );
    expect(mcp).toEqual(JSON.parse(cli.output));
    expect(mcp.exit_code).toBe(0);
  });

  it("keeps MCP usage errors inside the Sonar envelope", async () => {
    const missing = await callSonarTruthMcpTool(
      runtime(),
      "status",
      { collection: "mibera", environment: "staging" },
      { environment: {} },
    );
    expect(missing.exit_code).toBe(1);
    expect(missing.findings[0]?.code).toBe("TARGET_STATE_REQUIRED");

    const unknown = await callSonarTruthMcpTool(
      runtime(),
      "status",
      {
        collection: "mibera",
        environment: "staging",
        targetState: "produced",
        databaseUrl: "postgres://must-not-be-read",
      },
      { environment: {} },
    );
    expect(unknown.exit_code).toBe(1);
    expect(unknown.findings[0]?.code).toBe("UNKNOWN_OPTION");
  });

  it("applies exact target gating to non-status MCP tools", async () => {
    const result = await callSonarTruthMcpTool(
      runtime(),
      "verify",
      {
        root: `sha256:${ROOT}`,
        targetState: "graduated",
      },
      { environment: {}, now: () => NOW as never },
    );
    expect(result.exit_code).toBe(2);
    expect(result.command).toBe("verify");
    expect(result.findings[0]?.code).toBe("NOT_CONSUMED");
  });

  it("normalizes schema-invalid MCP arguments to the CLI usage envelope", async () => {
    const result = await callSonarTruthMcpTool(
      runtime(),
      "status",
      {
        collection: 123,
        environment: "staging",
        targetState: "produced",
      },
      { environment: {}, now: () => NOW as never },
    );
    expect(result).toMatchObject({
      command: "status",
      outcome: "USAGE",
      exit_code: 1,
      production_authority: false,
      findings: [{ code: "COLLECTION_REQUIRED" }],
    });
  });

  it("returns the versioned usage envelope over the real stdio MCP transport", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(chunk.toString()));
    const serving = serveSonarTruthMcp(runtime(), {
      environment: {},
      input,
      output,
      now: () => NOW as never,
    });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "truth-test", version: "1.0.0" },
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "status",
          arguments: {
            collection: 123,
            environment: "staging",
            targetState: "produced",
          },
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.end();
    await serving;
    const responses = chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as any);
    const call = responses.find((response) => response.id === 2);
    expect(call?.error).toBeUndefined();
    expect(call?.result?.structuredContent).toMatchObject({
      protocol: "sonar-truth-cli/v1",
      command: "status",
      outcome: "USAGE",
      exit_code: 1,
      production_authority: false,
      findings: [{ code: "COLLECTION_REQUIRED" }],
    });
  });

  it("enforces per-tool rate and output resource limits", async () => {
    const shared = runtime();
    const budget = new SonarTruthMcpBudget({
      maximumCallsPerWindow: 1,
      maximumConcurrentCallsPerTool: 1,
    });
    const params = {
      collection: "mibera",
      environment: "staging",
      targetState: "produced",
    };
    const first = await callSonarTruthMcpTool(shared, "status", params, {
      budget,
      environment: {},
      now: () => NOW as never,
    });
    const second = await callSonarTruthMcpTool(shared, "status", params, {
      budget,
      environment: {},
      now: () => NOW as never,
    });
    expect(first.exit_code).toBe(0);
    expect(second.exit_code).toBe(6);
    expect(second.findings[0]?.code).toBe("MCP_TOOL_RATE_LIMIT");

    const bounded = await callSonarTruthMcpTool(
      runtime(),
      "status",
      params,
      {
        environment: {},
        execution: { maximumOutputBytes: 64 },
        now: () => NOW as never,
      },
    );
    expect(bounded.exit_code).toBe(6);
    expect(bounded.findings[0]?.code).toBe("OUTPUT_RESOURCE_LIMIT");
  });

  it("keeps in-flight concurrency counted across a rate-window rollover", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const budget = new SonarTruthMcpBudget({
        maximumCallsPerWindow: 10,
        maximumConcurrentCallsPerTool: 1,
        windowMilliseconds: 1,
      });
      const release = budget.acquire("status");
      expect(release).not.toBeNull();
      clock.mockReturnValue(2);
      expect(budget.acquire("status")).toBeNull();
      release?.();
      const next = budget.acquire("status");
      expect(next).not.toBeNull();
      next?.();
    } finally {
      clock.mockRestore();
    }
  });

  it("interrupts a tool operation at the frozen time bound", async () => {
    const neverInspector: TruthInspectorService = {
      evaluateTarget: () => Effect.never,
      status: () => Effect.never,
      verify: () => Effect.never,
      explain: () => Effect.never,
      dependencies: () => Effect.never,
      rebuild: () => Effect.never,
    };
    const slow = makeSonarTruthRuntime(
      Layer.succeed(TruthInspector, neverInspector),
    );
    runtimes.push(slow);
    const result = await callSonarTruthMcpTool(
      slow,
      "status",
      {
        collection: "mibera",
        environment: "staging",
        targetState: "produced",
      },
      {
        environment: {},
        execution: { timeoutMilliseconds: 5 },
        now: () => NOW as never,
      },
    );
    expect(result.exit_code).toBe(6);
    expect(result.findings[0]?.code).toBe("RESOURCE_LIMIT");
  });

  it("refuses credential-bearing MCP startup environments", () => {
    expect(() =>
      assertCredentialFreeEnvironment({
        DATABASE_URL: "postgres://must-not-be-read",
      }),
    ).toThrow("credential-bearing environment is refused");
    expect(() =>
      assertCredentialFreeEnvironment({
        AWS_SECRET_ACCESS_KEY: "must-not-survive",
      }),
    ).toThrow("credential-bearing environment is refused");
  });
});
