#!/usr/bin/env node
/*
 * check-onevent-bijection.mjs — Envio 3.2.1 port silent-drift guardrail.
 *
 * Asserts a BIJECTION between the contract×event pairs declared in a config
 * YAML and the handler-registration call sites in the handlers directory.
 *
 * WHY (the silent-drift failure this closes):
 *   In Envio 3.2.1 a handler self-registers by calling
 *   `indexer.onEvent({ contract, event }, cb)` (or, for dynamically-discovered
 *   contracts, `indexer.contractRegister({ contract, event }, cb)`). The config
 *   YAML separately declares which contract×event pairs the runtime fetches.
 *   If a configured pair has NO matching registration call site, the runtime
 *   silently fetches events that nothing handles — no crash, no log, just a
 *   data gap. If a registration call site names a pair NOT in config, that
 *   handler never fires — also silent. This check makes both halves loud.
 *
 * THE DYNAMIC (contractRegister) CASE — flatline SKP-005:
 *   sf-vaults (SFVaultERC4626.StrategyUpdated, SFVaultStrategyWrapper.
 *   MultiRewardsUpdated) and CrayonsFactory register downstream contracts at
 *   runtime. Those SOURCE events are registered via `contractRegister`, NOT
 *   `onEvent` — so they would FALSE-FAIL a naive onEvent-only check. This
 *   guardrail treats a pair as COVERED if it is registered by EITHER
 *   `onEvent` OR `contractRegister`. Conversely, a contract that is itself
 *   registered dynamically (e.g. CrayonsCollection — commented out of the
 *   chains: section because it has no static address) still needs onEvent
 *   handlers for ITS OWN events; those are ordinary onEvent pairs and are
 *   checked normally. The check neither false-fails the source events nor
 *   false-passes the dynamic contracts' own events.
 *
 * EXIT CODES:
 *   0  perfect bijection (every config pair covered, no orphan call sites)
 *   3  drift detected (gaps and/or orphans) — details printed
 *   2  usage / parse error
 *
 * At the FOUNDATION stage (handlers not yet ported) this WILL report every
 * config pair as a GAP — that is expected and correct. The check itself
 * running and producing an accurate gap list IS the deliverable; a clean
 * bijection is the gate the 31-handler fan-out converges toward.
 *
 * Usage:
 *   node scripts/check-onevent-bijection.mjs [--config config.yaml] [--handlers src/handlers] [--json]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { config: "config.yaml", handlers: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") opts.config = argv[++i];
    else if (a === "--handlers") opts.handlers = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Hand-parse the `contracts:` block of an Envio config YAML.
 *
 * No YAML dependency is available in this node_modules (adding one would force
 * a destructive reinstall), and the config shape is regular and machine-written:
 *   contracts:
 *     - name: <ContractName>
 *       events:
 *         - event: <EventName>(<abi params>)
 * The parser is intentionally narrow: it only reads the contracts→events
 * region (stops at the top-level `chains:` key) and ignores commented lines.
 * Returns Set<"Contract.Event"> plus the top-level `handlers:` dir if present.
 */
export function parseConfigPairs(configPath) {
  const text = readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);

  const pairs = new Set();
  let topLevelHandlers = null;

  let inContracts = false;
  let currentContract = null;

  for (const rawLine of lines) {
    // Strip trailing inline comments only when safe; we mostly care about
    // structural lines. Full-line comments are skipped.
    const line = rawLine.replace(/\r$/, "");
    const trimmedNoLead = line.replace(/^\s+/, "");

    // Top-level keys (column 0, no leading space).
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line)) {
      const key = line.slice(0, line.indexOf(":")).trim();
      if (key === "handlers") {
        topLevelHandlers = line.slice(line.indexOf(":") + 1).trim();
      }
      inContracts = key === "contracts";
      // Any other top-level key (e.g. chains:) ends the contracts region.
      if (key !== "contracts") {
        currentContract = null;
      }
      continue;
    }

    if (!inContracts) continue;
    if (trimmedNoLead.startsWith("#")) continue; // commented-out entry

    // Contract entry: `  - name: Foo`
    const nameMatch = line.match(/^\s{2,}-\s+name:\s*(\S+)/);
    if (nameMatch) {
      currentContract = nameMatch[1];
      continue;
    }

    // Event entry: `      - event: Transfer(address indexed from, ...)`
    const eventMatch = line.match(/^\s{4,}-\s+event:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (eventMatch && currentContract) {
      pairs.add(`${currentContract}.${eventMatch[1]}`);
    }
  }

  return { pairs, topLevelHandlers };
}

