// test/hasura-contract/query-snapshot.test.ts
//
// T-A3.2 — 15 query-snapshot tests against staging Hasura.
//
// Per SDD §4.1 (G-8 LOCKED) + COOKBOOK §C-6: post-cutover, consumer queries
// MUST resolve at the unprefixed root-field name. The 15 fixtures in
// fixtures/queries.json represent the production query shapes per consumer
// (freeside-score real / mediums mixed / sietch-discord synthesized).
//
// Operator runs against staging via:
//   HASURA_URL=https://<staging>.up.railway.app \
//   HASURA_ADMIN_SECRET=*** \
//     pnpm test:hasura
//
// The suite skips cleanly when HASURA_URL is unset (e.g. local CI).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HASURA_URL = process.env.HASURA_URL;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;
const HASURA_ROLE = process.env.HASURA_ROLE ?? "admin";

interface FixtureExpectedShape {
  rootField: string;
  type: "array" | "object";
  itemKeys: string[];
  aggregateKeys?: string[];
}

interface Fixture {
  id: string;
  consumer: string;
  sourceFile: string;
  synthesized: boolean;
  query: string;
  variables: Record<string, unknown>;
  expectedShape: FixtureExpectedShape;
}

interface FixtureFile {
  fixtures: Fixture[];
}

const fixturesPath = resolve(__dirname, "fixtures/queries.json");
const fixturesData = JSON.parse(readFileSync(fixturesPath, "utf-8")) as FixtureFile;

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

async function runQuery(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse> {
  if (!HASURA_URL) throw new Error("HASURA_URL not set — should have been skipped");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (HASURA_ADMIN_SECRET) {
    headers["x-hasura-admin-secret"] = HASURA_ADMIN_SECRET;
  }
  if (HASURA_ROLE && HASURA_ROLE !== "admin") {
    headers["x-hasura-role"] = HASURA_ROLE;
  }
  const response = await fetch(`${HASURA_URL}/v1/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as GraphQLResponse;
}

describe.skipIf(!HASURA_URL)("Hasura query-snapshot suite (T-A3.2)", () => {
  for (const fx of fixturesData.fixtures) {
    const label = `${fx.id} [${fx.consumer}${fx.synthesized ? " · synthesized" : ""}]`;
    it(label, async () => {
      const result = await runQuery(fx.query, fx.variables);

      // (a) No GraphQL errors. Per COOKBOOK §C-6 the most common failure mode is
      // "field 'X' not found in type: 'query_root'" — caught here.
      expect(
        result.errors,
        `GraphQL errors for ${fx.id}: ${JSON.stringify(result.errors)}`,
      ).toBeUndefined();

      // (b) Root field must resolve at the unprefixed name (NOT `ponder_<x>`).
      expect(result.data, "missing data envelope").toBeDefined();
      const root = result.data?.[fx.expectedShape.rootField];
      expect(
        root,
        `expected root field "${fx.expectedShape.rootField}" — got keys: ${Object.keys(result.data ?? {}).join(",")}`,
      ).not.toBeUndefined();

      // (c) Shape assertions.
      if (fx.expectedShape.type === "array") {
        expect(Array.isArray(root), "expected array").toBe(true);
        const rows = root as Array<Record<string, unknown>>;
        // Empty result is allowed (staging may have no data for the variables); but
        // if any row exists, every itemKey must be present.
        if (rows.length > 0) {
          const sample = rows[0];
          for (const key of fx.expectedShape.itemKeys) {
            expect(sample, `row missing key "${key}"`).toHaveProperty(key);
          }
        }
      } else if (fx.expectedShape.type === "object") {
        expect(typeof root, "expected object").toBe("object");
        const obj = root as Record<string, unknown>;
        for (const key of fx.expectedShape.itemKeys) {
          expect(obj, `object missing key "${key}"`).toHaveProperty(key);
        }
        if (fx.expectedShape.aggregateKeys && obj.aggregate) {
          const agg = obj.aggregate as Record<string, unknown>;
          for (const aggKey of fx.expectedShape.aggregateKeys) {
            expect(agg, `aggregate missing "${aggKey}"`).toHaveProperty(aggKey);
          }
        }
      }
    });
  }
});
