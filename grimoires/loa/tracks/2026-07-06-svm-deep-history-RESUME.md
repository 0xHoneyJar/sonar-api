# RESUME — SVM deep-history indexer spike (START HERE, cold-start)

> **Read this first in a new session.** Orients you in <2 min, then points at the ready move.
> **Where we are**: planning DONE; at **spike execution** (simstim Phase 7). NOT at SDD/architect.

## State in one breath

Self-host a full-genesis Solana NFT indexer into the existing `svm.collection_event` (batch lane
of the two-lane lambda). Envio-vs-SQD narrowed to a **data-lake comparison** on 3 axes
(coverage/parity/resource — cost axis dropped, both free-lake cost the same, Boehm §4). Our
§4.5-proven decoder is the **lake-agnostic shared harness**. Default Envio (incumbency) if it
passes; SQD Portal is the **proven floor** in reserve.

## Load order (what to read, in order)

1. `grimoires/boehm/spirals/svm-deep-history.md` — **the execution plan.** The spiral IS the resume
   order: CYCLE 1 → 2 → 3 → 4, biggest-exposure-first. Start at CYCLE 1.
2. `grimoires/loa/sprint.md` — the 6 tasks + acceptance criteria (beads below).
3. `grimoires/loa/sdd.md` — the LakeAdapter seam + decode harness design.
4. `grimoires/loa/context/2026-07-06-gate1-envio-vs-sqd-coverage.md` — GATE-1 status (Envio
   reinstated on evidence; genesis-depth still OPEN — CYCLE 1 closes it).
5. `grimoires/loa/context/2026-07-06-boehm-economics-svm-indexer.md` — why cost is decided.

## The ready move (sole entry point)

**`bd-rdnj` — T1.1 GATE-1 close-out** (the only unblocked bead; everything chains off it):
Envio HyperSync-Solana **genesis-depth probe** + SQD baseline. HyperSync-direct HTTP only — NO RPC
slot-handler, NO metered spend. Does HyperSync-Solana reach the canary mints' mint-era slots
(SMB gen2 ~2021 low slots + pythians ~303M)? **If Envio is shallow → stop, SQD floor.** Cheapest
kill, highest exposure — retire it first.

```bash
cd ~/bonfire/sonar-api
br doctor            # FIX FIRST: clear the orphaned .beads/.write.lock (see gotchas)
br update bd-rdnj --claim --actor <you>
# CYCLE 1: probe HyperSync-Solana via its real client (Node/Rust/Go — NOT blind curl;
#   the client carries the endpoint + query schema). solana.hypersync.xyz responds but
#   the query shape didn't resolve via curl (GATE-1 doc, probe note).
```

## Beads (the spike task graph)

| bead | task | surface | gate |
|---|---|---|---|
| **bd-rdnj** | T1.1 GATE-1 genesis probe | in-session (real client) | GATE-1 |
| bd-mbtb | T1.2 LakeAdapter seam (SqdPortalAdapter + EnvioHyperSyncAdapter) | code (test-first) | — |
| bd-9jdy | T1.3 generalize §4.5 gate → `runParityGate(adapter,fixture)` | code | GATE-2 |
| bd-5sqe | T2.1 resource canary full-sync (pythians + dense smb_gen2) | **NEEDS-A-BOX** | GATE-3 |
| bd-lx00 | T2.2 schema convergence dry-run | needs-a-box | GATE-4 |
| bd-k3se | T2.E2E FR-7 decision record (per-lake matrix → verdict) | synthesis | — |

## Two execution surfaces

- **Executor MCP** (remote sandbox) → coverage/data-lake API probes only.
- **Local box** → the resource/wall-clock/parity spikes (bd-5sqe especially). `decodeSqdBlocks`
  is DO-NOT-CHANGE (it's the §4.5-proven shared harness).

## Wear BOEHM (now installed in-repo)

- `Skill: structuring-a-spiral` — re-rank / update the spiral as evidence lands.
- `Skill: modeling-cost-curves` — finalize FR-5 (self-host param calibration; cost decision is closed).
- `Skill: refusing-cheap` — if anyone argues "just use the cheap API," refuse + demand the curve.
- Agent: `construct-boehm` for a full cost/risk pass.

## Gotchas (don't trip on these)

- **Beads DEGRADED**: orphaned `.beads/.write.lock` (~3 days old, no live process) + missing
  `.beads/.gitignore`. `br doctor` → clear the lock before any `br` writes.
- **Stale `.run/spiral-state.json`**: from the COMPLETED seed-001 spiral (a *different* effort —
  "keep spiraling"). INERT. Do not let run-mode recovery chase it; this cycle is
  `ledger.active_cycle = svm-deep-history-spike`.
- **Spikes need a box**: bd-5sqe/lx00 can't run in a chat session. Hand off with exact commands.
- **No metered spend** without operator approval; both lakes are free (HyperSync-direct / SQD Portal).
  The RPC slot-handler is the metered anti-pattern to avoid.
- **BB gate** on any PR; §4.5 = range-complete decode (NOT ownership completeness — DAS trust root).

## Open framework bugs found this cycle (context, not blockers)

loa#1186 (compose Workflow-tool exec vs proof-of-run gate) · loa#1187 (constructs-install pack-symlink) ·
beads DEGRADED (above). None blocks the spike.
