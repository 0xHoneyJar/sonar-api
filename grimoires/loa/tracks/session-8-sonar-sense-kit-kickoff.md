---
session: 8
date: 2026-06-03
type: kickoff
status: planned
---

# Session 8 — Sonar Sense Kit (kickoff)

## Scope
- Build Sonar's **sense-edge**: an agent-callable chain-read kit (honeycomb four-folder `domain/ports/live/mock`) where every read is a grounded `Observation`.
- The verify spine: every read carries a locally-declared EpistemicTristate (`grounded|refuted|unverifiable`) — Score's missing first-hand parity-check, made structural.
- Transport: viem-over-`NativeBlockchainReader` (tier-1); Paradigm alloy/reth as a tier-2 escape hatch behind the same port.
- V1 verbs (grounded): `doctor` · `read` · `balance` · `owns` · `native`. `category`/`categories` deferred (no Sonar index source — HARDEN CRITICAL).
- incur CLI + MCP surface from one schema set.

## Artifacts
- Build doc (source of truth): `grimoires/loa/specs/enhance-sonar-sense-kit.md` (HARDEN-converged)
- Brief (research + reductions): `loa-freeside/grimoires/loa/context/2026-06-03-sonar-sense-kit-brief.md`
- Beads: epic `bd-zfj` + `bd-zfj.1…7` (dependency-ordered; `br ready` → `bd-zfj.1`)

## Prior session
Last shipped on `main`: `fix(b-1)` green-belt map HJs snake-case alignment (`total_h_js_burned`) — Sonar is a live Ponder/Envio indexer.

## Decisions made (kickoff)
- **Resolved**: kit = Sonar's sense-PORT; build the *identity* fresh, consume the *runtime* (chain-read) — port-in-engine, runtime-in-module. EpistemicTristate is canonical (declare locally — it's a pattern, not an import). `tier ⊥ grounding`; tier domain-local.
- **HARDEN (`wf_594a60cd`, SHIPPABLE-WITH-FIXES, 1 CRITICAL + 9 HIGH)**: folded fixes into the doc (declare-local tristate · `read`=first-party viem · belt-gateway endpoint · constructor-not-factory · `src/sense/` not workspace · no installable chain dep · no hand-added beacon `consumes:`).
- **5 open forks for the build session** (do NOT silently resolve): D1 home/extract-a-shared-building (strongest) · D2 eRPC reachability · D3 consumption channel · D4 GraphQL source-of-truth · D5 V1 scope (keep/cut `category`).
