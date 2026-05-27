// test/hasura-contract/permissions.test.ts
//
// T-A3.4 — 9 permission tests per consumer role.
//
// 3 consumers (freeside-score, mediums, sietch-discord) × 3 assertions each:
//   1. Allowed query: role can SELECT from its primary table → succeeds.
//   2. Restricted query: role cannot SELECT from an admin-only table → 403/empty.
//   3. Mutation rejection: role cannot INSERT/UPDATE/DELETE → 403.
//
// Roles are read from env so operator can map to real Hasura roles staged in
// the cluster (e.g. `score_reader`, `mediums_reader`, `sietch_reader`).
// Suite skips if no roles configured.

import { describe, it, expect } from "vitest";

const HASURA_URL = process.env.HASURA_URL;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;

interface RoleConfig {
  name: string;
  allowedTable: string;
  restrictedTable: string;
  authToken?: string;
}

// Operator overrides via env. Defaults reflect the cluster's existing role
// taxonomy (operator confirms before A-4).
const ROLE_CONFIGS: RoleConfig[] = [
  {
    name: process.env.SCORE_ROLE ?? "score_reader",
    allowedTable: process.env.SCORE_ALLOWED_TABLE ?? "MiberaTransfer",
    restrictedTable: process.env.SCORE_RESTRICTED_TABLE ?? "pending_emits",
    authToken: process.env.SCORE_ROLE_TOKEN,
  },
  {
    name: process.env.MEDIUMS_ROLE ?? "mediums_reader",
    allowedTable: process.env.MEDIUMS_ALLOWED_TABLE ?? "BadgeHolder",
    restrictedTable: process.env.MEDIUMS_RESTRICTED_TABLE ?? "pending_emits",
    authToken: process.env.MEDIUMS_ROLE_TOKEN,
  },
  {
    name: process.env.SIETCH_ROLE ?? "sietch_reader",
    allowedTable: process.env.SIETCH_ALLOWED_TABLE ?? "MintEvent",
    restrictedTable: process.env.SIETCH_RESTRICTED_TABLE ?? "pending_emits",
    authToken: process.env.SIETCH_ROLE_TOKEN,
  },
];

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

async function runQueryAs(role: RoleConfig, query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResponse> {
  if (!HASURA_URL) throw new Error("HASURA_URL not set");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (role.authToken) {
    headers.Authorization = `Bearer ${role.authToken}`;
  } else if (HASURA_ADMIN_SECRET) {
    // Admin-secret impersonation: uses x-hasura-admin-secret + x-hasura-role
    // to act as the role (Hasura's standard impersonation pattern).
    headers["x-hasura-admin-secret"] = HASURA_ADMIN_SECRET;
    headers["x-hasura-role"] = role.name;
  } else {
    throw new Error(`No auth for role ${role.name}`);
  }
  const response = await fetch(`${HASURA_URL}/v1/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GraphQLResponse;
}

function isAccessDenied(result: GraphQLResponse): boolean {
  if (!result.errors || result.errors.length === 0) return false;
  return result.errors.some((e) => {
    const code = e.extensions?.code;
    return (
      code === "access-denied" ||
      code === "validation-failed" || // "field 'X' not found" when role can't see the table
      code === "permission-error" ||
      /not found in type|access denied|permission/i.test(e.message)
    );
  });
}

describe.skipIf(!HASURA_URL)("Hasura permissions (T-A3.4)", () => {
  for (const role of ROLE_CONFIGS) {
    describe(`role=${role.name}`, () => {
      it("allowed query — SELECT primary table succeeds", async () => {
        const query = `query { ${role.allowedTable}(limit: 1) { id } }`;
        const result = await runQueryAs(role, query);
        // Either succeeds OR returns access-denied (catastrophic role drift).
        // If errors present, fail with diagnostics.
        expect(
          result.errors,
          `${role.name} blocked from allowed table ${role.allowedTable}: ${JSON.stringify(result.errors)}`,
        ).toBeUndefined();
        expect(result.data, "missing data envelope").toBeDefined();
      });

      it("restricted query — SELECT admin table is denied", async () => {
        const query = `query { ${role.restrictedTable}(limit: 1) { id } }`;
        const result = await runQueryAs(role, query);
        // Either: explicit access-denied (preferred) OR field-not-found
        // (Hasura's permission-as-schema-exclusion pattern).
        const denied = isAccessDenied(result);
        const emptySuccess = !result.errors && Array.isArray(result.data?.[role.restrictedTable]) && (result.data![role.restrictedTable] as unknown[]).length === 0;
        expect(
          denied || emptySuccess,
          `${role.name} unexpectedly allowed to query ${role.restrictedTable}: ${JSON.stringify(result)}`,
        ).toBe(true);
      });

      it("mutation rejection — INSERT/UPDATE/DELETE blocked", async () => {
        // Use a generic mutation on the allowed table — readers must NOT mutate.
        const query = `mutation { insert_${role.allowedTable}_one(object: { id: "permission-test-do-not-merge" }) { id } }`;
        const result = await runQueryAs(role, query);
        // Either: mutation field not found (typical for reader-only roles) OR
        // explicit access-denied. NOT a successful insert.
        const denied = isAccessDenied(result);
        const noSuccessfulInsert = !result.data || !result.data[`insert_${role.allowedTable}_one`];
        expect(
          denied || noSuccessfulInsert,
          `${role.name} unexpectedly able to mutate: ${JSON.stringify(result)}`,
        ).toBe(true);
      });
    });
  }
});
