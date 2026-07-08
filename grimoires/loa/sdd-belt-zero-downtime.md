---
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api — EVM belt-indexer zero-downtime re-platform"
  workstream: delivery
  priority: high
  learning_status: directionally-correct
  source: team-internal
---

# SDD — EVM Belt-Indexer Zero-Downtime Re-Platform

> **Software Design Document** · **Status**: draft · **Date**: 2026-07-06 · **Repo**: 0xHoneyJar/sonar-api
> **Phase**: /architect output → feeds /sprint-plan. **Traces**: `grimoires/loa/prd.md` (belt PRD, FR-B*/FR-A*).
> **Prior art**: `grimoires/loa/context/2026-07-06-indexer-zero-downtime-architecture.md` (seam models),
> `SCALE.md` (D2/D4, SKP-001/003), `belt-reinit.md` (KF-013, D6), `known-failures.md` (KF-015/016/020).
> **This SDD retires the dangling `SDD §7.4`** cited by `scripts/promote.sh:35` and `Caddyfile:5` —
> §7.4 below is the authoritative, versioned zero-downtime cutover procedure (PRD FR-B5c).

---

## 1. Overview & Architecture

Two design tracks (per PRD): **Track B** makes the *existing* Envio belt's cutover proven & consistent
(D4 per-chain split + hardened Caddy/promote.sh alias); **Track A** ports the proven SVM
lake+decode pattern (`src/svm/`) to EVM so an add is a re-decode, not a re-fetch. The stable Caddy
alias is the seam both tracks share — it is how live traffic is *never* pointed at the surface being
rebuilt.

### 1.1 Current topology (grounded)

```
Kitchen HTTP ─/v1/collections/*─┐
                                ▼
consumers ─► belt-gateway (Caddy L5, STABLE URL) ─$BELT_UPSTREAM─► belt-hasura (L4) ─► belt Postgres ◄─ Envio HyperIndex
             sonar.0xhoneyjar.xyz/v1/graphql        (promote.sh                                          (config.yaml = 6-chain GREEN;
             rate-limit + 50KB body cap              sole writer)                                         config.mibera.yaml = 4-chain BLUE)
                                                                                                          eRPC proxy/cache in front of RPC
```
> Grounded: `Caddyfile:1-2,39-51`, `ARCHITECTURE.md:5-11`, `promote.sh:46-60`, `config.yaml`,
> `config.mibera.yaml`, `erpc.yaml`.

### 1.2 Target topology

```
                         ┌── belt-eth   (Envio or lake-served) ─► pg-eth   ─► hasura-eth   ┐
consumers ─► gateway ────┤   belt-op ...                                                   ├─ remote-schema stitch ─► one GraphQL
  (STABLE alias) │        └── belt-base / belt-arb / belt-bera / belt-zora ────────────────┘
                │                         ▲ per-chain: add a contract re-scans ONE chain (D4)
                │
                └── Track A per chain: SQD Portal EVM lake ─► OUR raw store ─► decodeEvmLogs (re-runnable) ─► pg ─► hasura
                                        (fetch ONCE)          (own + query)    (add a collection = re-decode a range, NO re-fetch)
```

---

## 2. Component Design

### 2.1 Per-chain belt split (D4) — PRD FR-B1

- **Design**: replace the single 6-chain `config.yaml` belt with **six single-chain belt services**
  (`belt-{eth,op,base,arb,bera,zora}`), each its own Envio deployment + Postgres, fronted by a
  Hasura per chain, stitched into one GraphQL endpoint via **Hasura remote schemas** (chain-scoped
  namespaces) behind the gateway.
- **Add-path**: the Kitchen worker (`src/kitchen/ingest-worker.ts`) targets the belt for the
  contract's chain only → an add re-scans **1 chain**, not 6 (retires the blast-radius growth).
- **Memory** (KF-015): each single-chain belt fits the default Node heap or a small `NODE_OPTIONS`;
  `Dockerfile.belt` bakes `NODE_OPTIONS=--max-old-space-size` scaled to chain density (FR-B5a).
