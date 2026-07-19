---
title: "Session Notes"
trust_tier: operator-authored
read_state: unread
confidence: 0.7
decay_class: working
last_confirmed: 2026-07-19
operator_signed: self_attested
---

> **Agents: do not start here.** Read [`ARRIVAL.md`](ARRIVAL.md) first.
> This file is a *short* operator continuity stub. Historical ledger →
> [`archive/NOTES-ledger-through-2026-07-19.md`](archive/NOTES-ledger-through-2026-07-19.md).

## Session Continuity — 2026-07-19 (ride + erasure)

**Branch:** `feat/belt-zero-downtime`

**Done this session:**
- `/ride --enriched --force-restore` — System Zone from `loa/main`, checksums 5981, loa 1.196.0
- GAP-001 closed — Node rule → v22+
- GAP-002 closed — `sqd-parallel-loader.ts` restored (`9c33df84`), 13/13 tests
- **Erasure pass** — `ARRIVAL.md` agent door; NOTES bulk archived; SDD header self-ref fixed; gaps 003–006 closed
- CI ghost `bd-c7jv` closed — `ponder-ci.yml` already gone; live gate = `belt-build.yml`

**Code truth snapshot:** Envio 3.2.1 · Node ≥22 · 95 entities · 6 EVM + SVM · green entry `src/EventHandlers.ts`

**Open agent work (non-blocking):** remaining beads on `br ready` (belt soak, onboarding, SVM deploy) — not intake blockers.

**Do not re-litigate:** Ponder vs Envio; NftActivity-as-GraphQL-entity; which PRD (see ARRIVAL closed questions).

