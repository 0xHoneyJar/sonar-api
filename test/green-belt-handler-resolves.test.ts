/*
 * green-belt-handler-resolves.test.ts — regression gate for bd-z5sw.
 *
 * THE BUG: config.yaml (the live 6-chain green belt — `BELT_CONFIG=config.yaml`
 * on the belt-indexer-selfhost Railway service) declares `handler:
 * src/EventHandlers.ts` for its contracts, but that file was DELETED at #75
 * (9cf7152f, 2026-06-23) during the Envio 3.2.1 port. The port repointed
 * config.mibera.yaml but left config.yaml's handler references dangling, so
 * `envio codegen --config config.yaml` (and the default `pnpm start`) fail on a
 * missing handler module — the next redeploy of production from HEAD breaks.
 *
 * THE GATE (envio-free, CI-able): parse config.yaml, collect every distinct
 * `handler:` / top-level `handlers:` path, and assert each resolves on disk.
 * RED at the broken HEAD (names the dangling src/EventHandlers.ts); GREEN once
 * the entry point is restored. The `envio codegen` success is the manual/stretch
 * criterion (the envio binary is not installed locally or in CI).
 *
 * NOTE: this gate proves the handler PATHS resolve. Runtime registration
 * coverage (every configured contract×event actually self-registers) is the
 * separate, stronger invariant in test/registration-coverage.test.ts — run it
 * against this belt with `ENVIO321_CONFIG=config.yaml`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const CONFIG = "config.yaml";

// Collect distinct `handler:` and top-level `handlers:` path declarations.
// A regex scan (not a YAML parse) keeps this dependency-free and is sufficient:
// we only need the path values, which are simple scalars.
const configText = readFileSync(resolve(ROOT, CONFIG), "utf8");
const handlerPaths = [
  ...new Set(
    [...configText.matchAll(/^\s*handlers?:\s*['"]?([^'"\s#]+)/gm)].map((m) => m[1]),
  ),
];

describe(`green belt (${CONFIG}): every handler path resolves on disk`, () => {
  it("declares at least one handler path", () => {
    expect(handlerPaths.length).toBeGreaterThan(0);
  });

  it.each(handlerPaths)("resolves %s", (handlerPath) => {
    expect(existsSync(resolve(ROOT, handlerPath))).toBe(true);
  });
});
