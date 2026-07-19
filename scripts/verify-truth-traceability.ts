import { existsSync, readFileSync } from "node:fs";

import { Effect, Exit } from "effect";

import {
  TRUTH_REQUIREMENT_TRACEABILITY,
  validateTruthRequirementTraceability,
} from "../src/truth-contract/traceability.js";

const exit = Effect.runSyncExit(validateTruthRequirementTraceability());
const beads = new Set(
  readFileSync(".beads/issues.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string })
    .map((issue) => issue.id),
);
const unresolved = TRUTH_REQUIREMENT_TRACEABILITY.filter(
  (entry) =>
    !beads.has(entry.owner) ||
    (entry.status === "implemented" &&
      [...entry.modules, ...entry.tests].some((path) => !existsSync(path))),
);
const failed = Exit.isFailure(exit) || unresolved.length > 0;
const implemented = TRUTH_REQUIREMENT_TRACEABILITY.filter(
  (entry) => entry.status === "implemented",
).length;

if (failed) {
  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      gate: "sonar.truth-contract.traceability",
      status: "FAIL",
      requirements: TRUTH_REQUIREMENT_TRACEABILITY.length,
      implemented,
      planned: TRUTH_REQUIREMENT_TRACEABILITY.length - implemented,
      unresolved: unresolved.map((entry) => entry.requirement),
    })}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      gate: "sonar.truth-contract.traceability",
      status: "PASS",
      requirements: TRUTH_REQUIREMENT_TRACEABILITY.length,
      implemented,
      planned: TRUTH_REQUIREMENT_TRACEABILITY.length - implemented,
    })}\n`,
  );
}
