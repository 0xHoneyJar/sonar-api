# Erasure ledger — 2026-07-19

> Why the repo got *smaller* for agents. Taelin: intelligence is half removal.

## Branch count (agent decision forks at cold start)

| Fork | Before | After |
|------|--------|-------|
| Which PRD/SDD? | 6 named files, conflicting headers | 1 card in `ARRIVAL.md` |
| Ponder vs Envio? | Open bead + ride gap | Closed — Envio; CI = `belt-build.yml` |
| Node 20 vs 22? | Rule vs engines | Aligned ≥22 |
| NftActivity in schema? | Ambiguous planning language | Closed — package DTO, not GraphQL type |
| Semver tags? | Governance "gap" | Closed — SHA+Railway identity |
| NOTES as briefing? | 847-line sludge | 31-line stub; 819 lines archived |
| SDD sibling path | Self-ref `sdd.md` → `sdd.md` | Fixed → `sdd-belt-zero-downtime.md` |
| PRD path in SDD | Phantom `prd-evm-onboarding-contract.md` | Fixed → `prd.md` |

**Net:** ~8 cold-start branches → ~0 open intake branches. Work beads remain; *orientation* does not.

## What was removed / relocated (not deleted from universe)

| Moved | To |
|-------|-----|
| NOTES body (sessions May–Jul) | `archive/NOTES-ledger-through-2026-07-19.md` |
| Ride gaps 003–006 | Resolved section in `gaps.md` |
| bd-c7jv | Closed (already fixed in tree) |

## What was added (compression artifacts only)

| File | Role |
|------|------|
| `../ARRIVAL.md` | Single door — load order + closed questions + DO-NOT-READ |
| This file | Proof we meant the erasure |

## Reconstructibility check

From `ARRIVAL.md` alone, an agent should answer:

1. Runtime framework? → Envio 3.2.1  
2. NftActivity storage? → Not GraphQL; `@0xhoneyjar/events` + `src/canonical`  
3. Production CI file? → `belt-build.yml`  
4. Feature-planning docs? → `prd.md` / `sdd.md`  
5. Node major? → ≥22  

If a future session re-opens these without new code evidence, that is **accretion failure** — re-read ARRIVAL, do not write another gap.
