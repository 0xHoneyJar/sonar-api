// ponder-runtime/src/api/index.ts
//
// Minimal Hono app — Ponder 0.16.6 REQUIRES this file (cookbook §D-2). Without
// it the build fails with "API endpoint file not found".
//
// We expose Ponder's default /graphql + a /health probe that the Railway
// readiness gate (SDD §7.3) uses to differentiate liveness (process alive)
// from readiness (post-cold-sync, NATS publisher armed).
//
// `hono` is added to package.json as a direct dep in A-2 (transitively
// available via Ponder, but pnpm doesn't symlink it into top-level
// node_modules without explicit declaration). Operator MUST run
// `pnpm install` to refresh the lockfile before this file typechecks.

// @ts-ignore — hono types resolve at runtime once `pnpm install` regenerates
// the lockfile. package.json adds "hono": "^4.12.23" but the lockfile
// regeneration is a separate operator step.
import { Hono } from "hono";
// @ts-ignore — virtual module from Ponder, declared in ponder-env.d.ts.
import { db } from "ponder:api";
import schema from "ponder:schema";
import { graphql } from "ponder";

const app = new Hono();

// Default Ponder graphql at /graphql — UNCHANGED contract per AC-3 (G-8 LOCKED).
app.use("/graphql", graphql({ db, schema }));

// Liveness — process is up.
app.get("/health", (c: any) => c.json({ status: "ok", role: "ponder-belt-indexer" }));

// Readiness defers to Ponder's built-in /ready endpoint (200 once realtime,
// per SDD §10.3 + cookbook §T-A0.10 gate 2). The HTTP server attaches /ready
// automatically — we don't need a hand-rolled handler here.

export default app;
