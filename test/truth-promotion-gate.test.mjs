import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const verifier = join(process.cwd(), "scripts", "verify-truth-promotion.sh");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "sonar-truth-promotion-"));
  mkdirSync(join(root, "grimoires", "loa"), { recursive: true });

  const documents = {
    "grimoires/loa/prd.md": "# PRD\napproved\n",
    "grimoires/loa/sdd.md": "# SDD\napproved\n",
    "grimoires/loa/sprint.md": "# Sprint\napproved\n",
  };

  for (const [path, body] of Object.entries(documents)) {
    writeFileSync(join(root, path), body);
  }
  writeFileSync(
    join(root, "config.yaml"),
    "name: fixture\nchains:\n  - id: 1\n    start_block: 12287507\n",
  );

  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "remote", "add", "origin", "https://github.com/0xHoneyJar/sonar-api.git");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture base");
  const baseCommit = git(root, "rev-parse", "HEAD");

  const receipt = {
    schema: "loa.operator-promotion-receipt.v1",
    repository: "0xHoneyJar/sonar-api",
    remote: "https://github.com/0xHoneyJar/sonar-api.git",
    base_commit: baseCommit,
    approved_at: "2026-07-19T03:19:19Z",
    approved_by: "operator:fixture",
    attestation_kind: "self_attested_conversation_approval",
    approval_source: "fixture approval",
    implementation_authorized: true,
    scope: { included: ["fixture"], excluded: ["production"] },
    documents: Object.fromEntries(
      Object.entries(documents).map(([path, body]) => [path, `sha256:${sha256(body)}`]),
    ),
    flatline: {
      prd: "completed_bounded",
      sdd: "completed_bounded",
      sprint: "two_attempt_campaign_complete_post_review_remedies_integrated",
    },
    production_invariants: {
      ethereum_start_block: "12287507",
      envio_restart: "unset",
      floor_lowering: false,
      wipe: false,
      kf_013_replay: false,
    },
    cryptographic_signature: null,
    signature_note: "fixture",
  };

  writeFileSync(
    join(root, "grimoires", "loa", "promotion-receipt.sonar-score-v1.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seal receipt");
  return root;
};

const verify = (root, env = process.env) =>
  spawnSync(verifier, ["--root", root], {
    encoding: "utf8",
    env,
  });

describe("truth promotion gate", () => {
  it("accepts committed approved digests and invariants", () => {
    const result = verify(makeFixture());
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      {
        ...JSON.parse(result.stdout),
        receipt: undefined,
        base_commit: undefined,
        head: undefined,
      },
      {
        schema: "sonar.truth-promotion-verification.v1",
        status: "PASS",
        implementation_authorized: true,
        production_authority: false,
        receipt: undefined,
        base_commit: undefined,
        head: undefined,
      },
    );
  });

  it("fails closed when an approved document is changed", () => {
    const root = makeFixture();
    const path = join(root, "grimoires", "loa", "prd.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}tampered\n`);

    const result = verify(root);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "DOCUMENT_DIRTY");
  });

  it("fails closed when ENVIO_RESTART is present, even if empty", () => {
    const result = verify(makeFixture(), { ...process.env, ENVIO_RESTART: "" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "ENVIO_RESTART_SET");
  });

  it("fails closed when the Ethereum floor changes", () => {
    const root = makeFixture();
    writeFileSync(
      join(root, "config.yaml"),
      "name: fixture\nchains:\n  - id: 1\n    start_block: 12287508\n",
    );

    const result = verify(root);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "ETHEREUM_FLOOR_MISMATCH");
  });
});
