/*
 * gen-sale-coverage.ts — write sale-coverage.json from the declaration + config.yaml.
 *
 * Run: pnpm coverage:sale        (rewrites the artifact)
 *      pnpm coverage:sale --check (exits 1 if the artifact is stale; used by CI)
 *
 * The artifact is committed so consumers can read it without running this repo.
 * test/sale-coverage.test.ts enforces that it matches what this would generate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildSaleCoverage } from "../src/sale-coverage";

const OUT = "sale-coverage.json";

const rendered = `${JSON.stringify(buildSaleCoverage(readFileSync("config.yaml", "utf8")), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const onDisk = (() => {
    try {
      return readFileSync(OUT, "utf8");
    } catch {
      return "";
    }
  })();
  if (onDisk !== rendered) {
    console.error(
      `${OUT} is stale — config.yaml or the coverage declaration changed. Run: pnpm coverage:sale`,
    );
    process.exit(1);
  }
  console.log(`${OUT} is up to date.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT}`);
}
