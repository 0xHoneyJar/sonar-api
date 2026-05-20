---
session: 2
date: 2026-05-20
type: kickoff
status: planned
---

# Session 2 — Resume Mibera belt S2-T3→S3 (kickoff)

## Scope
- Resume the `indexer-belt-rebuild` cycle after DISS-003 was resolved (envio alpha.17).
- Immediate next: **S2-T3 entity-emission proof** — run the belt through eRPC, confirm the
  3 SDD §6 queries (AC-4).
- Then S2-T4 (belt Railway deploy + belt Postgres) → S2-T5 (cold sync + on-chain loan
  reconciliation, AC-6) → S3 (gateway, observability, hardening, staged handback).
- Forward (deferred): eRPC cold-sync benchmark · own Berachain node behind eRPC · stable
  V3 migration by extraction.

## Artifacts
- Build doc: `grimoires/loa/specs/enhance-s2-resume-erpc-belt.md` (source of truth)

## Prior session
Session 1 = the cycle kickoff. This session: found + fixed DISS-003 — the cycle's central
blocker. Chain: HyperSync now needs a token (the fire) → pivot to sovereign RPC/eRPC →
Envio RPC crashed on Berachain (`totalDifficulty`) → eRPC can't inject it / stable Envio
breaks handlers / a shim PoC proved the theory → expert consult → **pinned `envio@3.0.0-alpha.17`**
(Envio #998 fix + working bin + below the alpha.23 handler break). Sovereign belt→eRPC path
validated + committed (`08f3a99`). S0/S1/S2-T1/S2-T2 done.

## Decisions made
- **DISS-003 fix = `envio@3.0.0-alpha.17`, exact pin** (NOT alpha.16 — broken bin; NOT
  alpha.23+/stable — handler-API break). Keeps the sovereign belt → eRPC → free-RPC path.
- HyperSync only as a bounded one-time backfill accelerator if cold-sync ETA forces it; not steady state.
- Stable V3 migration deferred, to be done by extraction (belt first, then monolith).
- eRPC = sovereign routing/cache today; sovereign data *origin* (own node) is a later step.
- Gotchas captured in NOTES + the build doc: Docker.app PATH for creds · `TUI_OFF=true` ·
  re-codegen after data-source edits · port-9898 kill between runs · public RPCs rate-limited
  (use eRPC) · `dig-search.ts` + `gpt-review` are broken in this env (use Agent WebSearch).
