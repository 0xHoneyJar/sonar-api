# T-M2 — Envio → Ponder one-off data transform

Implements Sprint M task **T-M2** (migration spec §5 + Appendix B/C). Transforms the
existing envio dataset (`public.*` PascalCase, on blue Postgres-3vIC) into ponder's
`ponder.*` snake_case tables (on Postgres-vRR1), per the column map at
`grimoires/loa/migration/t-m1-entity-column-map.yaml` — a **one-off** (envio is
being retired). NOT reusable migration tooling.

## Files

| File | What |
|---|---|
| `entity-map.ts` | Loads + validates the T-M1 map (the single source of truth). Zero-dependency YAML reader tailored to the map's fixed shape. `tsx entity-map.ts` prints a summary. |
| `pg.ts` | Resolves `pg` (transitive dep) from the pnpm store; minimal self-typed surface. |
| `transform.ts` | The transform. `--dry-run` (read-only), real run, `--only`, `--batch`, `--on-conflict`. |
| `scratch/ddl.ts` | Builds scratch source + target DDL (map-driven) for validation. |
| `scratch/seed.ts` | Synthetic source rows exercising the type-drift + batching surfaces. |
| `scratch/validate.ts` | End-to-end scratch validation harness (33 assertions). |
| `scratch/run-scratch-validation.sh` | Reproducible driver: stands up throwaway Postgres (`:5544`/`:5545`), runs the harness, tears down. |

## Connections (env-var ONLY — sacred)

- `SRC_DATABASE_URL` — envio source (read). In prod = blue Postgres-3vIC.
- `DST_DATABASE_URL` — ponder target (write). In prod = Postgres-vRR1.

Never hardcoded, never defaulted to prod. The transform REFUSES URLs matching
`3vic`/`vrr1` unless `TM2_ALLOW_PROD=I_UNDERSTAND` (set only in the operator-paired
prod session).

## Invoke

`tsx` lives in the pnpm store. From the repo root:

```bash
TSX=node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs

# dry-run (read-only; prints per-entity source counts + planned ops; writes nothing)
SRC_DATABASE_URL=... DST_DATABASE_URL=... node $TSX scripts/migration/transform.ts --dry-run

# real run (all 40 entities; idempotent ON CONFLICT (id) DO UPDATE; triggers off during load)
SRC_DATABASE_URL=... DST_DATABASE_URL=... node $TSX scripts/migration/transform.ts --batch 5000

# subset / tuning
... transform.ts --only action,bgt_boost_event --batch 10000
... transform.ts --on-conflict nothing        # DO NOTHING instead of DO UPDATE
```

## Scratch validation

```bash
bash scripts/migration/scratch/run-scratch-validation.sh   # KEEP=1 to leave containers up
```

Proves: snake_case rename; the 4 type-drifts (jsonb→text serialize, bigint[]→text
`["1","2"]` NOT `{1,2}`); UPSERT idempotency (pass-2 byte-identical, no dupes); batching
(>batch-size table loads completely via keyset pagination); trigger disable/enable cycle
(load succeeds despite the ponder-shaped `live_query` trigger that raises on external INSERT).

## The prod run

This code does NOT run against prod. See `grimoires/loa/migration/t-m2-dry-run-plan.md`
for the operator-paired prod runbook and `grimoires/loa/migration/t-m2-startblock-config.md`
for the ponder `startBlock` config edits.

## Load constraints (migration spec Appendix B — mandatory)

1. **Empty-boot-first**: ponder must boot ONCE on the empty target schema first (it owns
   the DDL + `_ponder_meta` + `_ponder_checkpoint` + `build_id`). The transform does NOT
   create tables; it asserts they exist and hard-errors otherwise.
2. **Triggers-off bulk load**: `DISABLE TRIGGER USER` before insert, `ENABLE` after (in a
   `finally`). Ponder's `live_query` trigger fails an external INSERT outright; `reorg`
   would make frozen rows reorg-revertable.
3. **startBlock double-count fix**: a contract's startBlock is `boundary − overlap` only if
   ALL entities it writes are append-only; any rollup → `boundary` EXACTLY. See the config
   artifact.