/** Recursively collect *.ts / *.mts / *.js / *.mjs files under a directory. */
function collectHandlerFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...collectHandlerFiles(p));
    } else if (/\.(ts|mts|js|mjs)$/.test(e) && !/\.d\.ts$/.test(e) && !/\.test\.ts$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan handler source for registration call sites of BOTH forms:
 *   indexer.onEvent({ contract: "X", event: "Y" }, ...)
 *   indexer.contractRegister({ contract: "X", event: "Y" }, ...)
 * Order-insensitive on the contract/event keys. Returns:
 *   onEvent:          Set<"X.Y">
 *   contractRegister: Set<"X.Y">
 */
function scanRegistrations(files) {
  const onEvent = new Set();
  const contractRegister = new Set();

  // Match `<method>(` then a `{ ... }` options object up to the first close
  // brace, capturing contract + event string literals in either order.
  const callRe = /\bindexer\s*\.\s*(onEvent|contractRegister)\s*\(\s*\{([^}]*)\}/g;
  const contractRe = /\bcontract\s*:\s*["'`]([^"'`]+)["'`]/;
  const eventRe = /\bevent\s*:\s*["'`]([^"'`]+)["'`]/;

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let m;
    while ((m = callRe.exec(text)) !== null) {
      const method = m[1];
      const body = m[2];
      const c = body.match(contractRe);
      const e = body.match(eventRe);
      if (c && e) {
        const key = `${c[1]}.${e[1]}`;
        (method === "onEvent" ? onEvent : contractRegister).add(key);
      }
    }
  }
  return { onEvent, contractRegister };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/check-onevent-bijection.mjs [--config <path>] [--handlers <dir>] [--json]");
    process.exit(0);
  }

  const configPath = resolve(ROOT, opts.config);
  const { pairs: configPairs, topLevelHandlers } = parseConfigPairs(configPath);

  // Handler dir precedence: explicit flag > config's top-level `handlers:` > src/handlers.
  const handlersDir = resolve(
    ROOT,
    opts.handlers || topLevelHandlers || "src/handlers",
  );

  const files = collectHandlerFiles(handlersDir);
  const { onEvent, contractRegister } = scanRegistrations(files);

  // A config pair is COVERED if registered via onEvent OR contractRegister.
  const covered = new Set([...onEvent, ...contractRegister]);

  // GAPS: config pairs with no registration call site (un-ported at this stage).
  const gaps = [...configPairs].filter((p) => !covered.has(p)).sort();

  // ORPHANS: registration call sites with no matching config pair (real error —
  // a handler that registers for an event the runtime never fetches).
  const orphans = [...covered].filter((p) => !configPairs.has(p)).sort();

  const report = {
    config: opts.config,
    handlersDir: handlersDir.replace(ROOT + "/", ""),
    filesScanned: files.length,
    configPairs: configPairs.size,
    onEventSites: onEvent.size,
    contractRegisterSites: contractRegister.size,
    coveredPairs: [...covered].filter((p) => configPairs.has(p)).length,
    gaps,
    orphans,
    bijection: gaps.length === 0 && orphans.length === 0,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[bijection] config:                ${report.config}`);
    console.log(`[bijection] handlers dir:          ${report.handlersDir}`);
    console.log(`[bijection] handler files scanned: ${report.filesScanned}`);
    console.log(`[bijection] config contract×event: ${report.configPairs}`);
    console.log(`[bijection] onEvent call sites:    ${report.onEventSites}`);
    console.log(`[bijection] contractRegister sites: ${report.contractRegisterSites}`);
    console.log(`[bijection] covered config pairs:  ${report.coveredPairs}`);
    if (gaps.length) {
      console.log(`\n[bijection] GAPS — ${gaps.length} configured pair(s) with NO onEvent/contractRegister handler:`);
      for (const g of gaps) console.log(`  - ${g}`);
    }
    if (orphans.length) {
      console.log(`\n[bijection] ORPHANS — ${orphans.length} registration site(s) with NO matching config pair:`);
      for (const o of orphans) console.log(`  - ${o}`);
    }
    console.log(
      report.bijection
        ? "\n[bijection] OK — perfect bijection (every config pair handled, no orphans)."
        : `\n[bijection] DRIFT — ${gaps.length} gap(s), ${orphans.length} orphan(s). (Gaps are EXPECTED until all handlers are ported.)`,
    );
  }

  process.exit(report.bijection ? 0 : 3);
}

// Run the CLI only when invoked directly (`node scripts/check-onevent-bijection.mjs …`),
// NOT when imported for its exported helpers (e.g. parseConfigPairs as the SoT for
// the L3 registration-coverage check). Without this guard, an `import` would run
// main() and call process.exit, killing the importing process.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
