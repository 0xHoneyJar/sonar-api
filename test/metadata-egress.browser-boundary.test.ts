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
import ts from "typescript";
import {
  METADATA_EGRESS_RUNTIME,
  assertServerOnlyMetadataEgress,
} from "../src/metadata-egress/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Exact audited infrastructure call sites. Any new direct fetch in src fails
// this test and must either route through metadata-egress or be explicitly
// reviewed as non-metadata infrastructure transport.
// Exact audited direct-fetch cardinality. A file-level allowlist alone lets a
// future metadata fetch hide beside an unrelated transport; any added call now
// fails until its owning boundary is explicitly reviewed.
const NON_METADATA_FETCH_CALLS: Readonly<Record<string, number>> = {
  "src/kitchen/ingest-worker.ts": 1,
  "src/labels/ensure-schema.ts": 2,
  "src/labels/ingest.ts": 1,
  "src/self/live/graphql-introspect.live.ts": 1,
  "src/self/live/railway.live.ts": 1,
  "src/sense/live/sonar-sense.live.ts": 1,
  "src/svm/collection-event-indexer.ts": 1,
  "src/svm/collection-event-source.ts": 2,
  "src/svm/collection-event-writer.ts": 1,
  "src/svm/dune-client.ts": 1,
  "src/svm/ensure-kind-constraint.ts": 1,
  "src/svm/genesis-stone-indexer.ts": 1,
  "src/svm/nft-collection-source.ts": 1,
  "src/svm/probe-collection.ts": 1,
  "src/svm/pythians-collection-indexer.ts": 1,
  "src/svm/sqd-client.ts": 2,
  "src/svm/sqd-liveness-monitor.ts": 1,
  "src/svm/sqd-loader.ts": 1,
  "src/svm/warehouse-loader.ts": 1,
};

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

const countDirectFetchCalls = (file: string, source: string): number => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return count;
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
      const source = readFileSync(file, "utf8");
      const count = countDirectFetchCalls(file, source);
      const expected = NON_METADATA_FETCH_CALLS[rel] ?? 0;
      if (count !== expected) {
        offenders.push(`${rel}: expected ${expected}, observed ${count}`);
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
