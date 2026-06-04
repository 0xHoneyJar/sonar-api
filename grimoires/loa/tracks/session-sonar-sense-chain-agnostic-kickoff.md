---
session: chain-agnostic
date: 2026-06-03
type: kickoff
status: planned
stakes_tier: data-validity
---

# Sonar Sense — chain-agnostic port unification (#1) · kickoff

## Scope
- Unify the EVM (viem) + Solana (web3.js) adapters behind ONE chain-agnostic `SonarSense`: `Address` union + `ChainAdapter` registry + chain-dispatch.
- The verb-concepts stay (`native`/`balance`/`owns`/`read`/`doctor`); the chain enriches (operator steer 2026-06-03).
- Grounding/verify spine lives ONCE at the port level, adapter-agnostic — "verified state, any chain" (ACVP).
- Derisking-first build order: additive widenings (domain → port) before any Solana wiring; the merged EVM V1 must not flinch (42 V1 tests = the tripwire at every step).

## Artifacts
- Build doc: `specs/enhance-sonar-sense-chain-agnostic.md` (ARCH + ENHANCE merged — source of truth)
- Beads: epic `bd-xdu` + 9 tasks (`bd-xdu.1`…`bd-xdu.9`), DAG-ordered; `bd-xdu.1` (domain widen) is the only ready task
- Driving composition: `code-implement-and-review` (cheval `review_routing` fires on data-validity)

## Prior session
V1 EVM sense-kit shipped + merged (PR #61 → `b-1-green-belt`); Solana mini-prototype proved the envelope ports (commit `440fd356`, 5/5 live mainnet smoke).

## Decisions made
- **STAKES = data-validity → HIGH** — per-layer review is the cheval-routed multimodal council (mandatory; single-model forbidden).
- **Additive widen** is the derisking lever — `chain_id: number → number|string` and `Address` union are wider types; EVM call-sites unchanged.
- **WRAP, don't rewrite** the EVM viem reader — it becomes the EVM adapter's engine untouched.
- **Open forks deferred to operator** (in build doc §Open operator decisions): D1 `read` descriptor shape · D2 Solana chain_id value · D3 SolanaAddress brand · D4 CLI scope this session vs follow-up.
