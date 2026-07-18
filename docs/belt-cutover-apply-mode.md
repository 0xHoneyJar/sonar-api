# Belt Cutover Apply-Mode Runbook (S1-T5)

> **Purpose**: record which alias-flip *apply mechanism* the belt uses and its measured drop-count,
> so the zero-downtime claim (SDD §7.4 step 4, PRD FR-B3) is grounded in a measurement, not an
> assertion. Update the **Measured** table below after each `gate-a-proof.sh --apply` run.

## The two apply modes (SDD §7.4)

| Mode | Mechanism | When | Expected drop-count |
|------|-----------|------|---------------------|
| **B (default)** | Graceful `caddy reload` via **loopback-only** admin (`Caddyfile`: `admin localhost:2019`). `promote.sh` flips `$BELT_UPSTREAM`; Caddy reloads config in-process without dropping connections. | Whenever loopback reload is reachable on the platform. | **0** |
| **C (contingency)** | ≥2 gateway replicas → rolling redeploy. `promote.sh` flips the var; Railway rolls replicas one at a time so the alias always has a live replica. | Only if Option B's loopback reload proves infeasible on Railway. | **0** (rolling) — brief per-replica reload, never a full-alias gap |

No re-decision is needed to move B→C — pick per the measured behavior below.

## Safety invariant (bd-c09.2)

The Caddy admin endpoint MUST be **loopback-only**. Verify after every gateway deploy:

```bash
# From OUTSIDE the gateway container — this MUST fail (connection refused / timeout):
curl -sS --max-time 5 http://<gateway-host>:2019/config/  # expect: FAILURE
```

If an off-host curl to `:2019` succeeds, the admin API is exposed — **halt and rebind to loopback**
before any further cutover (an exposed admin API can rewrite the live upstream unauthenticated).

## How to measure

```bash
BLUE_GRAPHQL_URL=... GREEN_GRAPHQL_URL=... ALIAS_URL=<staging-alias> \
  scripts/gate-a-proof.sh --apply         # spawns a prober, flips, asserts drops==0
```

The proof record lands at `grimoires/loa/a2a/sprint-1/gate-a-proof.json`
(`{"gate_a":"PASS|FAIL","drops":N,"height_regressions":N,...}`).

## Measured (fill in per run)

| Date | Apply mode | Drops / samples | Split-brain regressions | Loopback-admin off-host = fail? | Verdict |
|------|-----------|-----------------|-------------------------|--------------------------------|---------|
| _pending first `gate-a-proof.sh --apply` on staging_ | B (assumed) | — | — | — | — |

> Until this table has a real row, Option B is the *assumed* default; the zero-downtime claim is
> **unproven** (GATE-A not yet executed — PRD R-2). Run `gate-a-proof.sh --apply` on a staging pair
> to fill it and retire R-2.

## Rollback

On any §8 trigger in the first hour (5xx spike, missing entity, reconciliation divergence, operator
call): `scripts/rollback-belt.sh` (alias revert via `promote.sh --rollback` + optional
`--snapshot-dir` data restore + consumer verify; keeps green for postmortem — no fix-in-place).
