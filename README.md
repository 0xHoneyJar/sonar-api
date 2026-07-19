# freeside-sonar — THJ Onchain Indexer

> The single source of onchain truth for the THJ / Freeside ecosystem — holdings, transfers, mints, burns, vaults, validator rewards, and marketplace trades across **6 EVM chains + Solana**, served over one GraphQL endpoint.

![Framework](https://img.shields.io/badge/built%20with-Envio%20HyperIndex%20V3-orange)
![Chains](https://img.shields.io/badge/chains-6%20EVM%20%2B%20Solana-blue)
![Runtime](https://img.shields.io/badge/node-22%2B-green)
![Deploy](https://img.shields.io/badge/deploy-self--hosted%20(Railway)-8A2BE2)

Repo `0xHoneyJar/thj-envio` · upstream `moose-code/thj` · config name `thj-indexer` · maintainer **zerker**.

**Try it now** — query live production (no auth for reads):

```bash
curl -s -X POST https://sonar.0xhoneyjar.xyz/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block } }"}'
```

---

## TL;DR

**The problem.** Downstream products (CubQuests, Score API, Set & Forgetti, ApiologyDAO governance, Mibera substrate) each need consistent, cross-chain holder and ownership truth. Querying RPC nodes per-product is slow, inconsistent, and re-derives the same work. Hosted managed indexers cost money *per deployment* and make every contract addition a full reindex.

**The solution.** One **self-hosted** Envio HyperIndex belt indexes all EVM chains into Postgres, plus a Solana (SVM) deep-history lane, and serves reads through Hasura GraphQL behind a rate-limited gateway. Collections are onboarded by config — or on demand via the Kitchen HTTP ordering service — not by writing new handler code.

**Why self-hosted?** (the load-bearing lesson — see [KF-020](grimoires/loa/known-failures.md))

| | Hosted managed (old) | **Self-hosted belt (now)** |
|---|---|---|
| Deep history | metered reads / per-deployment fee | free — sync from genesis off the open data lake |
| Cost driver | $ per deployment, per read | one Railway box + sync time |
| Data source | vendor endpoint | SQD Portal + Envio HyperSync (open) |
| Control | vendor alias swaps | operator-owned alias `sonar.0xhoneyjar.xyz` |

---

## Quick example

```graphql
# 1. Sync freshness — is the belt at chain head?
{ chain_metadata { chain_id latest_processed_block } }

# 2. Holders of a tracked ERC-721 (generic collection lane)
{ TrackedHolder(where: {collectionKey: {_eq: "azuki"}}, limit: 5) {
    address chainId tokenCount } }

# 3. A HoneyJar-family collection's tokens
{ Token(where: {collection: {_eq: "Honeycomb"}}, limit: 5) { id owner } }
```

```bash
# 4. Kitchen: is a collection indexed? then enqueue (set KITCHEN_API_URL to your kitchen host)
curl -s -H "authorization: Bearer $SERVICE_TOKEN" \
  "$KITCHEN_API_URL/v1/collections/1/0xed5af388653567af2f388e6224dc7c4b3241c544/status"
# Batch admit (preferred for multi-collection waves; 1–50 items). Inspect `results[]`
# even on HTTP 202 — mixed create/reject batches may return 207.
curl -s -X POST "$KITCHEN_API_URL/v2/collection-preparations/batch" \
  -H "authorization: Bearer $SERVICE_TOKEN" -H "content-type: application/json" \
  -d '{"schema_version":1,"correlation":{"source":"ops","correlation_id":"w1"},"items":[{"network":{"schema_version":1,"network_namespace":"eip155","network_reference":"1"},"address":"0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d","token_standard":"erc721"}]}'
# After SCALE config apply (external_scale drain), ack jobs so they enter indexing:
curl -s -X POST "$KITCHEN_API_URL/v2/collection-preparations/ack" \
  -H "authorization: Bearer $SERVICE_TOKEN" -H "content-type: application/json" \
  -d '{"schema_version":1,"drain_mode":"external_scale","physical_job_ids":["ingest_…"]}'
```

---

## Design philosophy

1. **Self-host the indexer, don't rent the reads.** The data lakes (SQD Portal from block 0, Envio HyperSync) are open and free. What costs money is *hosting*, not *data*. Deep history = a cheap box + genesis sync time. ([KF-020](grimoires/loa/known-failures.md))
2. **Single source of truth.** Every consumer reads the same belt at the same block height. No per-product RPC re-derivation, no drift.
3. **Onboarding is config, not code.** Adding a collection is a `config.yaml` entry (or a Kitchen order), routed through the generic `TrackedErc721` / SVM `collection-registry` lanes — not a new handler. Read [SCALE.md](SCALE.md) **first**; skipping the source-addition checklist has cost multi-hour reindex windows.
4. **Operator-owned stable alias.** Consumers hit `sonar.0xhoneyjar.xyz`, never a vendor deployment ID. The upstream belt is swapped by `scripts/promote.sh` after a gate PASS — a graceful `caddy reload`, not a hardcoded-URL migration.
5. **Truth writes first, telemetry is best-effort.** Freshness/metering writes (`svm.sync_status`, the events pillar) never take down the pipe that reports them — they fail soft and log.

---

## Architecture

```
        EVM chains                              Solana (SVM)
  ┌───────────────────────┐              ┌──────────────────────┐
  │ Ethereum  Optimism    │              │ SQD Portal (genesis) │
  │ Base  Arbitrum        │              │ Helius (live tail)   │
  │ Zora  Berachain*      │              └──────────┬───────────┘
  └──────────┬────────────┘                         │
             │ Envio HyperSync                       │ svm-backfill-worker
             ▼                                       │ svm-webhook
   ┌──────────────────────┐                          ▼
   │ belt-indexer-selfhost│──────────────►  ┌─────────────────────┐
   │  (Envio HyperIndex)  │     writes      │   Postgres-6J4w     │
   │  src/EventHandlers.ts│════════════════►│  public.* + svm.*   │
   └──────────────────────┘                 └──────────┬──────────┘
   Kitchen order ▲                                     │
   ┌─────────────┴──────┐                              ▼
   │    kitchen-api     │                   ┌─────────────────────┐
   │  /v1/collections/* │                   │ belt-hasura-selfhost│
   │  enqueue → reindex │                   │   (GraphQL engine)  │
   └────────────────────┘                   └──────────┬──────────┘
                                                        ▼
                                     ┌───────────────────────────────┐
                                     │ belt-gateway (Caddy)          │
                                     │ https://sonar.0xhoneyjar.xyz  │
                                     │ 120 req/min/IP · 50KB body cap│
                                     └──────────────┬────────────────┘
                                                    ▼
                              consumers: CubQuests · Score API · Set&Forgetti
                                         ApiologyDAO · Mibera
  * Berachain is the primary chain.
```

**Public surface** (all via `sonar.0xhoneyjar.xyz`):

| Route | Backend | Purpose |
|---|---|---|
| `POST /v1/graphql` | Hasura (`belt-hasura-selfhost`) | Read API over indexed entities (95 GraphQL types) |
| `GET  /v1/collections/:chain_id/:contract/status` | `kitchen-api` | Is this collection indexed? |
| `POST /v1/collections/:chain_id/:contract/ingest` | `kitchen-api` | Enqueue a collection for indexing (Bearer `SERVICE_TOKEN`) |

Ingestion side: ~26 handler modules all route through `src/EventHandlers.ts` (map: `grimoires/loa/HANDLER_REGISTRY.md`). The SVM lane lives in `src/svm/`.

---

## Local development

### Prerequisites

- [Node.js v22+](https://nodejs.org/en/download/current) — HyperIndex V3 requirement
- [pnpm v8+](https://pnpm.io/installation)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — Envio runs Postgres + Hasura locally
- `ENVIO_API_TOKEN` env var — required by V3 HyperSync

### Run

```bash
pnpm install
pnpm codegen              # generate types from config.yaml + schema.graphql
TUI_OFF=true pnpm dev     # start indexer + local Postgres/Hasura
```

Visit **http://localhost:8080** for the GraphQL Playground (local dev password: `testing` — local only; production reads are open, mutations are gated).

---

## Command reference

| Command | Purpose |
|---|---|
| `pnpm codegen` | Generate code from `config.yaml` / `schema.graphql` |
| `pnpm dev` / `pnpm start` | Run the indexer (dev = with TUI; `TUI_OFF=true` to disable) |
| `pnpm test` | Run the vitest suite |
| `pnpm test:hasura` | Hasura GraphQL contract tests |
| `pnpm self` / `self:check` / `self:write` | Emit / verify / write the `beacon.yaml` territory manifest |
| `pnpm verify:belt-config` | Validate `config.yaml` before a source addition |
| `pnpm verify:belt-contract` / `verify:svm-contract` | Verify the served GraphQL contract (EVM / SVM) |
| `pnpm verify:truth-promotion` | Verify the detached Sonar→Score planning promotion receipt (never grants production authority) |
| `pnpm verify:truth-contract` | Type-check and test the signed truth-contract kernel and FR traceability |
| `pnpm validate:evm-canonical` / `validate:svm-canonical` / `validate:evm-sales` | Live canonical-parity validators |
| `pnpm cost` | Railway cost model |
| `pnpm pulse` | Sync-health pulse (`scripts/sonar-pulse.sh`) |

A local read-only sync dashboard is available: `node scripts/sync-dashboard.cjs` → http://localhost:8787.

---

## Configuration

The indexer is defined by two files:

- **`config.yaml`** — every contract source: `name`, `handler`, watched `events`, `address`(es), `start_block`, per-chain networks. Community ERC-721 collections use the generic `TrackedErc721` lane (keyed by `collectionKey`); SVM collections are registered in `src/svm/collection-registry.ts`.
- **`schema.graphql`** — the 95 entity types the handlers write and Hasura serves.

> ⚠️ **Adding a source forces a reindex.** A single deployment indexes all 6 chains, so *any* contract addition reindexes *all* chains. Read [SCALE.md](SCALE.md) and run `pnpm verify:belt-config` before opening the PR. The structural fix (per-chain split) is tracked as Decision Log D4.

Key env vars: `ENVIO_API_TOKEN` (HyperSync), `SERVICE_TOKEN` (Kitchen auth), `SVM_HASURA_ENDPOINT` + `HASURA_GRAPHQL_ADMIN_SECRET` (SVM freshness writes), `HELIUS_API_KEY` / `HELIUS_WEBHOOK_SECRET` (SVM live tail), `NATS_URL` + `SONAR_SIGNING_SEED_HEX` (optional events pillar — absent → publish disabled, indexer unaffected).

---

## Production deployment

Self-hosted on Railway (project `sonar-api`). Authoritative endpoint: **`https://sonar.0xhoneyjar.xyz/v1/graphql`**.

| Service | Role |
|---|---|
| `belt-indexer-selfhost` | Envio HyperIndex — the EVM belt |
| `belt-hasura-selfhost` | Hasura GraphQL engine |
| `belt-gateway` | Caddy — TLS, rate-limit, upstream swap (`sonar.0xhoneyjar.xyz`) |
| `kitchen-api` | Collection ordering service (`/v1/collections/*`) |
| `svm-backfill-worker` | Solana genesis backfill (SQD Portal) |
| `svm-webhook` | Solana realtime tail (Helius) |
| `Postgres-6J4w` | Shared datastore (`public.*` EVM entities + `svm.*`) |

> **Historical note:** the old hosted Envio managed deployments (`indexer.hyperindex.xyz/b5da47c` and `/914708e`) referenced throughout [SCALE.md](SCALE.md) are **superseded** by the self-hosted belt above. SCALE.md's Decision Log predates the cutover and is pending reconciliation — treat `sonar.0xhoneyjar.xyz` as authoritative.

Deploys: `DEPLOYMENT_GUIDE.md`. Upstream swaps go through `scripts/promote.sh` after a non-skippable gate PASS — never a bare env edit.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm dev` errors on HyperSync | `ENVIO_API_TOKEN` unset | Export the token (V3 requirement) |
| Adding a contract triggers a long reindex | Single 6-chain deployment | Expected — see [SCALE.md](SCALE.md); tighten `start_block`, plan the window |
| Kitchen `ingest` returns 401 | Missing/wrong Bearer | Set `SERVICE_TOKEN`; reads need no auth, ingest does |
| A collection reads empty | Not onboarded, or SVM backfill pending | Check `/v1/collections/.../status`; SVM: query `svm.sync_status` |
| GraphQL 429 | Gateway rate limit (120 req/min/IP) | Back off or batch queries |
| `chain_metadata` block behind head | Normal live-tip lag (≤ a few blocks) | Only a concern if `timestamp_caught_up_to_head_or_endblock` is null |

---

## Limitations (honest)

- **Reindex-all coupling.** One deployment indexes all 6 chains; every source addition reindexes everything. Per-chain split is designed (D4), not yet shipped.
- **SVM deep-history is mid-backfill.** The realtime lane works (Pythenians is live-fresh); the genesis backfill for the Solana Batch-1 collections (Claynosaurz, DeGods, y00ts, …) is running its first production pass — several read empty until it completes.
- **Cutover is operator-coordinated.** No automatic blue-green; upstream swaps follow the ordered sequence in SCALE.md Guardrail 1 (split-brain risk window during manual cutover).
- **GraphQL depth/cost capping is coarse.** The gateway caps body size + rate; precise query-cost limiting (graphql-armor / Hasura allowlist) is a documented fast-follow.

---

## FAQ

**Is this a fork of Envio?** No — it's a HyperIndex *project* (indexer definition + handlers) built on the Envio framework, forked from `moose-code/thj`.

**Which chains?** Ethereum (1), Optimism (10), Base (8453), Arbitrum (42161), Zora (7777777), Berachain (80094, primary) + Solana.

**Can I query production directly?** Yes — reads at `sonar.0xhoneyjar.xyz/v1/graphql` are open. Please respect the 120 req/min/IP limit.

**How do I add a collection?** For standard ERC-721s, a Kitchen `ingest` order or a `config.yaml` entry under the `TrackedErc721` lane. Always read [SCALE.md](SCALE.md) first.

**Where's the handler for contract X?** `grimoires/loa/HANDLER_REGISTRY.md` maps every contract to its handler.

**Why is `chain_metadata` a block behind?** Live-tip lag. The belt tracks head; a few blocks of lag is normal. Convergence is signalled by `timestamp_caught_up_to_head_or_endblock`.

---

## Documentation

| Document | Purpose |
|---|---|
| [SCALE.md](SCALE.md) | **Operator playbook** — source-addition guardrails + Decision Log. Read before any `config.yaml` change. |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Deployment commands, reset semantics, verification queries |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture |
| [FAST_TESTING_GUIDE.md](FAST_TESTING_GUIDE.md) | Quick testing with block ranges |
| [BUTTERFREEZONE.md](BUTTERFREEZONE.md) | Agent-grounded, provenance-tagged project context |
| `grimoires/loa/HANDLER_REGISTRY.md` | Contract → handler mapping |
| `grimoires/loa/ENTITY_REFERENCE.md` | GraphQL entity reference |
| `grimoires/loa/known-failures.md` | Operational degradation log (read before triaging) |
| `grimoires/loa/reality/` | Token-optimized codebase interface (`/reality`) |

---

## Contributions & ownership

This is an **internal THJ / Freeside production indexer**, maintained by **zerker**, forked from the upstream `moose-code/thj`. It is not a general-purpose OSS tool seeking community contributions.

Issues and bug reports (especially data-inconsistency reports with a reproducing GraphQL query) are welcome. PRs are accepted as *illustrations* of a proposed fix, but are not merged directly — submissions are reviewed via `gh` (often with Claude/Codex assistance) and independently re-implemented if adopted, because this belt is the source of truth for several downstream products and the risk-reward on unvetted changes is asymmetric.

---

## License

See [LICENSE.md](LICENSE.md).
