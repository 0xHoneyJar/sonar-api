---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — EVM belt-indexer zero-downtime re-platform"
  workstream: delivery
  priority: high
  learning_status: directionally-correct
  source: team-internal
---

# Sprint Plan — EVM Belt-Indexer Zero-Downtime Re-Platform

> **Status**: draft · **Date**: 2026-07-06 · **Traces**: `grimoires/loa/prd.md` (FR-B*/FR-A*),
> `grimoires/loa/sdd.md` (§2–§9). **Phase**: /sprint-plan → feeds /run sprint-plan.
> **Sequencing** (BOEHM, retire-largest-risk-first): **Sprint 1 = Track B hardening** (the
> near-term downtime kill — self-contained, low blast radius, autonomously implementable). Sprints
> 2–4 = D4 split + Track A lake/decode (larger infra; planned here, built in later cycles behind
> their own go/no-go gates). **This run implements Sprint 1.**

---

## Sprint 1 — Track B hardening: prove & durablize the cutover (near-term downtime kill)

**Goal**: make the existing Caddy/`promote.sh` blue/green cutover *consistent and durable*, so an add
never takes the belt dark. Retires R-1 (split-brain), R-4 (KF-015 OOM), R-5 (doc/script debt), R-6
(Option B unproven). No re-platform; touches infra config, scripts, and a staging-proof harness.

| Task | Description | Acceptance criteria | Verification |
|------|-------------|---------------------|--------------|
| **S1-T1** | Bake `NODE_OPTIONS=--max-old-space-size` into `Dockerfile.belt` (KF-015 durable fix; currently a green-only Railway service var) | `Dockerfile.belt` sets `ENV NODE_OPTIONS` scaled to chain density; comment cites KF-015; blue (4-chain) unaffected | `grep NODE_OPTIONS Dockerfile.belt`; build succeeds; a 6-chain belt boots without heap-OOM crash-loop (KF-015 signature absent from logs) |
| **S1-T2** | Provide `scripts/rollback-belt.sh` (the dangling dep of `snapshot-pre-cutover.sh:8`) OR repoint that caller to `promote.sh --rollback` | Referenced script exists and reverts `BELT_UPSTREAM` to blue + verifies consumers, keeping green for postmortem (no fix-in-place); OR the caller is repointed with a comment | `test -x scripts/rollback-belt.sh` OR grep shows repoint; `bash -n` clean; `--dry-run` reverts alias without writes |
| **S1-T3** | Reconcile the alias "built vs TODO" contradiction: update `SCALE.md` D2/Guardrail-5 to ratify the Caddy `BELT_UPSTREAM` + `promote.sh` sole-writer path as the landed stable alias (points at SDD §2.2/§7.4) | `SCALE.md` no longer says the alias is "TODO"; links SDD §7.4 as the authoritative cutover; no code change | `grep -n "Guardrail 5" SCALE.md` reflects landed state; SDD §7.4 referenced |
| **S1-T4** | GATE-A staging-proof harness: a script that adds one contract to a green belt, catches to head, runs `promotion-gate.js`, flips the alias, and asserts **0 dropped queries** + no split-brain | `scripts/gate-a-proof.sh` (new) runs the full sequence against a staging pair and exits non-zero on any drop/split-brain; emits a JSON proof record | dry-run prints the plan; against staging, `consumer-reconnect-drill.sh` shows 0 dropped queries across the flip; gate PASS logged |
| **S1-T5** | Confirm Option B (loopback `caddy reload`) achieves 0-drop on Railway; if not, document Option C (≥2 gateway replicas) selection (FR-B3/SDD §7.4 step 4) | A measured note in the S1 runbook records which apply-mode is used and the drop count; loopback admin remains off-host-unreachable (bd-c09.2) | off-container curl to `:2019` fails; reload drop-count measured and recorded |

**Sprint 1 Definition of Done**: an add to the belt is demonstrably 0-downtime on a staging pair
(GATE-A PASS), the KF-015 heap fix is durable in the image, rollback is a real script, and the docs
no longer contradict the built alias.

---

## Sprint 2 — D4 per-chain belt split (blast-radius bound) — *planned, not this run*

Split the 6-chain `config.yaml` belt into six single-chain belts + per-chain Hasura, stitched via
remote schemas behind the gateway (SDD §2.1). AC: adding a Base contract re-scans **Base only**;
stitched GraphQL serves all 6 chains unchanged. Go/no-go **GATE-B**. Depends on Sprint 1.

## Sprint 3 — Track A raw ingest (own-the-lake) — *planned, not this run*

`src/evm/sqd-evm-loader.ts`: range-partitioned parallel fetch of raw EVM logs/tx from SQD Portal EVM
into `raw.evm_log`/`raw.evm_tx` (SDD §2.4/§4), porting `src/svm/sqd-parallel-loader.ts`. AC: raw rows
land per chain, memory-light (~SVM 153 MB precedent), per-chain **GATE-1** coverage probe (genesis
reachable) before commit. Depends on Sprint 2.

## Sprint 4 — Track A decode + parity + cutover — *planned, not this run*

`src/evm/decodeEvmLogs.ts` (analog of `decodeSqdBlocks`) → decoded entity rows; `parity-check.sh`
proves decoded == Envio per chain (**GATE-2**, FR-A5); cut each chain lake-served behind the alias
(SDD §7.4), lowest-volume first. AC: adding a collection = a re-decode over held rows (0 re-fetch, no
`--restart`); parity PASS before each flip. Depends on Sprint 3.

---

## Dependencies & Risks

- Sprint 1 is self-contained (no dependency on 2–4); safe to implement + run-bridge now.
- Beads currently DEGRADED — track Sprint-1 tasks here; create `br` tasks if beads recovers.
- Carry-over hygiene: keep commits scoped to belt files; do NOT sweep the pre-existing uncommitted
  SVM changes (`src/svm/sqd-client.ts`, `ledger.json`) into the belt PR.
- Full risk register: SDD §10 (R-1..R-8) with per-risk mitigations.
