import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

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
  compileTruthInspectionEnvelopeV1,
  projectionDigestForInspectionV1,
  truthInspectorLayer,
  verifyTruthInspectionEnvelopeV1,
} from "../src/truth-contract/status-reader.js";
import {
  makeSonarTruthRuntime,
  type SonarTruthRuntime,
} from "../src/truth-contract/cli/runtime.js";
import {
  runSonarTruthCli,
} from "../src/truth-contract/cli/sonar-truth.js";
import {
  SonarTruthEnvelopeSchema,
  scrubProcessEnvironmentForTruthAgent,
  type SonarTruthEnvelopeV1,
} from "../src/truth-contract/cli/contract.js";

const digest = (character: string) => character.repeat(64);
const NOW = "2026-08-10T00:00:00.000Z";
const ROOT = digest("a");
const PRODUCER = digest("b");
const RECONCILIATION = digest("c");
const PUBLISHER = LocalEd25519TrustSigner.fromSeedHex(
  "ab".repeat(32),
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

const projectionEvent = (
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
      event_id: `inspection-${sequence}`,
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
const producerEvent = projectionEvent(
  "1",
  PRODUCER,
  "PRODUCED",
  "PRODUCER",
  "PRODUCER_READY",
  [],
  null,
);
const reconciliationEvent = projectionEvent(
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

const parse = (output: string): SonarTruthEnvelopeV1 =>
  SonarTruthEnvelopeSchema.parse(
    JSON.parse(output),
  ) as SonarTruthEnvelopeV1;

describe("sonar-truth CLI", () => {
  it("returns exit 0 only for the exact ready target", async () => {
    const result = await runSonarTruthCli(
      runtime(),
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
    const envelope = parse(result.output);
    expect(result.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      schema_version: 1,
      protocol: "sonar-truth-cli/v1",
      command: "status",
      target_state: "produced",
      outcome: "READY",
      exit_code: 0,
      production_authority: false,
      data: {
        cache_age_seconds: "30",
        snapshot: {
          publisher_key_id: "sonar-staged-publisher",
          trust_root_generation: "1",
          revocation_sequence: "0",
          cache_kind: "EXPLICIT_OFFLINE_CACHE",
          expires_at: "2026-08-11T00:00:00.000Z",
        },
      },
    });
  });

  it("keeps end-to-end targets at exit 2 while Score is not consumed", async () => {
    const result = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "consumed",
      ],
      { environment: {}, now: () => NOW as never },
    );
    const envelope = parse(result.output);
    expect(result.exitCode).toBe(2);
    expect(envelope.outcome).toBe("FINDINGS");
    expect(envelope.findings).toContainEqual({
      code: "NOT_CONSUMED",
      owner: "bd-v54z.1",
      deadline: "2026-08-17T00:00:00.000Z",
    });
  });

  it("normalizes missing target state and unknown commands to exit 1 JSON", async () => {
    const missing = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
      ],
      { environment: {} },
    );
    expect(missing.exitCode).toBe(1);
    expect(parse(missing.output).findings[0]?.code).toBe(
      "TARGET_STATE_REQUIRED",
    );

    const unknown = await runSonarTruthCli(runtime(), ["mutate"], {
      environment: {},
    });
    expect(unknown.exitCode).toBe(1);
    expect(parse(unknown.output).findings[0]?.code).toBe(
      "UNSUPPORTED_COMMAND",
    );
  });

  it("keeps generated help and schema available without registry credentials", () => {
    const metadata = spawnSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "src/truth-contract/cli/sonar-truth.ts",
        "status",
        "--schema",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    expect(metadata.status).toBe(0);
    expect(JSON.parse(metadata.stdout)).toHaveProperty("output");
  });

  it("serves all five read-only operations through the same runtime", async () => {
    const cases = [
      [
        "verify",
        "--root",
        `sha256:${ROOT}`,
        "--target-state",
        "produced",
      ],
      [
        "explain",
        "--artifact",
        RECONCILIATION,
        "--target-state",
        "reconciled_staged",
      ],
      [
        "dependencies",
        "--artifact",
        RECONCILIATION,
        "--target-state",
        "reconciled_staged",
      ],
      [
        "rebuild-status",
        "--environment",
        "staging",
        "--target-state",
        "reconciled_staged",
      ],
    ] as const;
    const shared = runtime();
    for (const argv of cases) {
      const result = await runSonarTruthCli(shared, argv, {
        environment: {},
        now: () => NOW as never,
      });
      expect(result.exitCode, argv[0]).toBe(0);
      expect(parse(result.output).command).toBe(argv[0]);
    }
  });

  it("blocks every non-status operation when its exact target is unmet", async () => {
    const shared = runtime();
    for (const argv of [
      ["verify", "--root", `sha256:${ROOT}`],
      ["explain", "--artifact", RECONCILIATION],
      ["dependencies", "--artifact", RECONCILIATION],
      ["rebuild-status", "--environment", "staging"],
    ]) {
      const result = await runSonarTruthCli(
        shared,
        [...argv, "--target-state", "graduated"],
        { environment: {}, now: () => NOW as never },
      );
      const envelope = parse(result.output);
      expect(result.exitCode, argv[0]).toBe(2);
      expect(envelope.command).toBe(argv[0]);
      expect(envelope.target_state).toBe("graduated");
      expect(envelope.findings).toContainEqual({
        code: "NOT_CONSUMED",
        owner: "bd-v54z.1",
        deadline: "2026-08-17T00:00:00.000Z",
      });
    }
  });

  it("rejects forged Score-authority and end-to-end READY envelopes at the output schema", async () => {
    const produced = parse(
      (
        await runSonarTruthCli(
          runtime(),
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
        )
      ).output,
    );
    const forgedAuthority = structuredClone(produced) as any;
    forgedAuthority.target_state = "consumed";
    forgedAuthority.outcome = "READY";
    forgedAuthority.exit_code = 0;
    forgedAuthority.data.target_state = "consumed";
    forgedAuthority.data.target_ready = true;
    forgedAuthority.data.lifecycle = "CONSUMED";
    forgedAuthority.data.display_state = "CONSUMED";
    forgedAuthority.data.snapshot.score_state = "CONSUMED";
    forgedAuthority.data.snapshot.authority_validity = "AUTHORITY_VALID";
    expect(() => SonarTruthEnvelopeSchema.parse(forgedAuthority)).toThrow();

    const forgedCrossField = structuredClone(produced) as any;
    forgedCrossField.target_state = "live_proven";
    forgedCrossField.outcome = "READY";
    forgedCrossField.exit_code = 0;
    forgedCrossField.data.target_state = "live_proven";
    forgedCrossField.data.target_ready = true;
    expect(() => SonarTruthEnvelopeSchema.parse(forgedCrossField)).toThrow();
  });

  it("refuses credential-bearing environments without reflecting secrets", async () => {
    const secret = "postgres://operator:do-not-leak@example.invalid/sonar";
    const result = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "produced",
      ],
      { environment: { DATABASE_URL: secret } },
    );
    expect(result.exitCode).toBe(6);
    expect(parse(result.output).findings[0]?.code).toBe(
      "CREDENTIAL_ENV_REFUSED",
    );
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("DATABASE_URL");
  });

  it("scrubs the real process environment before the agent entrypoint runs", () => {
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://operator:must-not-survive@example.invalid";
    try {
      expect(scrubProcessEnvironmentForTruthAgent()).toContain("DATABASE_URL");
      expect(process.env.DATABASE_URL).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prior;
    }
  });

  it("refuses Incur filters and truncation that could corrupt an envelope", async () => {
    const result = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "produced",
        "--token-limit",
        "10",
      ],
      { environment: {} },
    );
    expect(result.exitCode).toBe(1);
    expect(parse(result.output).findings[0]?.code).toBe(
      "UNSAFE_INCUR_SURFACE_REFUSED",
    );
  });

  it("refuses stale lifecycle target aliases", async () => {
    const result = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "reconciled",
      ],
      { environment: {} },
    );
    expect(result.exitCode).toBe(1);
    expect(parse(result.output).findings[0]?.code).toBe(
      "INVALID_TARGET_STATE",
    );
  });

  it("keeps unsupported, trust, and transport failures on exits 3, 4, and 5", async () => {
    const unsupported = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "unknown-collection",
        "--environment",
        "staging",
        "--target-state",
        "produced",
      ],
      { environment: {}, now: () => NOW as never },
    );
    expect(unsupported.exitCode).toBe(3);
    expect(parse(unsupported.output).outcome).toBe("UNSUPPORTED");

    const wrongRoot = await runSonarTruthCli(
      runtime(),
      [
        "verify",
        "--root",
        `sha256:${digest("9")}`,
        "--target-state",
        "produced",
      ],
      { environment: {}, now: () => NOW as never },
    );
    expect(wrongRoot.exitCode).toBe(4);
    expect(parse(wrongRoot.output).outcome).toBe("TRUST_FAILURE");

    const expired = await runSonarTruthCli(
      runtime(),
      [
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "produced",
      ],
      {
        environment: {},
        now: () => "2026-08-12T00:00:00.000Z" as never,
      },
    );
    expect(expired.exitCode).toBe(4);
    expect(parse(expired.output).outcome).toBe("TRUST_FAILURE");

    const transport = spawnSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "src/truth-contract/cli/sonar-truth.ts",
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "produced",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "SONAR_TRUTH_SNAPSHOT_PATH",
          ),
        ),
      },
    );
    expect(transport.status).toBe(5);
    expect(parse(transport.stdout).outcome).toBe("TRANSPORT_FAILURE");
  });

  it("requires envelope, trust-root, and revocation pins at process entry", () => {
    const missingIndependentPins = spawnSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "src/truth-contract/cli/sonar-truth.ts",
        "status",
        "--collection",
        "mibera",
        "--environment",
        "staging",
        "--target-state",
        "produced",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("SONAR_TRUTH_"),
            ),
          ),
          SONAR_TRUTH_SNAPSHOT_PATH: "/not-read-without-complete-pins",
          SONAR_TRUTH_PINNED_KEY_ID: PUBLISHER.keyId,
          SONAR_TRUTH_PINNED_PUBLIC_KEY_HEX: PUBLISHER.publicKeyHex(),
        },
      },
    );
    expect(missingIndependentPins.status).toBe(4);
    expect(parse(missingIndependentPins.stdout)).toMatchObject({
      outcome: "TRUST_FAILURE",
      findings: [{ code: "SNAPSHOT_TRUST_FAILED" }],
    });
  });

  // Cold-starts `pnpm exec tsx` three times (oversized / invalid / missing),
  // which exceeds vitest's default 5s on slower CI runners. Give it headroom.
  it("separates source size, source I/O, and source trust failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "sonar-truth-source-"));
    const oversizedPath = join(directory, "oversized.json");
    const invalidPath = join(directory, "invalid.json");
    writeFileSync(oversizedPath, "x".repeat(256 * 1024 + 1));
    writeFileSync(invalidPath, "{}");
    const run = (snapshotPath: string) =>
      spawnSync(
        "pnpm",
        [
          "exec",
          "tsx",
          "src/truth-contract/cli/sonar-truth.ts",
          "status",
          "--collection",
          "mibera",
          "--environment",
          "staging",
          "--target-state",
          "produced",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            SONAR_TRUTH_SNAPSHOT_PATH: snapshotPath,
            SONAR_TRUTH_PINNED_KEY_ID: "sonar-staged-publisher",
            SONAR_TRUTH_PINNED_PUBLIC_KEY_HEX: "11".repeat(32),
            SONAR_TRUTH_PINNED_ENVELOPE_HASH: "a".repeat(64),
            SONAR_TRUTH_PINNED_TRUST_ROOT_GENERATION: "1",
            SONAR_TRUTH_PINNED_REVOCATION_SEQUENCE: "0",
          },
        },
      );
    try {
      const oversized = run(oversizedPath);
      expect(oversized.status).toBe(6);
      expect(parse(oversized.stdout)).toMatchObject({
        outcome: "INVARIANT_FAILURE",
        findings: [{ code: "INPUT_RESOURCE_LIMIT" }],
      });

      const invalid = run(invalidPath);
      expect(invalid.status).toBe(4);
      expect(parse(invalid.stdout)).toMatchObject({
        outcome: "TRUST_FAILURE",
        findings: [{ code: "SNAPSHOT_TRUST_FAILED" }],
      });

      const unavailable = run(join(directory, "missing.json"));
      expect(unavailable.status).toBe(5);
      expect(parse(unavailable.stdout)).toMatchObject({
        outcome: "TRANSPORT_FAILURE",
        findings: [{ code: "STATUS_SOURCE_UNAVAILABLE" }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
