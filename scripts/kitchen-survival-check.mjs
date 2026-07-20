#!/usr/bin/env node
/**
 * Kitchen survival check (sonar-api#236 / KF-013 companion).
 *
 * Sense-only. Verifies Kitchen durable tables + migration authority exist on
 * KITCHEN_DATABASE_URL, and refuses silent co-location with the belt wipe
 * target (ENVIO_PG_*).
 *
 * Usage:
 *   KITCHEN_DATABASE_URL=… node scripts/kitchen-survival-check.mjs
 *   KITCHEN_DATABASE_URL=… ENVIO_PG_HOST=… … node scripts/kitchen-survival-check.mjs --json
 *
 * Exit: 0 ok · 1 usage/colocated · 2 missing tables · 3 query failure
 */
import pg from "pg";

const EXIT = { OK: 0, FAIL: 1, MISSING: 2, QUERY: 3 };

const REQUIRED_TABLES = [
  "kitchen_ingest_jobs",
  "kitchen_job_correlations",
  "kitchen_job_identity_migration_state",
];

function envioPgUrlFromEnv() {
  const host = process.env.ENVIO_PG_HOST?.trim();
  const port = process.env.ENVIO_PG_PORT?.trim() || "5432";
  const user = process.env.ENVIO_PG_USER?.trim();
  const password = process.env.ENVIO_PG_PASSWORD?.trim();
  const database = process.env.ENVIO_PG_DATABASE?.trim();
  if (!host || !user || !database) return undefined;
  const encodedPassword = password ? encodeURIComponent(password) : "";
  const auth = encodedPassword ? `${user}:${encodedPassword}` : user;
  return `postgresql://${auth}@${host}:${port}/${database}`;
}

function normalizePgUrlForCompare(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    let href = u.href;
    if (href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch {
    return url.trim().replace(/\/+$/, "").split("?")[0] ?? url;
  }
}

function pgPoolConfig(connectionString) {
  const sslMode = process.env.ENVIO_PG_SSL_MODE?.trim() || process.env.KITCHEN_PG_SSL_MODE?.trim();
  const config = { connectionString };
  if (sslMode && sslMode !== "disable" && sslMode !== "false") {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

async function main() {
  const wantJson = process.argv.includes("--json");
  const kitchenUrl = process.env.KITCHEN_DATABASE_URL?.trim();
  if (!kitchenUrl) {
    process.stderr.write("KITCHEN_DATABASE_URL is required\n");
    process.exit(EXIT.FAIL);
  }

  const beltUrl = envioPgUrlFromEnv();
  const colocated =
    beltUrl != null &&
    normalizePgUrlForCompare(kitchenUrl) === normalizePgUrlForCompare(beltUrl);

  if (colocated) {
    const payload = {
      schema_version: 1,
      tool: "kitchen-survival-check",
      sense_only: true,
      observed_at: new Date().toISOString(),
      kitchen_url_set: true,
      belt_url_set: true,
      colocated_with_belt_wipe_target: true,
      ok: false,
      never: [
        "Point KITCHEN_DATABASE_URL at the belt ENVIO_PG wipe target",
        "Skip this check around ENVIO_RESTART=1",
      ],
    };
    if (wantJson) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      process.stderr.write(
        "FAIL: KITCHEN_DATABASE_URL matches ENVIO_PG_* (belt wipe target) — sonar-api#236\n",
      );
    }
    process.exit(EXIT.FAIL);
  }

  const pool = new pg.Pool(pgPoolConfig(kitchenUrl));
  try {
    const present = {};
    for (const table of REQUIRED_TABLES) {
      const r = await pool.query(
        `SELECT to_regclass('public.${table}') IS NOT NULL AS ok`,
      );
      present[table] = Boolean(r.rows[0]?.ok);
    }
    const missing = REQUIRED_TABLES.filter((t) => !present[t]);

    let migration = null;
    if (present.kitchen_job_identity_migration_state) {
      const r = await pool.query(
        `SELECT phase, divergence, reason, updated_at
         FROM kitchen_job_identity_migration_state
         WHERE singleton = true
         LIMIT 1`,
      );
      migration = r.rows[0]
        ? {
            phase: r.rows[0].phase,
            divergence: r.rows[0].divergence,
            reason: r.rows[0].reason,
            updated_at: r.rows[0].updated_at,
          }
        : null;
    }

    const payload = {
      schema_version: 1,
      tool: "kitchen-survival-check",
      sense_only: true,
      observed_at: new Date().toISOString(),
      kitchen_url_set: true,
      belt_url_set: Boolean(beltUrl),
      colocated_with_belt_wipe_target: colocated,
      tables: present,
      migration,
      ok: missing.length === 0 && !colocated && migration != null && migration.divergence !== true,
      never: [
        "Point KITCHEN_DATABASE_URL at the belt ENVIO_PG wipe target",
        "Skip this check around ENVIO_RESTART=1",
      ],
    };

    if (wantJson) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      process.stdout.write(
        `kitchen-survival  ok=${payload.ok}  colocated=${colocated}  migration=${migration?.phase ?? "missing"}\n`,
      );
      for (const t of REQUIRED_TABLES) {
        process.stdout.write(`  table ${t}: ${present[t] ? "present" : "MISSING"}\n`);
      }
      if (colocated) {
        process.stderr.write(
          "FAIL: KITCHEN_DATABASE_URL matches ENVIO_PG_* (belt wipe target) — sonar-api#236\n",
        );
      }
      if (missing.length) {
        process.stderr.write(`FAIL: missing tables: ${missing.join(", ")}\n`);
      }
      if (migration == null) {
        process.stderr.write("FAIL: kitchen_job_identity_migration_state row missing\n");
      } else if (migration.divergence) {
        process.stderr.write(`FAIL: migration divergence: ${migration.reason ?? "unknown"}\n`);
      }
    }

    if (colocated) process.exit(EXIT.FAIL);
    if (missing.length || migration == null || migration.divergence) process.exit(EXIT.MISSING);
    process.exit(EXIT.OK);
  } catch (err) {
    process.stderr.write(`kitchen-survival-check: ${err?.message || err}\n`);
    process.exit(EXIT.QUERY);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
