# Domain Terminology

> Extracted from source + schema. Cap ~40 terms. Generated: 2026-07-19

## Indexer / belt

| Term | Source | Context |
|------|--------|---------|
| HyperIndex / Envio | `package.json:49` | EVM indexing framework |
| Green belt | `src/EventHandlers.ts` | Full `config.yaml` multi-chain indexer |
| Blue / mibera belt | `src/belts/mibera/` | Scoped `config.mibera.yaml` |
| promote | `scripts/promote.sh` | Swap consumer upstream after gate |
| BELT_UPSTREAM | promote / NOTES | Gateway env pointing at Hasura |
| Kitchen | `src/kitchen/` | HTTP collection ordering/ingest |
| chain_metadata | README GraphQL | Sync freshness per chain |

## Ownership / activity

| Term | Source | Context |
|------|--------|---------|
| TrackedHolder | `schema.graphql:291` | Generic ERC-721 holder ledger |
| TrackedTokenBalance | `schema.graphql:985` | Tracked ERC-20 balances |
| Token | `schema.graphql:350` | Per-token ownership index |
| Action | `schema.graphql:1` | Overlay activity grammar |
| collectionKey | tracked handlers | Generic lane collection id |
| collection | HoneyJar Token rows | Family-specific collection name |
| NftActivity | `src/canonical/parity.ts:34` | Canonical cross-chain activity DTO |
| S5 / parity | `src/canonical/parity.ts` | Go-live presence gate vs legacy |

## SVM

| Term | Source | Context |
|------|--------|---------|
| SQD Portal | `src/svm/sqd-client.ts` | Solana block stream lake |
| warehouse lane | `src/svm/warehouse-loader.ts` | Dune history supply |
| Helius | `src/svm/helius-meter.ts` | Live tail / metered enrichment |
| collection_event | SVM SQL / loaders | Content-addressed SVM event row |
| §4.5 gate | `scripts/run-sqd-45-gate.ts` | Reconcile-by-recompute trust root |
| insert-if-absent | NOTES / tests | First-writer-wins upsert policy |

## Ops / failure lore

| Term | Source | Context |
|------|--------|---------|
| KF-015 | NOTES / Dockerfile.belt | Node heap OOM on 6-chain |
| KF-018 | warehouse ADR | Helius quota / silent loss |
| KF-020 | README | Self-host lakes; hosting is cost |
| HyperSync | ops | EVM sync accelerator token |
| Hasura | cutover scripts | GraphQL engine over PG |