- **Migration**: stand each chain's belt up from the existing consolidated data by table-filtered
  restore (no cold re-sync where avoidable); cut over per chain behind the alias (§7.4).
> Traces FR-B1; grounds `SCALE.md` D4, KF-015.

### 2.2 Gateway + stable consumer alias — PRD FR-B2

- **Design**: `belt-gateway` (Caddy) exposes the immutable public URL; upstream is `$BELT_UPSTREAM`,
  mutated **only** by `scripts/promote.sh` (sole writer, R-D). Consumers (score-api #121/#163, Kitchen)
  never learn a per-belt URL. Federation-ready: an added chain belt is an additive route; the public
  URL is unchanged (`Caddyfile:50-51`).
- **Consistency debt retired** (FR-B2): ratify that the Caddy `BELT_UPSTREAM` alias **is** SCALE.md
  Guardrail 5 (SCALE.md D2 currently calls it "TODO" — that line is superseded by this SDD).
> Traces FR-B2; grounds `Caddyfile:47-51`, `promote.sh:8-11`, `SCALE.md:76,127`.

### 2.3 Cutover harness — PRD FR-B2/B3/B4/B5

- **`promote.sh`** (sole writer): runs `promotion-gate.js` as a non-skippable, fail-closed gate
  (`promote.sh:96`), then flips `BELT_UPSTREAM` + the Score raw-PG `DATABASE_URL` signal atomically.
  Gate **requires both belts live + distinct** (`promotion-gate.js:530-542`) → anti-SKP-001.
- **`promotion-gate.js`**: parity/health/expected-chains/golden-samples checks between blue & green.
- **Apply mechanism** (FR-B3): see §7.4 (Option B graceful `caddy reload` default; Option C replicas).
- **Ops hygiene** (FR-B5): (a) bake `NODE_OPTIONS` into `Dockerfile.belt`; (b) add
  `scripts/rollback-belt.sh` OR repoint `snapshot-pre-cutover.sh` to `promote.sh --rollback`
  (missing-script debt, Explore map §5); (c) §7.4 below (versioned cutover).
> Traces FR-B2/B3/B4/B5; grounds `promote.sh:35-38,79-99,113-121`, `promotion-gate.js:530-542`.

### 2.4 Seam-A lake + decode (ported from SVM) — PRD FR-A1..A5

- **Reference implementation**: `src/svm/` — `sqd-loader.ts` / `sqd-parallel-loader.ts` (raw fetch
  from SQD Portal), `decodeSqdBlocks` (re-runnable decode), `warehouse-loader.ts` (land rows). GO-proven
  (1767/1767 parity, RAM 153 MB) per `2026-07-06-lake-decision-record.md`.
- **EVM port**:
  - **FR-A1 raw ingest**: `src/evm/sqd-evm-loader.ts` (new) fetches raw EVM logs/tx from **SQD Portal
    EVM** once into **our own raw store** (`raw.evm_log` / `raw.evm_tx`, per chain). Operator intent:
    own + query our data (not decode-on-read). Reuse the range-partitioned parallel loader shape.
  - **FR-A2 decode**: `src/evm/decodeEvmLogs.ts` (new, analog of `decodeSqdBlocks`) decodes raw →
    typed entity rows (the same entities Hasura serves today: `TrackedErc721`, `Token`, `TrackedHolder`).
    **Adding a collection = re-decode / range-backfill that collection over rows already held** — no
    re-fetch, no `--restart`.
  - **FR-A3 serve unchanged**: Hasura tracks the decoded tables; the gateway alias cuts a chain from
    Envio-served → lake-served with **no consumer change** (§2.2). Track-B cutover harness (§2.3, §7.4)
    is the migration mechanism.
  - **FR-A4 memory-light**: range-partitioned loader (SVM precedent 153 MB) → retires KF-015.
  - **FR-A5 parity gate**: `scripts/parity-check.sh` proves decoded EVM rows == current Envio belt
    output per chain **before** the alias flip (GATE-2-style; analog of SVM 1767/1767).
> Traces FR-A1..A5; grounds `src/svm/*`, `2026-07-06-lake-decision-record.md`, `parity-check.sh`.

---

## 3. Data Flow

1. **Steady state**: RPC → eRPC (cache/failover) → Envio HyperSync → per-chain belt Postgres → Hasura
   → gateway alias → consumers.
2. **Add a collection (Track B, interim)**: Kitchen patches that chain's belt config → green rebuild
   of *that chain* beside live blue → `promote.sh` gate → alias flip (0 downtime).
3. **Add a collection (Track A, target)**: `decodeEvmLogs` re-runs over the raw store for the new
   contract's range → decoded rows land → parity gate → alias flip. Raw never re-fetched.

---

## 4. Data Models & Schema

- **Raw layer (new, Track A)**: `raw.evm_log(chain_id, block_number, tx_hash, log_index, address,
  topics[], data, block_time)` PK `(chain_id, block_number, log_index)`; `raw.evm_tx` analog. Append-
  only, write-once. Partitioned by `chain_id` (+ block-range) for range re-decode.
- **Decoded layer (existing entities, unchanged contract)**: `TrackedErc721`, `Token`, `TrackedHolder`
  (belt Hasura today). Track A writes these from `decodeEvmLogs`; Track B writes them from Envio.
  Insert-if-absent idempotent; `source` column distinguishes `envio` vs `evm-decode` (mirrors SVM
  `source=sqd-stream`).
- **No consumer-visible schema change** → NFR-1 (Hasura keeps serving). If a decoded-schema change is
  ever needed, use **pgroll** expand/contract (multi-version views, no lock) — `2026-07-06-...architecture.md:§3D`.

---

## 5. Technology Stack (with justification)

| Concern | Choice | Justification |
|---|---|---|
| Raw EVM lake source | **SQD Portal EVM** (free) | genesis coverage, self-host doctrine (KF-020); operator confirmed own-the-lake |
| Raw loader | range-partitioned parallel (port `src/svm/sqd-parallel-loader.ts`) | proven memory-light (153 MB), retires KF-015 |
| Decode | `decodeEvmLogs` standalone step | separates fetch/interpret → re-decode ≠ re-fetch (the core win) |
| Interim indexer | Envio HyperIndex (existing) | keeps serving during the Track-A build; per-chain after D4 |
| Serve | Hasura + remote-schema stitch | no consumer change; per-chain federation |
| Alias/cutover | Caddy `BELT_UPSTREAM` + `promote.sh` | already built; O(1) flip; sole-writer gate |
| RPC | eRPC proxy/cache (`erpc.yaml`) | 429/SKP-003 mitigation, reusable for both tracks |
| Zero-downtime schema (if needed) | pgroll | expand/contract, no lock |

---

## 6. API Contracts

- **Public GraphQL** (`/v1/graphql`): unchanged surface; per-chain remote schemas stitched. Consumers
  query the same entities. Contract invariant: entity shapes stable across Envio-served ↔ lake-served.
- **Kitchen HTTP** (`/v1/collections/{chain_id}/{contract}/*`): unchanged; routes to the per-chain belt
  (`Caddyfile:39-45`). Add-path returns "indexing"/"ready" status from that chain's belt only.

---

## 7. Deployment Architecture

Railway services: `belt-gateway` (Caddy), per-chain `belt-{chain}` (Envio) + `belt-hasura-{chain}` +
`Postgres-{chain}`, `kitchen-api`, `erpc`, plus Track-A `evm-lake-loader` (batch/worker). Blue/green
is per-chain (separate services + Postgres → memory does not stack, KF-015 confirmed satisfiable).

### 7.4 Zero-Downtime Cutover Procedure (authoritative — retires the dangling ref)

**Invariant**: live traffic (the gateway alias) is NEVER pointed at the surface being rebuilt.

1. **Build green beside blue**: deploy the target belt (new contract / per-chain / lake-served) into a
   distinct service + Postgres. Blue keeps serving throughout.
2. **Catch green to head** (Track B) OR **decode + parity** (Track A / FR-A5): `parity-check.sh` must
   pass (chains, golden samples, row parity) before proceeding.
3. **Gate**: `promote.sh` runs `promotion-gate.js` (non-skippable, fail-closed; requires blue≠green,
   both live). Abort on any non-zero → anti-SKP-001 split-brain.
4. **Apply — Option B (default)**: graceful `caddy reload` via loopback-only admin (`Caddyfile:5`,
   `admin localhost:2019`) → **0 dropped requests**. `promote.sh` flips `BELT_UPSTREAM`
   (`belt-hasura` → `belt-hasura-green`) + the Score raw-PG `DATABASE_URL` signal atomically.
   - **Apply — Option C (contingency)**: if loopback reload is infeasible on Railway, run ≥2 gateway
     replicas → rolling redeploy. No re-decision needed; select per measured 0-drop behavior (FR-B3).
5. **Verify (first hour)**: watch for §8 rollback triggers.
6. **Rollback** (`promote.sh --rollback`, un-gated safety exit): revert `BELT_UPSTREAM` to blue, verify
   consumers, **keep the broken green for postmortem** (no fix-in-place). Provide `scripts/rollback-belt.sh`
   or repoint `snapshot-pre-cutover.sh` here (FR-B5b).

**§8 Rollback triggers** (any, first hour): 5xx spike on the alias post-swap; consumer reports a
missing entity/field; post-swap reconciliation shows green diverged; operator-detected inconsistency.

> Grounds `promote.sh:22-27,35-38,46-60,113-121`, `Caddyfile:4-10`, `promotion-gate.js:530-542`.

---

## 8. Security

- Secrets: Railway token read from a 0600 file, never echoed; DB-URLs written as Railway *references*
  (`${{Service.DATABASE_URL}}`), not resolved creds (`promote.sh` header). Gateway: 50KB body cap +
  120 req/min/IP rate-limit (`Caddyfile:29-37`); Caddy admin loopback-only (off-host curl to :2019
  MUST fail — bd-c09.2). No new external trust boundary: SQD Portal is a read-only free lake; the
  decode step is pure over our own raw store.

## 9. Scalability & Performance

- **Add cost** flattens to a per-chain re-decode (Track A) / per-chain rebuild (Track B) — bounded, not
  6×-growing (PRD G-2/G-3, BOEHM self-host curve).
- **RPC/429** (SKP-003): eRPC cache + range-partition + stagger; prefer SQD-lake/HyperSync reads over
  raw RPC; never fire a simultaneous multi-chain cold sync.
- **Memory** (KF-015): single-chain belts + memory-light lake loader; `NODE_OPTIONS` baked per density.

## 10. Risk → Design Mitigation (traces PRD §7)

| PRD risk | SDD mitigation |
|---|---|
| R-1 SKP-001 split-brain | §2.3 sole-writer + fail-closed gate; §7.4 step 3 |
| R-2 two-belts-live unproven | §7 separate services; §7.4 GATE-A proof (FR-B4) |
| R-3 SKP-003 429-storm | §2.1 per-chain; §9 eRPC + stagger |
| R-4 KF-015 OOM | §2.1 NODE_OPTIONS bake; §2.4 memory-light loader |
| R-5 doc debt (§7.4/rollback/alias) | §7.4 versioned; §2.3 rollback script; §2.2 alias ratified |
| R-6 Option B infeasible | §7.4 step 4 Option C fallback |
| R-7 decode parity drift | §2.4 FR-A5 parity gate before flip |
| R-8 SQD EVM coverage gap | per-chain GATE-1 coverage probe (as SVM did); else characterized fallback (Goldsky/Covalent) |

## 11. Traceability

FR-B1→§2.1 · FR-B2→§2.2/§2.3 · FR-B3→§7.4 · FR-B4→§7.4 · FR-B5→§2.3/§7.4 · FR-A1→§2.4 · FR-A2→§2.4 ·
FR-A3→§2.4/§2.2 · FR-A4→§2.4/§9 · FR-A5→§2.4/§7.4 · NFR-1..5→§4/§8/§9. Every §-claim cites a repo
`file:line`, the belt PRD, or a decision record.
