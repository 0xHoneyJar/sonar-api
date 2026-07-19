import { Effect } from "effect";

import { TruthIntegrityError } from "./errors.js";

export interface TruthRequirementTrace {
  readonly requirement: `FR-${number}`;
  readonly status: "implemented" | "planned";
  readonly modules: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<string>;
  readonly owner: string;
  readonly remaining?: ReadonlyArray<string>;
}

export const TRUTH_REQUIREMENT_TRACEABILITY: ReadonlyArray<TruthRequirementTrace> =
  Object.freeze([
    { requirement: "FR-1", status: "implemented", modules: ["src/truth-contract/schemas/bundle.ts", "src/truth-contract/canonical.ts", "src/truth-contract/bundle-compiler.ts"], tests: ["test/truth-contract.bundle.test.ts"], owner: "bd-v54z.15.3" },
    { requirement: "FR-2", status: "implemented", modules: ["src/truth-contract/schemas/normative.ts", "src/truth-contract/identity-compiler.ts", "src/truth-contract/producer-generation.ts"], tests: ["test/truth-contract.identity-compiler.test.ts", "test/truth-contract.producer-generation.test.ts"], owner: "bd-v54z.17.1" },
    { requirement: "FR-3", status: "implemented", modules: ["src/truth-contract/schemas/normative.ts", "src/truth-contract/normative-compiler.ts", "src/truth-contract/producer-generation.ts"], tests: ["test/truth-contract.normative.test.ts", "test/truth-contract.producer-generation.test.ts"], owner: "bd-v54z.17.2" },
    { requirement: "FR-4", status: "implemented", modules: ["src/truth-contract/schemas/readiness.ts", "src/truth-contract/readiness-evaluator.ts"], tests: ["test/truth-contract.readiness.test.ts"], owner: "bd-v54z.17.3" },
    { requirement: "FR-5", status: "implemented", modules: ["src/truth-contract/reconciliation.ts", "src/truth-contract/reconciliation-generation.ts"], tests: ["test/truth-contract.reconciliation.test.ts"], owner: "bd-v54z.18.2" },
    { requirement: "FR-6", status: "planned", modules: ["src/truth-contract/consumption.ts", "src/truth-contract/staged-proof.ts"], tests: ["test/truth-contract.consumption.test.ts", "test/truth-contract.staged-proof.test.ts"], owner: "bd-v54z.1", remaining: ["Score-owned projection integration", "live serving query and user-meaning receipt", "production Score signer and rollout"] },
    { requirement: "FR-7", status: "planned", modules: ["src/truth-contract/normative-compiler.ts", "src/truth-contract/consumption.ts"], tests: ["test/truth-contract.normative.test.ts", "test/truth-contract.consumption.test.ts"], owner: "bd-v54z.11", remaining: ["consumer compatibility matrix enforcement in Score", "serving-time compatibility recheck"] },
    { requirement: "FR-8", status: "implemented", modules: ["src/truth-contract/status-reader.ts", "src/truth-contract/cli/sonar-truth.ts", "src/truth-contract/cli/mcp.ts"], tests: ["test/truth-contract.status-reader.test.ts", "test/truth-contract.cli.test.ts", "test/truth-contract.mcp.test.ts"], owner: "bd-v54z.19.1" },
    { requirement: "FR-9", status: "implemented", modules: ["src/truth-contract/invalidation.ts", "src/truth-contract/reorg-serving.ts"], tests: ["test/truth-contract.invalidation.test.ts", "test/truth-contract.reorg-serving.test.ts"], owner: "bd-v54z.18.3" },
    { requirement: "FR-10", status: "planned", modules: ["src/truth-contract/bundle-compiler.ts", "src/truth-contract/registry-store.ts", "src/truth-contract/consumption.ts"], tests: ["test/truth-contract.bundle.test.ts", "test/truth-contract.registry-in-memory.test.ts", "test/truth-contract.consumption.test.ts"], owner: "bd-v54z.11", remaining: ["production dual-publish migration window", "consumer cutover and old-generation retirement"] },
    { requirement: "FR-11", status: "implemented", modules: ["src/truth-contract/trust-control-plane.ts", "src/truth-contract/trust-state-store.ts", "src/truth-contract/revocation-control-plane.ts"], tests: ["test/truth-contract.trust-control-plane.test.ts", "test/truth-contract.revocation-control-plane.test.ts"], owner: "bd-v54z.16.3" },
    { requirement: "FR-12", status: "implemented", modules: ["src/truth-contract/registry-store.ts", "src/truth-contract/filesystem-registry-store.ts", "src/truth-contract/registry-projection.ts"], tests: ["test/truth-contract.registry-in-memory.test.ts", "test/truth-contract.registry-filesystem.test.ts", "test/truth-contract.registry-trust-e2e.test.ts"], owner: "bd-v54z.16.2" },
    { requirement: "FR-13", status: "planned", modules: ["src/truth-contract/normative-compiler.ts", "src/truth-contract/invalidation.ts", "src/truth-contract/consumption.ts", "src/truth-contract/status-reader.ts"], tests: ["test/truth-contract.normative.test.ts", "test/truth-contract.invalidation.test.ts", "test/truth-contract.consumption.test.ts", "test/truth-contract.status-reader.test.ts"], owner: "bd-v54z.14", remaining: ["ratified cross-service authority matrix", "production activation and transition grants"] },
  ]);

export const validateTruthRequirementTraceability = (): Effect.Effect<
  void,
  TruthIntegrityError
> =>
  Effect.gen(function* () {
    const expected = Array.from({ length: 13 }, (_, index) => `FR-${index + 1}`);
    const actual = TRUTH_REQUIREMENT_TRACEABILITY.map((entry) => entry.requirement);
    if (
      new Set(actual).size !== actual.length ||
      expected.some((requirement) => !actual.includes(requirement as `FR-${number}`))
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.traceability",
          reason: "FR-1 through FR-13 must each appear exactly once",
        }),
      );
    }
    if (
      TRUTH_REQUIREMENT_TRACEABILITY.some(
        (entry) =>
          entry.modules.length === 0 ||
          entry.tests.length === 0 ||
          entry.modules.some((path) => !path.startsWith("src/truth-contract/")) ||
          entry.tests.some((path) => !path.startsWith("test/truth-contract.")) ||
          (entry.status === "planned" &&
            (entry.remaining === undefined || entry.remaining.length === 0)) ||
          (entry.status === "implemented" && entry.remaining !== undefined) ||
          !/^bd-[A-Za-z0-9.-]+$/.test(entry.owner),
      )
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.traceability",
          reason:
            "every FR requires a module, test class, owner, and explicit planned remainder",
        }),
      );
    }
  });
