/**
 * CR-004 — prove browser / client code never fetches arbitrary metadata origins.
 *
 * sonar-api is server-only. This suite statically asserts there is no browser
 * package that loads collection metadata URLs, and that the egress boundary is
 * the declared sole network path for metadata workers.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  METADATA_EGRESS_RUNTIME,
  assertServerOnlyMetadataEgress,
} from "../src/metadata-egress/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const walkFiles = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "build" ||
      entry === "generated" ||
      entry === ".claude" ||
      entry === ".loa"
    ) {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
};

describe("CR-004 browser metadata boundary", () => {
  it("declares metadata egress as node/server runtime only", () => {
    expect(METADATA_EGRESS_RUNTIME).toBe("node");
    expect(() => assertServerOnlyMetadataEgress()).not.toThrow();
  });

  it("has no browser/client app package that could fetch metadata origins", () => {
    for (const forbidden of [
      "apps/web",
      "apps/dashboard",
      "src/client",
      "src/browser",
      "public",
      "pages",
    ]) {
      expect(existsSync(join(ROOT, forbidden)), forbidden).toBe(false);
    }
  });

  it("keeps retrieveMetadata as the sole metadata network export path", () => {
    const files = walkFiles(join(ROOT, "src"));
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel.startsWith("src/metadata-egress/")) continue;
      // Operator-configured infrastructure fetchers (Hasura/RPC/Dune/etc.) are
      // out of CR-004 scope; only flag collection-metadata shaped URL fetches.
      const source = readFileSync(file, "utf8");
      // Flag only collection-metadata URI fetches — not Hasura /v1/metadata admin.
      if (
        /fetch\(\s*(?:tokenUri|metadataUri|imageUri|json_uri|jsonUri)\b/i.test(source) ||
        /fetch\(\s*(?:uri|url)\s*[,)]/i.test(source) &&
          /tokenUri|metadataUri|collection.?metadata/i.test(source)
      ) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("wires resolver and report workers through metadata-egress ports only", () => {
    const resolverPort = readFileSync(
      join(ROOT, "src/metadata-egress/resolver-port.ts"),
      "utf8",
    );
    const reportPort = readFileSync(
      join(ROOT, "src/metadata-egress/report-worker-port.ts"),
      "utf8",
    );
    const collectionIndex = readFileSync(
      join(ROOT, "src/collection-resolver/index.ts"),
      "utf8",
    );

    expect(resolverPort).toContain("createMetadataEgressClient");
    expect(reportPort).toContain("createMetadataEgressClient");
    expect(collectionIndex).toContain("createResolverMetadataPort");
    expect(collectionIndex).toContain("../metadata-egress/resolver-port.js");
  });
});
