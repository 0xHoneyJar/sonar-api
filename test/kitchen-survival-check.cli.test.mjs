/**
 * Hermetic pins for kitchen-survival-check (sonar-api#236).
 * Run: node --test test/kitchen-survival-check.cli.test.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "scripts/kitchen-survival-check.mjs");

function run(env = {}) {
  return spawnSync(process.execPath, [cli, "--json"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...env },
  });
}

test("requires KITCHEN_DATABASE_URL", () => {
  const r = run({
    KITCHEN_DATABASE_URL: "",
    ENVIO_PG_HOST: "",
    ENVIO_PG_USER: "",
    ENVIO_PG_DATABASE: "",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /KITCHEN_DATABASE_URL/);
});

test("fails fast when Kitchen URL matches ENVIO_PG wipe target", () => {
  const url = "postgresql://u:p@shared-host:5432/envio";
  const r = run({
    KITCHEN_DATABASE_URL: url,
    ENVIO_PG_HOST: "shared-host",
    ENVIO_PG_PORT: "5432",
    ENVIO_PG_USER: "u",
    ENVIO_PG_PASSWORD: "p",
    ENVIO_PG_DATABASE: "envio",
  });
  assert.equal(r.status, 1, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.colocated_with_belt_wipe_target, true);
  assert.equal(body.ok, false);
});
