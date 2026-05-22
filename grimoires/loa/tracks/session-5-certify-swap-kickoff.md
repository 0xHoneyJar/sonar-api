---
session: 5
date: 2026-05-22
type: kickoff
status: planned
cycle: sonar-belt-factory
---

# Session 5 — Certify green + gate expansion-mode + blue→green swap (kickoff)

## Scope
- Stand up `belt-hasura-green` (green's serving layer + swap target).
- Build gate **expansion-mode** (`bd-umw.6`): green ≥ blue NON-LOSSY for shared entities/chains (not parity); new chains routed to raw-L1.
- Wire **Part-4 raw-L1 ground-truth** (`bd-umw.7`): the only correctness check for new chains (Arbitrum/Zora, no blue baseline).
- Certify green (enhanced gate exit 0) → `promote.sh` swap (S3) → rollback test → retire blue.
- Then S4 (boundary/E2E) + `/run-bridge 3`.

## Artifacts
- Build doc (source of truth): `grimoires/loa/specs/enhance-session-5-certify-swap.md`
- (Arch folded into the build doc — one MD; scope overlapped.)

## Prior session (4)
Shipped S1 reconciliation gate (`promotion-gate.js`, review+audit APPROVED, DISS-001 enum fix, 18/18, COMPLETED). Stood up green = 6-chain consolidated belt (`Postgres-vRR1` + `belt-indexer-green`, isolated, seed BB-F006 COUNT==6 PASS incl. new Arbitrum+Zora, resume confirmed → cold-syncing).

## Decisions made (session 4, see NOTES Decision Log)
- **S2 = consolidation EXPANSION, not a parity dry-run** (operator) — green = `config.yaml` 6-chain, green ⊋ blue.
- Gate needs **expansion-mode** (non-lossy, not parity); new chains certified by **raw-L1 only** (sovereign, per "own our data" principle — HyperSync break-glass).
- Green = new services in `production` env (Vercel-style: watch sync → flip `BELT_UPSTREAM` → delete old blue). Per-service 24 GB caps → SR-2 cleared (no contention, cost-only, approved).
- `Dockerfile.belt` `BELT_CONFIG` build-arg (blue unchanged); green deploys via `railway up` (no push).
- Wipe-blue guard: green `ENVIO_PG_*` → `${{Postgres-vRR1.*}}` (verified `postgres-vrr1.railway.internal`, not blue).

## Open loose ends
- Revoke `~/.railway-green.tok` project token after the cycle ships.
- 5 deleted skill symlinks under `.claude/skills/` (pre-existing, unrelated) — restore via `git checkout --` if unintended.
