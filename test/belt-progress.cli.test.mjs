/**
 * Regression pins for belt-progress agent surface (sense-only).
 * Run: node --test test/belt-progress.cli.test.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "scripts/belt-progress.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      BELT_PROGRESS_NO_TIP_RPC: "1",
      BELT_PROGRESS_AUTO_SAMPLE: "0",
      ...env,
    },
  });
}

test("capabilities --json has required schema keys", () => {
  const r = run(["capabilities", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema_version, 1);
  assert.ok(doc.version);
  assert.ok(doc.contract_version);
  assert.ok(Array.isArray(doc.features));
  assert.ok(doc.features.includes("ownership-ready"));
  assert.ok(Array.isArray(doc.commands));
  assert.ok(doc.commands.some((c) => c.name === "ownership-ready"));
  assert.ok(doc.exit_codes);
  assert.ok(Array.isArray(doc.env_vars));
  assert.equal(doc.sense_only, true);
});

test("ownership-ready requires kitchen env", () => {
  const r = run(["ownership-ready", "--json"], {
    KITCHEN_API_URL: "",
    SERVICE_TOKEN: "",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /KITCHEN_API_URL/);
});

test("robot-docs guide mentions KF-013 / ENVIO_RESTART refusal", () => {
  const r = run(["robot-docs", "guide"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ENVIO_RESTART/);
  assert.match(r.stdout, /KF-013/);
});

test("refuses wipe / ENVIO_RESTART flags with exit 2", () => {
  for (const bad of ["--wipe", "--envio-restart", "ENVIO_RESTART=1", "--force-wipe"]) {
    const r = run([bad]);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /sense-only|Refused/i);
  }
});

test("typo --jsno suggests --json", () => {
  const r = run(["--jsno"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--json/);
});

test("live --tile emits 3-field STATUS line", () => {
  const r = run(["--tile"]);
  if (r.status === 3) {
    assert.match(r.stdout, /^blind\|/);
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim().split("\n")[0];
  const parts = line.split("|");
  assert.equal(parts.length, 3);
  assert.ok(["ok", "drift", "blind"].includes(parts[0]));
});

test("live --robot-triage --json has chains + recommendations", () => {
  const r = run(["--robot-triage", "--json"]);
  if (r.status === 3) {
    const body = JSON.parse(r.stdout);
    assert.equal(body.blind, true);
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.schema_version, 1);
  assert.equal(body.tool, "belt-progress");
  assert.ok(Array.isArray(body.chains));
  assert.ok(Array.isArray(body.recommendations));
  assert.ok(body.summary);
  assert.equal(body.sense_only, true);
});
