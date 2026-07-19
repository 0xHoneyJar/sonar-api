#!/usr/bin/env node
// Thin GECKO wrapper: tile-first, optional --json / --console / --sample.
// Delegates to repo scripts/belt-progress.mjs (sense-only substrate).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// skills/sensing-belt-progress/resources → repo root = ../../../../
const root = join(here, "../../../..");
const substrate = join(root, "scripts/belt-progress.mjs");

const argv = process.argv.slice(2);
const flags = new Set(argv);

let args;
if (flags.has("--sample")) {
  args = ["sample", "--samples", "2", "--interval", "15", "--json"];
} else if (flags.has("--console")) {
  args = ["--robot-triage"];
} else if (flags.has("--json")) {
  // GECKO contract: tile FIRST, then JSON body
  const tile = spawnSync(process.execPath, [substrate, "--tile"], {
    encoding: "utf8",
    cwd: root,
    env: process.env,
  });
  process.stdout.write(tile.stdout || "");
  if (tile.status === 3) process.exit(3);
  const triage = spawnSync(process.execPath, [substrate, "--robot-triage", "--json"], {
    encoding: "utf8",
    cwd: root,
    env: process.env,
  });
  process.stdout.write(triage.stdout || "");
  process.exit(triage.status ?? tile.status ?? 0);
} else {
  // default: tile only
  args = ["--tile"];
}

const result = spawnSync(process.execPath, [substrate, ...args], {
  encoding: "utf8",
  cwd: root,
  env: process.env,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 0);
