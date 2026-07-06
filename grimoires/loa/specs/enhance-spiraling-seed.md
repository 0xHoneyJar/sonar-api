---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api svm event supply — spiral autonomous lane"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "launch the repo's first designed-seed /spiraling run so the SQD live-tail lands without hand-driving every cycle"}
  learning_status: directionally-correct
  source: team-internal
---

# Session N+1 — Launch Spiral 001 from the Designed Seed

> The spiral's first cycle no longer cold-starts: the genome is written.

## Context

`/spiraling` (v1.1.0, production) runs SEED → SIMSTIM → HARVEST → EVALUATE per cycle.
Cycle 1 of any spiral is normally a cold start — `spiral-orchestrator.sh:644` logs
"no relevant visions found, cold-starting" because the vision registry has nothing
relevant yet. This kickoff closed that gap by **designing the seed**: a hand-crafted
genome at `grimoires/loa/specs/spiral-seed-001-sqd-live-tail.md` carrying the task,
the verified prior-output corpus, the named consumer, hard constraints, and stopping
conditions.

**Load-bearing mechanical fact**: `spiral-harness.sh:284` ingests only the FIRST
4096 BYTES of `--seed-context` (`head -c 4096`). The seed file is 2.5KB — everything
in it lands in the harness. If you edit it, re-check `wc -c` stays ≤ 4096.

Payload selection (grounded in /leverage + /recall, 2026-07-05): SQD live-tail won
over (a) belt blue-green P0 beads (infra-mutating, operator hands-on — 🔥 on the
leverage board, do not collide) and (b) loa-finn `bd-uzap` (lev 61 but /spiraling
not installed/verified there). SQD live-tail has complete planning artifacts on a
pushed branch, 42 green tests, bounded blast radius, and a named consumer.

## Run via — spiral-harness (the loop IS the composition) (REQUIRED)

The driving composition is the spiral harness pipeline itself:
`SEED → SIMSTIM (plan→code→PR w/ Flatline+review+audit) → HARVEST → EVALUATE`,
with the operator stepping in at: (1) **launch approval** (spiral spends real model
dollars — $10–15/cycle standard profile; do NOT `--start` without an explicit
operator go), (2) **PR merge** (BB gate, standing order), (3) any HALT.

Dispatch is mechanically enforced: invoking `/spiraling` with a task creates
`.run/spiral-dispatch-active` and blocks direct code writes until
`spiral-harness.sh` is dispatched. Never implement in-conversation.

## Load Order

1. `grimoires/loa/specs/spiral-seed-001-sqd-live-tail.md` — the genome (this is item 1; the harness gets it via `--seed-context`)
2. `.claude/skills/spiraling/SKILL.md` — dispatch guard + usage + stopping conditions
3. `grimoires/loa/context/2026-07-05-warehouse-supply-lane-adr.md` — two-lane doctrine the work must honor
4. `grimoires/loa/known-failures.md` — KF intake discipline (repo rule: read FIRST)
5. Branch `feat/svm-sqd-substrate` — the code + re-scoped PRD/SDD/sprint to resume

## Persona

None required beyond the harness's own roles. ARCH-structural questions route to
OSTROM (`.claude/constructs/packs/the-arcade/identity/OSTROM.md`) if the data-flow
design reopens; craft lens for this domain = evidence-chain (k-hole style: every
claim file:line or verified probe), already baked into the seed.

## What to Build (in order)

### 1. Preflight the seed
```bash
wc -c grimoires/loa/specs/spiral-seed-001-sqd-live-tail.md   # MUST be ≤ 4096
/spiral --start --dry-run                                    # config validation only
```

### 2. Get the operator go (REQUIRED — financial stakes)
State the spend: ≤ 3 cycles × $15 = $45 cap, standard profile. Wait for explicit yes.

### 3. Launch
```bash
.claude/scripts/spiral-harness.sh \
  --task "Land SqdCollectionEventSource live-tail lane per seed: finish feat/svm-sqd-substrate, converge on svm.collection_event content-addressed PK, pass §4.5 gate vs pythians fixture, PR with BB review" \
  --cycle-dir .run/cycles/spiral-001 \
  --cycle-id spiral-001 \
  --branch feat/spiral-sqd-live-tail-001 \
  --budget 15 \
  --profile standard \
  --seed-context grimoires/loa/specs/spiral-seed-001-sqd-live-tail.md
```

### 4. Monitor kaironically
`/spiral --status` at natural checkpoints. HALT conditions are in the seed
(portal turns paid; plateau; budget). Results land at completion — no mid-flight
check-ins.

### 5. Harvest back into the genome pattern
After the run: whatever HARVEST routes (visions/lore/bugs) becomes cycle-2's SEED
automatically (degraded mode reads the prior cycle's sidecar). If the designed-seed
pattern proved out, distill "seed authoring" into a reusable template — that is the
follow-on candidate, not part of this run.

## Quality Rules (evidence-chain lens)

- Every seed claim stays verifiable: portal height, filter ceiling, fixture counts
  are dated probes — re-verify any that are > 7 days old before launch.
- §4.5 gate is recompute-based (DAS = trust root) — never assert completeness from
  the lane's own numbers.
- Meter + budget guard ship with the first integration line (helius-meter precedent).
- Cheap-and-loud: any long-running step must emit progress that survives `npx | pipe`
  buffering (the walk-train lesson — unbuffered or line-flushed logging).

## What NOT to Build

- No deep-history backfill (solarchive = separate operator-gated probe track)
- No Dune calls of any kind (operator-approved spends only)
- No new metered providers/keys (spike protocol gate first)
- No Base/EVM or webhook-lane changes
- No seed-template generalization inside this run (harvest first, distill after)

## Review Cadence

Financial-stakes-adjacent (real model spend + data-validity gate): the harness
embeds Flatline + independent review + audit per cycle; the merge gate is
**bridgebuilder-review — mandatory, operator standing order**. Do not offer
`--skip-harden`-style shortcuts on the PR.

## Verify

- `wc -c` seed ≤ 4096 ✓ (2.5KB at kickoff)
- `/spiral --start --dry-run` exits clean
- Post-run: `svm.collection_event` rows queryable in the score-api consumer shape;
  §4.5 gate PASS logged; ledger delta within budget; BB review posted on the PR.

## Key References

| Topic | Path |
|---|---|
| The seed (genome) | `grimoires/loa/specs/spiral-seed-001-sqd-live-tail.md` |
| Spiral skill + guard | `.claude/skills/spiraling/SKILL.md` |
| Harness argspec | `.claude/scripts/spiral-harness.sh:195-201` |
| 4096-byte seed window | `.claude/scripts/spiral-harness.sh:283-284` |
| SEED phase modes | `.claude/scripts/spiral-orchestrator.sh:573-716` |
| RFC-060 design | `grimoires/loa/proposals/rfc-060-spiral.md` |
| Two-lane ADR | `grimoires/loa/context/2026-07-05-warehouse-supply-lane-adr.md` |
| Payload branch | `feat/svm-sqd-substrate` (origin) |
