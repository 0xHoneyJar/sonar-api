# As-Built Product Requirements (Ride Snapshot)

> **Source of Truth Notice** — Generated from code analysis on 2026-07-19 by `/ride`.
> This does **not** replace `grimoires/loa/prd.md` (active planning: EVM Collection Onboarding Contract v1).
> Markers: `[GROUNDED]` · `[INFERRED]` · `[ASSUMPTION]`

## Document Metadata

| Field | Value |
|-------|-------|
| Generated | 2026-07-19 |
| Source | Code reality extraction |
| Drift Score | 72/100 |
| Active planning PRD | `grimoires/loa/prd.md` (preserved) |

## User / Consumer Types

### Consumer: GraphQL readers (apps)

- **[GROUNDED]** Public GraphQL surface documented at `sonar.0xhoneyjar.xyz/v1/graphql` (`README.md`)
- **[GROUNDED]** Entities include holders, tokens, actions, vaults, marketplace trades (`schema.graphql` 95 types)

### Operator: Belt / promote

- **[GROUNDED]** Promotion via `scripts/promote.sh`
- **[GROUNDED]** Multi-service Docker: belt, gateway, kitchen, erpc, svm-webhook

### Operator: Kitchen ordering

- **[GROUNDED]** Kitchen HTTP modules under `src/kitchen/` + `Dockerfile.kitchen`
- **[INFERRED]** On-demand collection ingest path described in README curl examples

## Features (Code-Verified)

### F1 — Multi-chain EVM HyperIndex belt

- **[GROUNDED]** Envio `3.2.1` (`package.json:49`)
- **[GROUNDED]** Chains 1, 10, 8453, 42161, 7777777, 80094 (`config.yaml` network ids)
- **[GROUNDED]** Green entry `src/EventHandlers.ts` side-effect imports handlers

### F2 — Generic collection tracking

- **[GROUNDED]** `TrackedHolder`, `TrackedHolder1155`, `TrackedTokenBalance`, `Token` in schema
- **[GROUNDED]** Handlers `src/handlers/tracked-erc721.ts`, `tracked-erc20.ts`

### F3 — Canonical NftActivity contract layer

- **[GROUNDED]** `src/canonical/{map-evm,map-svm,emit,parity}.ts` using `@0xhoneyjar/events`
- **[GROUNDED]** Parity gate semantics documented in `parity.ts` header

### F4 — SVM deep history + live tail

- **[GROUNDED]** SQD client/loader/liveness under `src/svm/sqd-*.ts`
- **[GROUNDED]** Warehouse loader + Helius meter modules present
- **[GROUNDED]** `src/svm/sqd-parallel-loader.ts` present (restored from `9c33df84`; 13/13 tests)

### F5 — Zero-downtime promote / gateway

- **[GROUNDED]** `Dockerfile.gateway`, `scripts/promote.sh`, `Dockerfile.belt` with `NODE_OPTIONS` heap default

## Grounding Summary

| Marker | Count | % |
|--------|------:|--:|
| GROUNDED | 15 | 88% |
| INFERRED | 2 | 12% |
| ASSUMPTION | 0 | 0% |
