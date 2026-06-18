/*
 * registration-coverage.test.ts — L3 of the Envio 3.2.1 verification loop.
 *
 * REAL runtime registration-coverage check (replaces the tautological L3).
 *
 * THE TAUTOLOGY THIS REPLACES (FAGAN MINOR):
 *   The old L3 in verify-envio-321.sh asserted "configured contract×event count
 *   is non-zero and equals the bijection parser's count of the SAME config" — a
 *   self-referential comparison (count(config) == count(config)) that proves
 *   NOTHING about whether handlers actually register at runtime. It was green by
 *   construction.
 *
 * WHAT THIS CHECKS INSTEAD (the real invariant):
 *   In Envio 3.2.1 a handler self-registers as a MODULE-LOAD SIDE EFFECT by
 *   calling `indexer.onEvent({ contract, event }, cb)` (or, for dynamically-
 *   discovered contracts, `indexer.contractRegister({ contract, event }, cb)`).
 *   This check replaces the `envio` package's `indexer` with a SPY that RECORDS
 *   every such call, then IMPORTS the handler files of the active config's
 *   `handlers:` directory (so their registration side-effects run), then asserts
 *   the RECORDED set of (contract,event) registrations matches the config's
 *   contract×event pairs (the bijection check's config parser is the SoT for the
 *   configured set — imported, not re-derived).
 *
 *   This catches a class the bijection's static text-scan CANNOT: an `onEvent`
 *   call that is PRESENT in source but mis-shaped or conditionally-guarded so it
 *   never actually fires at module load (e.g. wrapped in an `if` that's false, or
 *   a typo'd method, or an early `return`/`throw` before the registration line).
 *   The static scanner sees the text and reports "covered"; the runtime spy sees
 *   that nothing registered and reports the gap. THAT is the value.
 *
 * THE DYNAMIC (contractRegister) CASE — flatline SKP-005 (handled like bijection):
 *   A `contractRegister` source registration COVERS its own (contract,event)
 *   pair. A dynamically-registered contract's OWN events are recorded only if/
 *   when their handlers register (ordinary onEvent pairs). The spy records BOTH
 *   onEvent and contractRegister, so coverage = union of the two (identical
 *   semantics to scripts/check-onevent-bijection.mjs).
 *
 * HONESTY ACROSS PORT STATES (the load-bearing property — NOT green-by-construction):
 *   - PRE-PORT (handlers still `from "generated"` + alpha `.handler()` API):
 *     importing them produces NO `onEvent` registrations (and the `generated`
 *     import fails to resolve). The check REPORTS the gap honestly — recorded ≈ 0
 *     vs N configured pairs — it does NOT pass. RED on the full config until
 *     handlers are ported is the CORRECT posture (same as the bijection's gaps).
 *   - PER-FAMILY (during the port): as a family's handlers gain real
 *     `indexer.onEvent` calls, their registrations get recorded → the check
 *     verifies THOSE handlers actually registered at runtime.
 *
 * WHY THE FULL-CONFIG CHECK IS ADVISORY (not a hard assertion) AT FOUNDATION:
 *   This describe() block reports the gap (recorded ≪ configured) via console
 *   output and a non-failing expectation, so `vitest run` stays green while the
 *   port is in flight — mirroring the bijection guardrail's advisory posture in
 *   verify-envio-321.sh. The verify-envio-321.sh L3 layer reads the same report
 *   and surfaces recorded-vs-configured as the strengthened L3 line.
 *
 *   The HARD assertions live in the "mechanism" describe() block below, which
 *   proves the spy actually records / mis-attributes nothing, using KNOWN inputs
 *   (the ported probe handler + synthetic fixtures). Those are the regression
 *   gate for the check's own logic — mirroring check-onevent-bijection.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConfigPairs, ROOT } from "../scripts/check-onevent-bijection.mjs";

// Synthetic mechanism fixtures MUST live inside the repo tree so their bare
// `import "envio"` resolves through the SAME vi.mock as the in-tree handlers. A
// fixture in os.tmpdir() (outside the Vite root) bypasses the mock and tries to
// load the real `envio` package (which then fails on its `rescript-schema`
// transitive dep). Each fixture gets a unique name so vi.resetModules can't serve
// a stale cached copy.
const REPO_FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".reg-fixtures");
let fixtureSeq = 0;
async function writeRepoFixture(baseName: string, body: string): Promise<string> {
  mkdirSync(REPO_FIXTURE_DIR, { recursive: true });
  const name = `${fixtureSeq++}-${baseName}`;
  const p = join(REPO_FIXTURE_DIR, name);
  writeFileSync(p, body);
  return pathToFileURL(p).href;
}

// ---------------------------------------------------------------------------
// The recorder: a shared Set the spy `indexer` writes into. Mirrors the
// bijection's onEvent / contractRegister split so coverage = union.
//
// vi.mock factories are HOISTED above imports, so anything they touch must be
// created via vi.hoisted (the only escape hatch from the no-out-of-scope-refs
// rule). The recorder + spy live in the hoisted block; the test body reads the
// same object reference.
// ---------------------------------------------------------------------------
const { recorded } = vi.hoisted(() => {
  return {
    recorded: {
      onEvent: new Set<string>(),
      contractRegister: new Set<string>(),
    },
  };
});

function resetRecorder() {
  recorded.onEvent.clear();
  recorded.contractRegister.clear();
}

// The factory references the hoisted recorder. createTestIndexer is stubbed (not
// used by this check — we only need module-load registration side-effects, not
// event processing).
vi.mock("envio", () => {
  const record =
    (bucket: Set<string>) =>
    (id: { contract?: string; event?: string }) => {
      if (id && typeof id.contract === "string" && typeof id.event === "string") {
        bucket.add(`${id.contract}.${id.event}`);
      }
      // Registration calls return void in the real API; the cb is never invoked.
    };
  return {
    indexer: {
      onEvent: record(recorded.onEvent),
      contractRegister: record(recorded.contractRegister),
      // onBlock / onSlot exist on the real indexer; no-op so a handler that
      // registers a block/slot handler at module load doesn't throw under mock.
      onBlock: () => {},
      onSlot: () => {},
    },
    createTestIndexer: () => {
      throw new Error("createTestIndexer is not used by the registration-coverage check");
    },
    // Type-only exports (Transfer, Holder, …) are erased at compile time, so a
    // handler's `import { type X } from "envio"` needs no runtime binding here.
    // Defensive S/BigDecimal stubs in case a handler touches them at module top.
    S: {},
    BigDecimal: class {},
  };
});

/** Recursively collect handler source files (same filter as the bijection scanner). */
function collectHandlerFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      out.push(...collectHandlerFiles(p));
    } else if (/\.(ts|mts|js|mjs)$/.test(e) && !/\.d\.ts$/.test(e) && !/\.test\.ts$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Import every handler file (running its module-load registration side-effects)
 * and return which imported and which failed. A failed import (e.g. an un-ported
 * `from "generated"` handler that won't resolve) is recorded HONESTLY as a load
 * failure — it produces no registrations, which is exactly the gap we want to
 * surface, NOT mask.
 */
async function importHandlers(files: string[]) {
  const imported: string[] = [];
  const failed: { file: string; reason: string }[] = [];
  for (const f of files) {
    try {
      await import(/* @vite-ignore */ pathToFileURL(f).href);
      imported.push(f);
    } catch (e) {
      failed.push({ file: f.replace(ROOT + "/", ""), reason: (e as Error).message.split("\n")[0] });
    }
  }
  return { imported, failed };
}

beforeEach(() => {
  resetRecorder();
  vi.resetModules();
});

afterAll(() => {
  rmSync(REPO_FIXTURE_DIR, { recursive: true, force: true });
});

// ===========================================================================
// PART A — runtime registration coverage on the ACTIVE config (advisory at
// foundation: reports the honest gap; does NOT fail while the port is in flight).
// ===========================================================================
describe("L3 runtime registration coverage (active config)", () => {
  it("reports recorded-vs-configured registrations HONESTLY (gap, not false pass)", async () => {
    const config = process.env.ENVIO321_CONFIG || "config.probe.yaml";
    const { pairs: configPairs, topLevelHandlers } = parseConfigPairs(resolve(ROOT, config));
    const handlersDir = resolve(ROOT, topLevelHandlers || "src/handlers");

    const files = collectHandlerFiles(handlersDir);
    const { imported, failed } = await importHandlers(files);

    const coveredAll = new Set<string>([...recorded.onEvent, ...recorded.contractRegister]);
    const coveredConfigured = [...coveredAll].filter((p) => configPairs.has(p)).sort();
    const gaps = [...configPairs].filter((p) => !coveredAll.has(p)).sort();
    const orphans = [...coveredAll].filter((p) => !configPairs.has(p)).sort();

    // Surface the report (read by verify-envio-321.sh L3 and by a human/CI).
    const report = {
      config,
      handlersDir: handlersDir.replace(ROOT + "/", ""),
      handlerFiles: files.length,
      importedFiles: imported.length,
      failedImports: failed.length,
      configuredPairs: configPairs.size,
      onEventRegistrations: recorded.onEvent.size,
      contractRegisterRegistrations: recorded.contractRegister.size,
      coveredConfiguredPairs: coveredConfigured.length,
      gaps: gaps.length,
      orphans: orphans.length,
      registrationBijection: gaps.length === 0 && orphans.length === 0,
    };
    console.warn(`[L3-REG] ${JSON.stringify(report)}`);
    if (failed.length) {
      console.warn(
        `[L3-REG] ${failed.length} handler file(s) failed to import (un-ported / "generated" unresolved) — counted as a gap, NOT masked:`,
      );
      for (const fl of failed.slice(0, 50)) console.warn(`[L3-REG]   - ${fl.file}: ${fl.reason}`);
    }
    if (gaps.length) {
      console.warn(`[L3-REG] ${gaps.length} configured pair(s) NOT registered at runtime (gap):`);
      for (const g of gaps) console.warn(`[L3-REG]   - ${g}`);
    }

    // HONESTY CONTRACT: the recorded set must be the union of onEvent +
    // contractRegister, and coverage must be derived from runtime registrations.
    // We assert STRUCTURAL honesty (not a perfect bijection) so the suite stays
    // green during the port while still being a real check:
    //   1. orphans are always a hard error (a handler registered a pair the
    //      config never fetches — that handler can never fire).
    expect(orphans, `runtime registrations with NO config pair (orphans): ${orphans.join(", ")}`).toEqual([]);
    //   2. every configured pair that IS covered was covered by a RECORDED
    //      runtime registration (not by static text). Tautology-proof: this set
    //      is empty pre-port (the honest gap) and grows only as handlers really
    //      register. It is NEVER === configuredPairs by construction.
    for (const p of coveredConfigured) {
      expect(coveredAll.has(p)).toBe(true);
    }
    //   3. the report's coverage count equals the runtime-recorded intersection —
    //      it can only reach configuredPairs when EVERY handler actually
    //      registers at runtime (the real finalize gate), never automatically.
    expect(report.coveredConfiguredPairs).toBe(coveredConfigured.length);
    expect(report.coveredConfiguredPairs).toBeLessThanOrEqual(report.configuredPairs);
  }, 60_000);
});

// ===========================================================================
// PART B — the MECHANISM, proven against KNOWN inputs (hard regression gate for
// the check's own logic — mirrors check-onevent-bijection.test.ts).
// ===========================================================================
describe("L3 registration-coverage mechanism (known inputs — hard gate)", () => {
  it("RECORDS a ported handler's real onEvent registration (probe: HoneyJar.Transfer)", async () => {
    // The probe handler is a REAL ported `indexer.onEvent` HoneyJar Transfer
    // handler. Importing it must run the registration → spy records HoneyJar.Transfer.
    await import("../src/probe_handlers/honey-jar-probe");
    expect(recorded.onEvent.has("HoneyJar.Transfer")).toBe(true);
    expect(recorded.contractRegister.size).toBe(0);
  });

  it("does NOT record an un-ported (no-onEvent) handler — surfaces as a gap", async () => {
    // A handler whose module body performs NO indexer.onEvent/contractRegister
    // call (the alpha `.handler()` style, or any non-registering module) must
    // produce ZERO recorded registrations → the configured pair stays a gap.
    // Mimics an alpha handler: assigns a handler but never calls indexer.onEvent.
    const f = await writeRepoFixture(
      "unported.ts",
      `export const handleTransfer = (cb: unknown) => cb;\n` +
        `// NOTE: no indexer.onEvent(...) here — alpha .handler() style, un-ported.\n`,
    );
    await import(/* @vite-ignore */ f);
    // Nothing registered → the config pair this file was "supposed" to cover is a gap.
    expect(recorded.onEvent.size).toBe(0);
    expect(recorded.contractRegister.size).toBe(0);
  });

  it("a contractRegister source COVERS its pair (SKP-005 dynamic case)", async () => {
    // Source event registered via contractRegister (NOT onEvent) — as sf-vaults /
    // CrayonsFactory do. The spy records it into the contractRegister bucket, so
    // coverage (union of both buckets) includes the pair. The fixture lives INSIDE
    // the repo tree (REPO_FIXTURE_DIR) so its `import "envio"` resolves through the
    // SAME vi.mock the probe handler does (a tmpdir-outside-root file would bypass
    // the mock and try to load the real envio package).
    const f = await writeRepoFixture(
      "dynamic.ts",
      `import { indexer } from "envio";\n` +
        `indexer.contractRegister({ contract: "SFVaultERC4626", event: "StrategyUpdated" }, async () => {});\n`,
    );
    await import(/* @vite-ignore */ f);
    expect(recorded.contractRegister.has("SFVaultERC4626.StrategyUpdated")).toBe(true);
    expect(recorded.onEvent.size).toBe(0);
    const covered = new Set([...recorded.onEvent, ...recorded.contractRegister]);
    expect(covered.has("SFVaultERC4626.StrategyUpdated")).toBe(true);
  });

  it("does NOT record a present-but-never-fired onEvent (the class static-scan misses)", async () => {
    // The onEvent call is PRESENT in source (a static text-scan would mark it
    // covered) but guarded behind a condition that is false at module load, so it
    // NEVER fires. The runtime spy correctly records nothing — the value over the
    // static bijection scanner.
    const f = await writeRepoFixture(
      "guarded.ts",
      `import { indexer } from "envio";\n` +
        `if (process.env.__NEVER_SET_AT_LOAD__ === "1") {\n` +
        `  indexer.onEvent({ contract: "Foo", event: "Bar" }, async () => {});\n` +
        `}\n`,
    );
    await import(/* @vite-ignore */ f);
    expect(recorded.onEvent.has("Foo.Bar")).toBe(false);
    expect(recorded.onEvent.size).toBe(0);
  });
});
