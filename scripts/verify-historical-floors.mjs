#!/usr/bin/env node
/**
 * Mission 2 — CI gate: EthTrackedErc721 addresses must not sit in a cohort
 * whose configured start_block is after the registry required_floor, unless
 * explicitly marked partial_operator_approved / blocked.
 *
 * Usage:
 *   node scripts/verify-historical-floors.mjs
 *   node scripts/verify-historical-floors.mjs --registry path/to/registry.json
 *
 * Exit 0 = pass, registry absent (warn), or report-only mode.
 * Exit 1 = unsafe placement when --enforce is set.
 *
 * Default is report-only until operators approve lowering Eth start_block
 * (current floor 13_090_020 is known-unsafe for BAYC/Pudgy/Nouns/…).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enforce = process.argv.includes("--enforce");
const registryPath =
  process.argv.includes("--registry")
    ? resolve(process.argv[process.argv.indexOf("--registry") + 1])
    : resolve(root, "scripts/profiling/floor-registry.w1.json");

const configPath = resolve(root, "config.yaml");

function extractEthTrackedAddresses(yaml) {
  const lines = yaml.split("\n");
  const addrs = [];
  let inEth = false;
  let inContract = false;
  let chainStart = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s+- id: 1\s*$/.test(line)) {
      inEth = true;
      inContract = false;
      continue;
    }
    if (inEth && /^\s+- id: \d+\s*$/.test(line)) {
      inEth = false;
      inContract = false;
    }
    if (inEth && /start_block:\s*(\d+)/.test(line) && chainStart == null) {
      chainStart = Number(RegExp.$1);
    }
    if (inEth && /name:\s*EthTrackedErc721\s*$/.test(line)) {
      inContract = true;
      continue;
    }
    if (inContract && /^\s+- name:\s+\S+/.test(line)) {
      inContract = false;
    }
    if (inContract) {
      const m = line.match(/^\s+- (0x[a-fA-F0-9]{40})\b/);
      if (m) addrs.push(m[1].toLowerCase());
    }
  }
  return { chainStart, addrs };
}

if (!existsSync(registryPath)) {
  console.warn(
    `verify-historical-floors: registry missing at ${registryPath} — skip (warn)`,
  );
  process.exit(0);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const byAddr = new Map(
  registry.map((r) => [String(r.contract).toLowerCase(), r]),
);
const yaml = readFileSync(configPath, "utf8");
const { chainStart, addrs } = extractEthTrackedAddresses(yaml);

if (chainStart == null) {
  console.error("verify-historical-floors: could not parse Ethereum start_block");
  process.exit(1);
}

let failures = 0;
for (const addr of addrs) {
  const row = byAddr.get(addr);
  if (!row) {
    console.error(`FAIL ${addr}: in EthTrackedErc721 but missing from floor registry`);
    failures++;
    continue;
  }
  if (row.blocked) continue;
  if (row.coverage_mode === "partial_operator_approved" || row.partial_operator_approved) {
    continue;
  }
  const required = row.required_floor ?? row.verified_contract_creation_block;
  if (required == null) {
    console.error(`FAIL ${addr}: registry has no required_floor`);
    failures++;
    continue;
  }
  if (chainStart > required) {
    console.error(
      `FAIL ${addr}: configured_start ${chainStart} > required_floor ${required} (gap ${chainStart - required})`,
    );
    failures++;
  }
}

if (failures > 0) {
  const msg =
    `\nverify-historical-floors: ${failures} unsafe placement(s). ` +
    `Lower Eth start_block / cohort floors, or mark partial_operator_approved after operator sign-off.`;
  if (enforce) {
    console.error(msg + " (--enforce)");
    process.exit(1);
  }
  console.warn(msg + " (report-only; pass --enforce to fail CI)");
  process.exit(0);
}

console.log(
  `verify-historical-floors: ok — ${addrs.length} EthTrackedErc721 addresses checked against registry (chain start ${chainStart})`,
);
process.exit(0);
