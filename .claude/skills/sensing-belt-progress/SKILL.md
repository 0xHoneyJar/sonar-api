---
name: sensing-belt-progress
description: "Sense Belt (Envio) sync progression and Kitchen preparation job load — tip lag, stall class, ETA, optional tip-RPC cross-check. Emits GECKO STATUS|SIGNAL|MISMATCH tile + --json triage. Sense-only; never sets ENVIO_RESTART."
allowed-tools: [Bash, Read, Grep, Glob]
user-invocable: true
---

# Sensing-Belt-Progress — Belt sync eye (sense-only)

## Purpose

Ask of the live Belt: *are chains catching up, tip-following, or stalled — and what should an agent read next?*

This is the GECKO-shaped lens over the `scripts/belt-progress.mjs` substrate. It detects; it does not wipe, restart, or mutate Kitchen jobs.

## Invocation

```bash
/sensing-belt-progress                       # tile (default; SessionStart-cheap)
/sensing-belt-progress --json                # tile + machine triage envelope
/sensing-belt-progress --console             # human triage (no tile-first)
/sensing-belt-progress --sample              # 2-point rate sample + ETA
```

Zero-dependency runtime (from repo root):

```bash
node scripts/belt-progress.mjs --tile
node scripts/belt-progress.mjs --robot-triage --json
node scripts/belt-progress.mjs sample --samples 2 --interval 15 --json
node scripts/belt-progress.mjs capabilities --json
node scripts/belt-progress.mjs robot-docs guide
```

## What it senses (read-only)

| Signal | Source |
|--------|--------|
| chain head / processed / fetched / events | Hasura `chain_metadata` (`BELT_GRAPHQL_URL`) |
| stall class | Mission-1 classifier twin (FETCH/PROCESS/FULL/SPARSE/TIP/CATCHUP) |
| ETA | lag / processed_bps (needs ≥2 samples or `BELT_PROGRESS_AUTO_SAMPLE=1`) |
| tip RPC delta | optional `eth_blockNumber` via 1rpc (fail-soft) |
| Kitchen jobs | optional `KITCHEN_API_URL` + `SERVICE_TOKEN` → `GET /v2/indexing-status` |

## Tile contract

First stdout line:

```
STATUS|SIGNAL|MISMATCH
```

- `ok` — no `*_STALL` classes
- `drift` — ≥1 FETCH_STALL / PROCESS_STALL / FULL_STALL
- `blind` — GraphQL unavailable (exit 3)

## Hard rules

1. **Sense-only.** Never set `ENVIO_RESTART`. Wipe/resume is KF-013 operator procedure on Railway — not a skill action.
2. Prefer GraphQL over direct Postgres for production observation.
3. When tile is `drift`, run `sample --samples 6` before recommending infrastructure changes.

## Workflow

1. Run the sensor (tile or `--json`).
2. If `blind` → check `BELT_GRAPHQL_URL` / gateway health.
3. If `drift` → sample rates; read belt-indexer logs; do **not** wipe.
4. Optional: merge Kitchen job counts when service token is available.
