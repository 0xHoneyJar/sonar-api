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

const DIRECT_FETCH_ALLOWLIST: Readonly<Record<string, { maxCalls: number; destination: string }>> = {
  "src/kitchen/ingest-worker.ts": { maxCalls: 1, destination: "operator restart webhook" },
  "src/labels/ensure-schema.ts": { maxCalls: 2, destination: "Hasura control plane" },
  "src/labels/ingest.ts": { maxCalls: 1, destination: "Hasura control plane" },
  "src/self/live/graphql-introspect.live.ts": { maxCalls: 1, destination: "operator GraphQL endpoint" },
  "src/self/live/railway.live.ts": { maxCalls: 1, destination: "Railway API" },
  "src/sense/live/sonar-sense.live.ts": { maxCalls: 1, destination: "operator probe URL" },
  "src/svm/collection-event-indexer.ts": { maxCalls: 1, destination: "Hasura GraphQL" },
  "src/svm/collection-event-source.ts": { maxCalls: 2, destination: "Helius webhook API" },
  "src/svm/collection-event-writer.ts": { maxCalls: 1, destination: "Hasura GraphQL" },
  "src/svm/dune-client.ts": { maxCalls: 1, destination: "Dune API" },
  "src/svm/ensure-kind-constraint.ts": { maxCalls: 1, destination: "Hasura control plane" },
  "src/svm/genesis-stone-indexer.ts": { maxCalls: 1, destination: "Hasura GraphQL" },
  "src/svm/nft-collection-source.ts": { maxCalls: 1, destination: "declared Solana RPC" },
  "src/svm/probe-collection.ts": { maxCalls: 1, destination: "declared DAS RPC" },
  "src/svm/pythians-collection-indexer.ts": { maxCalls: 1, destination: "Hasura GraphQL" },
  "src/svm/sqd-client.ts": { maxCalls: 2, destination: "SQD API" },
  "src/svm/sqd-liveness-monitor.ts": { maxCalls: 1, destination: "SQD reference RPC" },
  "src/svm/sqd-loader.ts": { maxCalls: 1, destination: "Hasura GraphQL" },
  "src/svm/warehouse-loader.ts": { maxCalls: 1, destination: "Hasura GraphQL" },
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

const directFetchCalls = (file: string, source: string): number[] => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    ) {
      lines.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return lines;
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
      const calls = directFetchCalls(file, source);
      const allowance = DIRECT_FETCH_ALLOWLIST[rel];
      if (calls.length > (allowance?.maxCalls ?? 0)) {
        for (const line of calls.slice(allowance?.maxCalls ?? 0)) {
          offenders.push(`${rel}:${line}: direct fetch exceeds structural allowlist`);
        }
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
