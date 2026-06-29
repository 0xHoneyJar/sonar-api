---
session: S183
date: 2026-06-18
type: kickoff
status: planned
hivemind:
  schema_version: "1.0"
  artifact_type: meeting-notes
  product_area: "sonar-api — Layer-1 indexing migration to managed Envio"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "session continuity — handoff for the envio 3.2.1 handler port fan-out"}
  learning_status: smol-evidence
  source: team-internal
---

# Session S183 — Envio 3.2.1 handler PORT fan-out (kickoff)

## Scope
- Port the **30 non-sf-vaults handlers** alpha.17→3.2.1 (`.handler()`/`from generated` → `indexer.onEvent`/`from envio`) via a governed `/compose` `code-implement-and-review` `args.items` fan-out (sonnet leaves + opus FAGAN gate), batched by family (SDD §2A.5).
- **sf-vaults SOLO** after (opus leaf — the only `contractRegister`+Effects+viem-RPC handler).
- **Finalize** (delete `EventHandlers.ts`; full `pnpm verify:321` → registration 0/83).
- **Cloud re-deploy gate (AC-PORT-9)** → 6-chain price/version → ratify `bd-buho`.

## Artifacts
- Build doc: `specs/enhance-envio-321-port-fanout.md` (source of truth — the exact /compose recipe)
- Architecture: `sdd.md` §2A (the port transform + AC-PORT-1..9)

## Prior session (what's done + proven)
- **Foundation S182 `valid_run`-proven** (`/compose` run `envio321-foundation-01`): verify-net (L1–L5 + bijection + hardened registration check) + config restructure + T0 cleanups. Commits `fbd454dd` + `01d97d2c` on `feat/envio-321-port` (LOCAL, not pushed; worktree `/tmp/sonar-canary`).
- **Deploy path PROVEN** on Cloud (the probe `probe/envio-321-deploypath`): a 3.2.1-ported handler indexes live on Optimism, no crash-loop.
- Managed-Envio version drift (3.2.1) + FatBera same-address merge + lazy events import + HyperSync restore — all landed on the base branch.

## Decisions made
- Vehicle: `code-implement-and-review` (its segment fans out on `args.items` — per-tier routing: sonnet leaves, opus FAGAN gate). NOT a raw blanket-opus Workflow.
- Foundation BEFORE the fan-out (the verify-net is the gate 30 leaves run against; a systematic port error replicates 30× without it).
- sf-vaults isolated solo/last (highest-risk, dynamic registration + viem RPC).
- HIGH-stakes (data-validity) → per-family FAGAN gate + verify-net mandatory; no single-pass review.
- Leaves EDIT only (no parallel codegen/git — `.envio/` race); consolidated verify after.

## Open operator decisions (surface at the seams — do not silently resolve)
- **Parity methodology** (flatline SKP-002/012): validate the ported indexer vs **on-chain ground-truth**, not the alpha.17 live green (two-engine comparison is noise). Resolve before the Cloud-parity step.
- **Events-pillar on Cloud** (R1): the private-repo postinstall → likely "keep a small pillar service" vs vendor/give-Cloud-access. Separate track, post-port.
