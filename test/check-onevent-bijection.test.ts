/*
 * check-onevent-bijection.test.ts — unit tests for the silent-drift guardrail.
 *
 * The bijection check (scripts/check-onevent-bijection.mjs) is the gate the
 * 31-handler port converges toward, so its OWN logic must be regression-tested
 * — especially the contractRegister (dynamic) branch (flatline SKP-005), where
 * a naive onEvent-only check would FALSE-FAIL the source events that register
 * downstream contracts at runtime.
 *
 * These tests run the script as a subprocess against synthetic fixture dirs
 * (mktemp), exercising: a perfect bijection, an onEvent gap, an orphan, and the
 * dynamic contractRegister case (both as a coverer and the dynamic contract's
 * own events still needing onEvent).
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-onevent-bijection.mjs");

/** Run the bijection check; return { rc, report }. */
function run(configPath: string, handlersDir: string) {
  let stdout = "";
  let rc = 0;
  try {
    stdout = execFileSync(
      "node",
      [SCRIPT, "--config", configPath, "--handlers", handlersDir, "--json"],
      { encoding: "utf8" },
    );
  } catch (e: any) {
    rc = e.status ?? -1;
    stdout = e.stdout ?? "";
  }
  return { rc, report: JSON.parse(stdout) };
}

/** Build a throwaway fixture: config YAML + handler files. Returns paths. */
function fixture(
  configYaml: string,
  handlerFiles: Record<string, string>,
): { configPath: string; handlersDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bijection-fix-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, configYaml);
  const handlersDir = join(dir, "handlers");
  mkdirSync(handlersDir, { recursive: true });
  for (const [name, body] of Object.entries(handlerFiles)) {
    writeFileSync(join(handlersDir, name), body);
  }
  return { configPath, handlersDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("check-onevent-bijection", () => {
  it("reports a perfect bijection for a single onEvent-covered pair", () => {
    const f = fixture(
      `name: t\nhandlers: handlers\ncontracts:\n  - name: Foo\n    events:\n      - event: Bar(address indexed a)\n`,
      { "foo.ts": `indexer.onEvent({ contract: "Foo", event: "Bar" }, async () => {});\n` },
    );
    try {
      const { rc, report } = run(f.configPath, f.handlersDir);
      expect(rc).toBe(0);
      expect(report.bijection).toBe(true);
      expect(report.configPairs).toBe(1);
      expect(report.onEventSites).toBe(1);
      expect(report.gaps).toEqual([]);
      expect(report.orphans).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("reports a GAP when a config pair has no handler (exit 3)", () => {
    const f = fixture(
      `name: t\nhandlers: handlers\ncontracts:\n  - name: Foo\n    events:\n      - event: Bar(uint256 x)\n`,
      { "noop.ts": `// no registration here\n` },
    );
    try {
      const { rc, report } = run(f.configPath, f.handlersDir);
      expect(rc).toBe(3);
      expect(report.bijection).toBe(false);
      expect(report.gaps).toEqual(["Foo.Bar"]);
      expect(report.orphans).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("reports an ORPHAN when a handler registers a pair not in config (exit 3)", () => {
    const f = fixture(
      `name: t\nhandlers: handlers\ncontracts:\n  - name: Foo\n    events:\n      - event: Bar(uint256 x)\n`,
      {
        "foo.ts":
          `indexer.onEvent({ contract: "Foo", event: "Bar" }, async () => {});\n` +
          `indexer.onEvent({ contract: "Ghost", event: "Phantom" }, async () => {});\n`,
      },
    );
    try {
      const { rc, report } = run(f.configPath, f.handlersDir);
      expect(rc).toBe(3);
      expect(report.gaps).toEqual([]);
      expect(report.orphans).toEqual(["Ghost.Phantom"]);
    } finally {
      f.cleanup();
    }
  });

  it("DYNAMIC (SKP-005): a contractRegister site COVERS the source pair — no false gap", () => {
    // SFVaultERC4626.StrategyUpdated registers downstream contracts dynamically
    // via contractRegister (NOT onEvent). The check must treat it as covered.
    const f = fixture(
      `name: t\nhandlers: handlers\ncontracts:\n` +
        `  - name: SFVaultERC4626\n    events:\n      - event: StrategyUpdated(address indexed oldS, address indexed newS)\n`,
      {
        "sf.ts":
          `indexer.contractRegister({ contract: "SFVaultERC4626", event: "StrategyUpdated" }, async ({ context }) => {\n` +
          `  context.chain.SFMultiRewards.add("0xabc");\n});\n`,
      },
    );
    try {
      const { rc, report } = run(f.configPath, f.handlersDir);
      expect(report.contractRegisterSites).toBe(1);
      expect(report.onEventSites).toBe(0);
      expect(report.gaps).toEqual([]); // NOT a false gap
      expect(report.orphans).toEqual([]);
      expect(rc).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("DYNAMIC (SKP-005): a dynamically-registered contract's OWN events still need onEvent — gap is reported, no false pass", () => {
    // CrayonsCollection is registered dynamically by the factory, but ITS OWN
    // Transfer events still need an onEvent handler. Absent one, it's a real gap.
    const f = fixture(
      `name: t\nhandlers: handlers\ncontracts:\n` +
        `  - name: CrayonsFactory\n    events:\n      - event: Factory__NewERC721Base(address indexed owner, address indexed erc721Base)\n` +
        `  - name: CrayonsCollection\n    events:\n      - event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)\n`,
      {
        // Factory event covered via contractRegister; CrayonsCollection.Transfer NOT covered.
        "crayons.ts":
          `indexer.contractRegister({ contract: "CrayonsFactory", event: "Factory__NewERC721Base" }, async ({ context }) => {\n` +
          `  context.chain.CrayonsCollection.add("0xdef");\n});\n`,
      },
    );
    try {
      const { rc, report } = run(f.configPath, f.handlersDir);
      expect(report.gaps).toEqual(["CrayonsCollection.Transfer"]); // real gap surfaced
      expect(report.orphans).toEqual([]); // factory pair is NOT an orphan (it's covered)
      expect(rc).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  it("ignores commented-out contract entries in config", () => {
    const f = fixture(
      `name: t\nhandlers: handlers\ncontracts:\n` +
        `  - name: Foo\n    events:\n      - event: Bar(uint256 x)\n` +
        `  # - name: Commented\n  #   events:\n  #     - event: Should(uint256 y)\n`,
      { "foo.ts": `indexer.onEvent({ contract: "Foo", event: "Bar" }, async () => {});\n` },
    );
    try {
      const { rc, report } = run(f.configPath, f.handlersDir);
      expect(report.configPairs).toBe(1); // commented entry NOT counted
      expect(rc).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});
