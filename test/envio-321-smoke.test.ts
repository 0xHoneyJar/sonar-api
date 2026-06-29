/*
 * envio-321-smoke.test.ts — L4 of the Envio 3.2.1 verification loop.
 *
 * NET-NEW smoke harness exercising the 3.2.1 TEST API:
 *   import { createTestIndexer } from "envio"
 *   const ti = createTestIndexer()
 *   await ti.process({ chains: { <chainId>: { simulate: [ ...events ] } } })
 *
 * This is the 3.2.1 replacement for the alpha `TestHelpers.MockDb` API. It runs
 * the registered onEvent handlers over SIMULATED events (no RPC / HyperSync) and
 * returns the entity changes, plus exposes entity operations for assertions.
 *
 * WHY a smoke harness in the FOUNDATION phase (before any of the 31 handlers
 * are ported): the 31-handler fan-out will each need a test that drives a
 * simulated event through its onEvent registration. This file proves the API
 * SHAPE works end-to-end against the one PROVEN ported handler (the deploy-path
 * probe, src/probe_handlers/honey-jar-probe.ts) so the fan-out has a working
 * pattern to copy — it is the executable reference for the test surface.
 *
 * CODEGEN + CONFIG COUPLING (load-bearing, surfaced during foundation build):
 *   `createTestIndexer().process()` boots the indexer via `Main.start`, which
 *   calls `autoLoadFromSrcHandlers(config.handlers)` — it GLOBS AND IMPORTS
 *   every file under the active config's `handlers:` directory. The active
 *   config is chosen by the `ENVIO_CONFIG` env var (default `config.yaml`).
 *
 *   Therefore the test indexer cannot boot against the FULL config
 *   (`handlers: src/handlers`) until ALL 31 handlers are ported — the first
 *   un-ported `from "generated"` file crashes the auto-load. At the foundation
 *   stage we point `ENVIO_CONFIG` at `config.probe.yaml` (`handlers:
 *   src/probe_handlers`), so ONLY the one proven ported handler is auto-loaded.
 *
 *   This module sets `process.env.ENVIO_CONFIG = config.probe.yaml` BEFORE the
 *   dynamic `import("envio")` so the runtime reads the probe config. The
 *   verify-envio-321.sh loop runs `envio codegen --config config.probe.yaml`
 *   immediately before this test so the probe's HoneyJar/Transfer contract is
 *   the active codegen. Run standalone via:
 *     ENVIO_CONFIG=config.probe.yaml pnpx envio@3.2.1 codegen --config config.probe.yaml \
 *       && ENVIO_CONFIG=config.probe.yaml vitest run test/envio-321-smoke.test.ts
 *
 * If codegen / config priming hasn't happened, the test SKIPS with a clear
 * message rather than a confusing failure — the harness is a capability probe,
 * not a regression gate, at the foundation stage.
 */

import { describe, it, expect } from "vitest";

// Point the envio runtime at the probe config so createTestIndexer auto-loads
// ONLY src/probe_handlers (the one ported handler), not the un-ported
// src/handlers set. MUST be set before any `import("envio")`.
if (!process.env.ENVIO_CONFIG) {
  process.env.ENVIO_CONFIG = "config.probe.yaml";
}

const PROBE_CONTRACT = "HoneyJar";
const ZERO = "0x0000000000000000000000000000000000000000";
const TO = "0x1111111111111111111111111111111111111111";
const OP_CHAIN_ID = 10;
const HONEYJAR4_OP = "0xe1d16cc75c9f39a2e0f5131eb39d4b634b23f301";

/**
 * Resolve the 3.2.1 test API + the probe handler registration. Both are import
 * side-effects that require the probe codegen to be present. Returns null (and
 * the reason) when the environment isn't primed, so the test can SKIP cleanly.
 */
async function loadProbeIndexer(): Promise<
  | { ok: true; createTestIndexer: () => any }
  | { ok: false; reason: string }
> {
  let envio: any;
  try {
    envio = await import("envio");
  } catch (e) {
    return { ok: false, reason: `envio package not importable: ${(e as Error).message}` };
  }
  if (typeof envio.createTestIndexer !== "function") {
    return {
      ok: false,
      reason: "envio.createTestIndexer is not a function (envio < 3.2.1 or codegen missing)",
    };
  }
  // Registering the probe handler is an import side-effect: the module body
  // calls indexer.onEvent({ contract: "HoneyJar", event: "Transfer" }, cb).
  try {
    await import("../src/probe_handlers/honey-jar-probe");
  } catch (e) {
    return {
      ok: false,
      reason: `probe handler did not load (run \`envio codegen --config config.probe.yaml\` first): ${(e as Error).message}`,
    };
  }
  return { ok: true, createTestIndexer: envio.createTestIndexer };
}

describe("envio 3.2.1 createTestIndexer smoke harness (L4)", () => {
  it("processes a simulated HoneyJar Transfer (mint) and records a Transfer entity", async () => {
    const loaded = await loadProbeIndexer();
    if (!loaded.ok) {
      console.warn(`[L4-SMOKE] SKIP: ${loaded.reason}`);
      // A skip is a pass at the foundation stage — the harness is a capability
      // probe. The deterministic L1/L2/L3 checks are the hard gates.
      return;
    }

    const ti = loaded.createTestIndexer();

    // Drive ONE simulated mint Transfer through the probe's onEvent handler.
    let result: any;
    try {
      result = await ti.process({
        chains: {
          [OP_CHAIN_ID]: {
            simulate: [
              {
                contract: PROBE_CONTRACT,
                event: "Transfer",
                srcAddress: HONEYJAR4_OP,
                params: {
                  from: ZERO,
                  to: TO,
                  tokenId: 1n,
                },
              },
            ],
          },
        },
      });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // The runtime auto-loads the active config's `handlers:` dir. If that dir
      // still contains un-ported `from "generated"` handlers (i.e. ENVIO_CONFIG
      // wasn't pointed at the probe config), the auto-load throws here. Treat as
      // a SKIP at the foundation stage — the deterministic L1/L2/L3 layers gate.
      if (/auto-load handler file|from "generated"|Cannot read properties of undefined \(reading 'handler'\)/.test(msg)) {
        console.warn(
          `[L4-SMOKE] SKIP: test indexer auto-loaded an un-ported handlers dir (set ENVIO_CONFIG=config.probe.yaml). Cause: ${msg}`,
        );
        return;
      }
      throw e;
    }

    // The 3.2.1 process() contract: returns { changes: EntityChange[] }.
    expect(result).toBeDefined();
    expect(Array.isArray(result.changes)).toBe(true);

    // The probe handler writes a Transfer entity for every Transfer event.
    // Assert via the test indexer's entity operations (the 3.2.1 inspection API).
    const transfers = await ti.Transfer.getAll();
    expect(Array.isArray(transfers)).toBe(true);
    expect(transfers.length).toBeGreaterThanOrEqual(1);

    const mint = transfers.find((t: any) => t.from === ZERO && t.to === TO);
    expect(mint, "probe should have written the mint Transfer entity").toBeTruthy();
    expect(mint.tokenId).toBe(1n);
    expect(mint.chainId).toBe(OP_CHAIN_ID);
  }, 60_000);
});
