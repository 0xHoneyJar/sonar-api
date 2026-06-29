---
session: 11
date: 2026-06-15
type: kickoff
status: planned
hivemind:
  schema_version: "1.0"
  artifact_type: meeting-notes
  product_area: "sonar-api — Ponder belt indexer (data validity + ownership surfaces)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "session continuity — what was planned and why"}
  learning_status: smol-evidence
  source: team-internal
---

# Session 11 — eRPC getLogs resilience + Optimism 1155 holder balances (kickoff)

## Scope
- **WS1 (#72)** — getLogs malformed-response resilience [LIVE BLOCKER]. green-v3 crash-loops on
  a HoneyJar Ethereum getLogs (log entry missing `blockNumber`). SPIKE: ponder-retry vs eRPC-patch
  vs sidecar → operator picks at the seam. eRPC config CANNOT do it (grounded-verified).
- **WS2 (#73)** — eRPC cache volume durable: ~75% alarm + decommissioned-chain prune, no finalized TTL.
- **WS3 (#62)** — Optimism Mibera Sets/Zora ERC-1155 holder balances: replicate the candies-balance
  pattern (schema + helper + wire + tests). Unblocks mibera-dimensions Alchemy removal (cycle-022 P0).
- Reindex (bd-r90) backfills WS3 once WS1 + WS3 land. Operator-gated.

## Artifacts
- Build doc: `specs/enhance-session-11-erpc-resilience-and-op1155-holders.md`
- Beads epic: `bd-s11-erpc-1155-87l` (7 tasks; ready = WS1-spike .1, WS3-schema .2, WS2 .3)
- GitHub: #72 (WS1), #73 (WS2), #62 (WS3) on 0xHoneyJar/sonar-api
- Source spec (cross-repo): `mibera-dimensions/grimoires/loa/specs/bldg-sonar-optimism-1155-holder-spec.md`

## Prior session
This kickoff grew out of the #71 Railway-cleanup investigation (composition KRANZ+GECKO+FAGAN):
the issue was verified-inverted (ponder_v3/green-v3 is live, not zerker_v1/green-v2), the eRPC
cache + green-v3 were recovered, and #72/#73 were filed. green-v3 then re-crashed → #72 is the gate.

## Decisions made
- Scope = full sweep (#72 + #73 + #62).
- WS1 approach = "investigate all 3 layers, recommend in doc" (eRPC config is infeasible — verified).
- Live freeze folded into the build session (no immediate hotfix) — ponder_v3 stays frozen until WS1 lands.
- Stakes = data-validity → HIGH → cheval-routed multimodal council per layer; no --skip-harden.
- Canonical handler dir = `ponder-runtime/` (root `src/handlers/` is dead Envio legacy).

## Grounded this session (don't re-derive)
- eRPC has NO config-level getLogs response validation (any version); only eth_getBlockReceipts is validated.
- The malformed getLogs is intermittent (no single upstream to ignoreMethods).
- WS3 pattern fully mapped from candies-balance.ts + candies-market1155.ts + ponder.schema.ts.
