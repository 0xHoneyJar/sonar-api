import { defineConfig } from "vitest/config";

/**
 * Vitest config for envio-indexer (sonar-api).
 *
 * Scopes test discovery to project-owned tests:
 *  - test/                  legacy envio unit tests (chai-based may be skipped)
 *  - src/kitchen/           kitchen upstream API (ordering-service probe + ingest)
 *  - src/                   envio src unit tests (e.g. .spec.ts colocated)
 *
 * EXCLUDED (sacred no-touch from sprint A-2 perspective):
 *  - .claude/    Loa framework internals — has its own test harness (`bats` for
 *                some, custom adapters for others). vitest discovers ~60+
 *                .test.ts files there that aren't designed for plain vitest.
 *  - evals/      eval fixtures (buggy code intentionally — not meant to pass)
 *  - spike/      exploration sketches
 *  - generated/  envio codegen output
 *  - node_modules/
 */
export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "src/kitchen/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
    ],
    exclude: [
      "**/node_modules/**",
      ".claude/**",
      "evals/**",
      "spike/**",
      "generated/**",
      ".loa/**",
      ".run/**",
      ".beads/**",
      "grimoires/**",
      // Pre-existing broken: imports `chai` which is not in devDependencies.
      // Predates feat/ponder-migration-A-2 (see commit 8e601693 on main).
      // Not in scope for A-2; flagged for separate cleanup.
      "test/fatbera-core.test.ts",
    ],
  },
});
