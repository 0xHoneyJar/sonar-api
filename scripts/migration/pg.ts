// scripts/migration/pg.ts
//
// Robust `pg` resolver. `pg` is a transitive dependency (pulled in via ponder),
// not a direct one, and the repo's pnpm major-version mismatch makes adding it
// as a direct dep impractical (lockfile churn). So we resolve it from the
// pnpm store via createRequire, falling back to a bare import if the store
// layout changes. This is the ONE place the resolution lives.
//
// We declare a MINIMAL structural type for the slice of node-postgres we use
// (Pool/Client + query/connect/release) so this file typechecks WITHOUT the
// optional `@types/pg` package (pg ships untyped here, transitively). The
// runtime object is the real node-postgres module.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

// ── minimal structural types for the pg surface we touch ──
export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}
export interface PoolClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  release(): void;
}
export interface Pool {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
export interface PoolConfig {
  connectionString?: string;
  application_name?: string;
}
interface PgModule {
  Pool: new (config?: PoolConfig) => Pool;
  Client: new (config?: PoolConfig) => unknown;
  types: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
}

function resolvePg(): PgModule {
  // 1. normal resolution (works if pg ever becomes a direct dep)
  try {
    const req = createRequire(import.meta.url);
    return req("pg") as PgModule;
  } catch {
    /* fall through */
  }
  // 2. pnpm store path (current layout: pg@8.21.0)
  const storeGlobs = [
    "node_modules/.pnpm/pg@8.21.0/node_modules/pg/",
    "node_modules/pg/",
  ];
  for (const g of storeGlobs) {
    const p = resolve(repoRoot, g);
    if (existsSync(p)) {
      const req = createRequire(resolve(p, "package.json"));
      return req("pg") as PgModule;
    }
  }
  throw new Error(
    "could not resolve `pg`. Ensure deps are installed (it ships transitively via ponder).",
  );
}

const pg = resolvePg();
export const Pool = pg.Pool;
export const Client = pg.Client;
export const types = pg.types;
export default pg;
