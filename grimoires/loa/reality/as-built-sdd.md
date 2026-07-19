# As-Built System Design (Ride Snapshot)

> Generated 2026-07-19 by `/ride`. Does **not** replace `grimoires/loa/sdd.md` (active planning).
> Markers: `[GROUNDED]` · `[INFERRED]` · `[ASSUMPTION]`

## Architecture (As-Built)

```
EVM (6 chains) --HyperSync/RPC--> Envio indexer (config.yaml)
                                      |
                                      v
                                 Postgres  --> Hasura --> Caddy gateway --> consumers
                                      ^
SVM: SQD Portal / warehouse / Helius --+   (src/svm/*)
Kitchen (Hono) --> config patch / ingest orders
```

## Tech Stack (Verified)

| Component | Technology | Grounding | Evidence |
|-----------|------------|-----------|----------|
| Runtime | Node ≥22 | [GROUNDED] | `package.json:68-70` |
| Package manager | pnpm 10.11 | [GROUNDED] | `package.json:71` |
| Indexer | Envio HyperIndex 3.2.1 | [GROUNDED] | `package.json:49` |
| Language | TypeScript 5.7 | [GROUNDED] | `package.json:36` |
| Schema/effects | effect 3.10 + @effect/schema 0.75 | [GROUNDED] | `package.json:42-48` |
| HTTP | Hono 4.x | [GROUNDED] | kitchen + `@hono/node-server` |
| DB client | pg | [GROUNDED] | `package.json:54` |
| Tests | Vitest 3.2 | [GROUNDED] | `package.json:37` |
| Events contract | @0xhoneyjar/events (pinned SHA) | [GROUNDED] | `package.json:cluster.eventsPin` |

## Module Structure

- **[GROUNDED]** `src/EventHandlers.ts` — green belt registration hub
- **[GROUNDED]** `src/handlers/*` — per-domain Envio handlers (~26 modules)
- **[GROUNDED]** `src/belts/mibera/` — scoped mibera belt
- **[GROUNDED]** `src/canonical/` — NftActivity normalize + parity
- **[GROUNDED]** `src/svm/` — Solana collection events, SQD, warehouse, Helius
- **[GROUNDED]** `src/kitchen/` — ordering/ingest HTTP
- **[GROUNDED]** `src/self/`, `src/sense/` — operator CLIs
- **[GROUNDED]** `scripts/` — promote, gates, verify, pulse

## Data Model (selected)

| Entity | Lines | Role |
|--------|------:|------|
| Action | schema.graphql:1 | Overlay / activity grammar |
| Token | :350 | Ownership index row |
| TrackedHolder | :291 | Generic ERC-721 holder |
| TrackedTokenBalance | :985 | ERC-20 balances |
| MintActivity / Mibera* | :820+ | Mibera domain |
| chain_metadata | (Envio system) | Sync freshness |

**[GROUNDED]** 95 `type` definitions in `schema.graphql`.

## API / Entry Surface

| Surface | Entry | Grounding |
|---------|-------|-----------|
| Indexer start | `pnpm start` → `envio start` | package.json |
| Codegen | `pnpm codegen` | package.json |
| Kitchen | Dockerfile.kitchen + src/kitchen | files present |
| Promote | scripts/promote.sh | file present |
| Self CLI | `pnpm self*` → src/self/cli | package.json |
| Gate tests | `pnpm test:gate` | package.json |

## Grounding Summary

| Marker | Count | % |
|--------|------:|--:|
| GROUNDED | 18 | 90% |
| INFERRED | 1 | 5% |
| ASSUMPTION | 1 | 5% |
