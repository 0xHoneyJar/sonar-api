# Architecture Overview

> Ride 2026-07-19

## System components

1. **EVM belt (Envio)** — `config.yaml` + `src/handlers/*` + `src/EventHandlers.ts` index 6 chains into Postgres.
2. **GraphQL edge** — Hasura over belt Postgres; Caddy gateway publishes stable alias.
3. **Promote control plane** — `scripts/promote.sh` swaps `BELT_UPSTREAM` after gate PASS.
4. **Kitchen** — Hono service for collection status/ingest + config patching.
5. **SVM lane** — SQD stream + warehouse history + Helius tail → `svm.collection_event` (and related).
6. **Canonical contract** — `src/canonical` maps EVM/SVM legs to `NftActivity` for cross-building parity.

## Data flows

```
Chain logs → Envio handlers → entities (Token, Tracked*, Action, …) → PG → Hasura → apps
SQD/Dune/Helius → svm loaders → collection_event → consumers / canonical map-svm
Kitchen order → worker/patcher → config / ingest path
Operator → promote.sh → gateway env → traffic to green/blue Hasura
```

## Tech stack (as-built)

Envio 3.2.1 · Node ≥22 · pnpm · TypeScript · Effect Schema · Vitest · Hono · pg · Hasura · Caddy · Railway

## Design doctrines (code-backed)

- Config/Kitchen onboarding over per-collection handler explosion (`Tracked*` lanes)
- Insert-if-absent / first-writer-wins on converging SVM lanes (NOTES + tests)
- Truth writes fail-soft for telemetry (README philosophy; verify per-module)
- Heap sizing for 6-chain: `NODE_OPTIONS=--max-old-space-size=12288` (`Dockerfile.belt`)
