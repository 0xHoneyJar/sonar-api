#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_DEPENDENCIES = ["bd-v54z.4", "bd-v54z.5", "bd-v54z.6"];
const ALLOWED_PIN_STATES = ["CI_GREEN_PENDING_MERGE", "MERGED_PINNED"];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read admission receipt: ${error.message}`);
  }
}

function validate(receipt, repoRoot) {
  const violations = [];
  const requireEqual = (actual, expected, field) => {
    if (actual !== expected) {
      violations.push(`${field} must equal ${JSON.stringify(expected)}`);
    }
  };

  requireEqual(receipt.schema_version, "1.0.0", "schema_version");
  requireEqual(receipt.purpose, "OBSERVATIONAL_PLANNING", "purpose");
  requireEqual(receipt.classification, "NON_AUTHORITATIVE", "classification");
  requireEqual(receipt.readiness?.status, "NON_READY", "readiness.status");
  requireEqual(
    receipt.identity?.provider_served_verified,
    false,
    "identity.provider_served_verified",
  );
  requireEqual(
    receipt.score?.artifact_emission_allowed,
    false,
    "score.artifact_emission_allowed",
  );
  requireEqual(
    receipt.score?.consumption_ready,
    false,
    "score.consumption_ready",
  );
  requireEqual(
    receipt.artifact_manifest?.complete,
    true,
    "artifact_manifest.complete",
  );

  const dependencies = receipt.graduation?.dependencies;
  if (!Array.isArray(dependencies)) {
    violations.push("graduation.dependencies must be an array");
  } else {
    for (const dependency of REQUIRED_DEPENDENCIES) {
      if (!dependencies.includes(dependency)) {
        violations.push(`graduation.dependencies must include ${dependency}`);
      }
    }
  }

  const artifacts = receipt.artifact_manifest?.artifacts;
  if (!Array.isArray(artifacts)) {
    violations.push("artifact_manifest.artifacts must be an array");
  } else {
    for (const [index, artifact] of artifacts.entries()) {
      if (artifact.classification !== "NON_AUTHORITATIVE") {
        violations.push(
          `artifact_manifest.artifacts[${index}].classification must equal "NON_AUTHORITATIVE"`,
        );
      }
      if (["score", "production"].includes(artifact.consumer)) {
        violations.push(
          `artifact_manifest.artifacts[${index}].consumer cannot be ${artifact.consumer}`,
        );
      }
      if (
        receipt.stage === "post_dispatch" &&
        !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")
      ) {
        violations.push(
          `artifact_manifest.artifacts[${index}].sha256 must bind post-dispatch output`,
        );
      }
    }
  }

  requireEqual(receipt.campaign?.prior_result, "BLOCKED_EXHAUSTED", "campaign.prior_result");
  requireEqual(receipt.campaign?.current_attempt_budget, 1, "campaign.current_attempt_budget");
  requireEqual(receipt.campaign?.prior_findings_carried, true, "campaign.prior_findings_carried");

  requireEqual(receipt.upstream_pin?.pr, 1228, "upstream_pin.pr");
  if (!ALLOWED_PIN_STATES.includes(receipt.upstream_pin?.status)) {
    violations.push(
      `upstream_pin.status must be one of ${ALLOWED_PIN_STATES.join(", ")}`,
    );
  }
  if (!/^[a-f0-9]{40}$/.test(receipt.upstream_pin?.commit ?? "")) {
    violations.push("upstream_pin.commit must be a full Git commit SHA");
  }
  if (receipt.upstream_pin?.status === "CI_GREEN_PENDING_MERGE") {
    const expiry = Date.parse(receipt.upstream_pin?.expires_at ?? "");
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      violations.push(
        "upstream_pin.expires_at must be a future timestamp while merge is pending",
      );
    }
  }

  requireEqual(
    receipt.production_invariants?.ethereum_start_block,
    12287507,
    "production_invariants.ethereum_start_block",
  );
  requireEqual(
    receipt.production_invariants?.envio_restart,
    "UNSET",
    "production_invariants.envio_restart",
  );
  requireEqual(
    receipt.production_invariants?.mutations_allowed,
    false,
    "production_invariants.mutations_allowed",
  );

  if (process.env.ENVIO_RESTART !== undefined) {
    violations.push("ENVIO_RESTART must be unset in the validator environment");
  }

  const config = readFileSync(resolve(repoRoot, "config.yaml"), "utf8");
  if (!/- id:\s*1\s*\n\s*start_block:\s*12287507(?:\s|#)/m.test(config)) {
    violations.push("config.yaml Ethereum start_block must remain 12287507");
  }

  return violations;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: check-simstim-admission.mjs <receipt.json>");
    process.exit(64);
  }

  const receiptPath = resolve(args[0]);
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch (error) {
    console.error(JSON.stringify({ status: "BLOCKED", violations: [error.message] }));
    process.exit(1);
  }

  const violations = validate(receipt, resolve(import.meta.dirname, ".."));
  if (violations.length > 0) {
    console.error(JSON.stringify({ status: "BLOCKED", violations }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "ADMITTED_OBSERVATIONAL_ONLY",
        classification: receipt.classification,
        readiness: receipt.readiness.status,
        score_artifact_emission_allowed: false,
      },
      null,
      2,
    ),
  );
}

main();
