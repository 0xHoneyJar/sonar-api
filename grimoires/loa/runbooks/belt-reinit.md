# Runbook — Envio Belt Re-Init (generalized, any belt `<X>`)

**Applies to:** any `config.<belt>.yaml` deployment on Railway managed Postgres,
Envio `3.0.0-alpha.17`. Generalizes the KF-013 pattern (first observed on the
mibera belt) to every belt the `sonar-belt-factory` cycle produces. Source of
record for SCALE.md Guardrail 1's in-place exception (replaces the SKP-004
"unverified" labeling).

> One sentence: **`--restart` to SEED schema + `chain_metadata`, then resume to
> BACKFILL.** Resume never runs the Rust-CLI `persisted_state` upsert that 28P01s.

---

## Why this is needed: `isInitialized()` checks tables, not config

`node_modules/envio/src/PgStorage.res.mjs` (`isInitialized`, ~L752):

```js
SELECT table_schema FROM information_schema.tables
WHERE table_schema = '<pgSchema>'
  AND (table_name = 'event_sync_state' OR table_name = '<Chains table>');
// returns true if any row exists
```

It is a **table-existence** check — NOT a config-hash. Consequence: once a belt's
tables exist, a plain redeploy takes the **resume** path. Resume rebuilds chain
state from the DB, not the config:

`ChainFetcher.res.mjs` `makeFromDbState` (~L180):

```js
progressBlockNumber = resumedChainState.progressBlockNumber >= 0
  ? resumedChainState.progressBlockNumber   // continue from DB head
  : resumedChainState.startBlock - 1;        // freshly-seeded row (-1) → start_block
```

Resume **iterates the seeded `chain_metadata` rows**, not the config's chains. A
config chain with no `chain_metadata` row is silently skipped.

---

## The re-init mechanism (`Dockerfile.belt`)

Env-gated, strict literal:

```sh
if [ "$ENVIO_RESTART" = "1" ]; then
  exec pnpm envio start --config config.<belt>.yaml --restart   # fresh init (wipes)
else
  exec pnpm envio start --config config.<belt>.yaml             # resume (safe default)
fi
```

Only the literal `ENVIO_RESTART=1` triggers `--restart`. `ENVIO_RESTART=0`/`false`
do NOT wipe. (The old `${VAR:+--restart}` form fired on any non-empty value — a
destructive footgun, already removed.)

---

## Procedure A — fresh belt init (or seeding new chains)

A true fresh init crashes the Rust-CLI `persisted_state` upsert with **28P01**
*after* the JS layer has already seeded the schema + `chain_metadata`. The seeding
is what matters; let it crash once, then resume.

1. **Set `ENVIO_RESTART=1`** on the belt's Railway service → deploy.
   - JS init wipes + recreates the schema and seeds one `chain_metadata` row per
     config chain (`progressBlockNumber = -1`).
   - Rust CLI then crashes 28P01 on the `persisted_state` upsert. **Expected.**
   - **VERIFICATION GATE (BB F-006) — do not skip.** Confirm seeding is COMPLETE
     before proceeding: `SELECT COUNT(*) FROM chain_metadata` MUST equal the number
     of chains in `config.<belt>.yaml`. If the count is short (JS crashed before
     seeding all chains, or only a subset seeded), the unseeded chains will be
     **silently skipped** on resume (the D6 silent-skip behavior). On a short count,
     **do NOT proceed to step 2** — redeploy with `ENVIO_RESTART=1` again until the
     count matches.
2. **Delete `ENVIO_RESTART`** (remove the var) → redeploy.
   - Boots without `--restart` → **resume** → `makeFromDbState` backfills each
     seeded chain from `start_block` (`-1` → `start_block - 1`). Resume never runs
     the fatal upsert. The belt indexes forever without a `persisted_state` row
     (resume reads `chain_metadata`/`checkpoints`, never `persisted_state`).

**Adding a NEW chain to an existing belt** uses the same dance: resume ignores
config chains absent from `chain_metadata`, so `--restart` to seed the new chain's
row, then resume. ⚠️ `--restart` re-seeds **all** of that belt's chains (full belt
reindex) — see D6 below.

---

## D6 — reset semantics per config-mutation type (CLOSED)

Grounded in `isInitialized` (table-existence) + `makeFromDbState`
(resume-from-`progressBlockNumber`). Empirical confirmation is the S2-T3
blast-radius CI probe; the resume path is code-confirmed here.

| Mutation | Plain resume behavior | Action needed |
|----------|----------------------|---------------|
| Doc-only / handler read-side bug fix (no aggregate-shape change) | No reindex; new code applies forward | redeploy (resume) |
| **New address on an existing chain, deploy block > chain head** | Picked up going forward; **no gap** (no history before head) | redeploy (resume) — **in-place SAFE** |
| **New address on an existing chain, deploy block ≤ chain head** | Indexed only from current head forward; **history before head silently MISSED** | `--restart` the belt (full belt reindex) to backfill |
| New contract on an existing chain (has historical events) | Same as "deploy block ≤ head": history missed on resume | `--restart` the belt |
| New chain added to the belt | **Silently skipped** (no `chain_metadata` row) | `--restart` to seed, then resume |
| Schema/entity change | tables exist → resume keeps old shape | blue-green (Guardrail 1) or `--restart` |

**Key point for Guardrail 1's in-place exception:** in-place is safe **only** when
the new address's deployment block is *after* `latest_processed_block` for *every*
chain it appears on (verified per chain). Otherwise plain resume leaves a coverage
gap and a full belt `--restart` is required.

**Blast-radius (G2):** a `--restart` only re-seeds *that belt's* chains. Sibling
belts (separate deployment + Postgres) are untouched — the cycle's isolation
thesis. Within a belt, however, `--restart` is all-or-nothing across its chains.

---

## DO-NOT (KF-013 — recurrence-aware)

- **Do NOT chase the password** on the 28P01. The creds are correct — the JS layer
  authenticates fine (it seeds the schema). Only the Rust-CLI `persisted_state`
  upsert fails, and resume sidesteps it.
- **Do NOT expect `ENVIO_PG_SSL_MODE=false` to fix the fresh-init crash** — that
  was the 2026-05-20 misdiagnosis. `--restart` still 28P01s with sslmode=false;
  the fix is resume, not SSL. (`false` is a valid no-SSL value, harmless to keep.)
- **Do NOT set `ENVIO_PG_SSL_MODE=disable`** — INVALID; crashes JS env-parsing
  (`Invalid union`) before any DB connection.

See `grimoires/loa/known-failures.md` KF-013 for the full attempts table.
