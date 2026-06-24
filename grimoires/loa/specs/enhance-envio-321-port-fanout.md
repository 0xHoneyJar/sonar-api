---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — Layer-1 indexing migration to managed Envio"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "port the 30 remaining envio handlers alpha.17→3.2.1 via a governed /compose fan-out so the managed-Envio indexer runs on Cloud"}
  learning_status: directionally-correct
  source: team-internal
---

# Session S183 — Envio alpha.17 → 3.2.1 handler PORT (the fan-out)

> Managed Envio is reachable + the port transform is PROVEN on Cloud (the probe). The foundation
> (verify-net + guardrails) is built + `valid_run`-proven. This session ports the remaining 30
> handlers via the governed fan-out, then sf-vaults solo, then finalize → re-deploy → bd-buho.

## Context
The migration is committed-direction (managed Envio) and de-risked: a live Cloud canary proved a
3.2.1-ported `indexer.onEvent` handler indexes (the probe), and **Foundation S182** is done +
proven (`/compose` run `envio321-foundation-01` = `valid_run`). The base branch
**`feat/envio-321-port`** (`01d97d2c`, in worktree `/tmp/sonar-canary`, **local — NOT pushed**)
carries: HyperSync config + lazy `@0xhoneyjar/events` import + envio@3.2.1 pin+lock + FatBera
merge + the full **verify-net**. The ONLY remaining work is the mechanical-but-extensive port of
the 30 non-sf-vaults handlers, then sf-vaults solo, finalize, and the Cloud re-deploy gate.

This is **HIGH STAKES (data-validity)** — it's the indexer's correctness. The per-family FAGAN
gate + the verify-net are MANDATORY; single-pass review is forbidden (one corpus shares its blind
spots).

## Run via — `code-implement-and-review` (REQUIRED — the proven vehicle)
Composition: `~/.loa/constructs/substrates/construct-rooms-substrate/compositions/code-implement-and-review.yaml`
Its emitted Form-C segment natively fans out on **`args.items`**: iteration-1 = wave-scheduled
**sonner leaves** (one per item), iteration-2 = the **opus FAGAN** craft-gate reviewing the
consolidated diff, converging on APPROVED (cap 3). This is the per-tier routing (sonnet leaves +
opus gate) — NOT blanket-opus. **Rails:** items fan out → FAGAN gate → iterate → seam (operator
confirm) → terminal gate. Proven this lineage: the Foundation run.

### The exact recipe (proven `envio321-foundation-01`)
```
RT="$HOME/.loa/constructs/substrates/construct-rooms-substrate"
SCHEMA="$HOME/Documents/GitHub/loa-constructs/.claude/schemas/runtime/composition.schema.json"
# 1. COMPILE (validate-before-spend; exit 3 = ready). NEW run-id per phase.
LOA_COMPOSE_SCHEMA="$SCHEMA" "$RT/scripts/compose-dispatch.sh" \
  "$RT/compositions/code-implement-and-review.yaml" --form-c --run-id envio321-port-01 --json
# manifest + segment at ~/.loa/constructs/substrates/.run/compose/envio321-port-01/
# 2. RUN the segment via the Workflow tool with args.items (see shape below):
#    Workflow({ scriptPath: <run-dir>/workflows/code-implement-and-review.segment-1.workflow.js,
#               args: { items: [ ...one per handler-family... ] } })
# 3. WRAP each handoff seed (invocation_mode MUST be room|studio|headless — NOT "fresh"):
printf '%s' '{"construct_slug":"fagan","persona":"FAGAN","output_type":"Verdict","invocation_mode":"room","stage_index":1,"verdict":"APPROVED"}' \
  | "$RT/scripts/compose-handoff-wrap.sh" --seed - --cycle-id envio-3.2.1-api-port --run-id envio321-port-01 --json
# 4. TERMINAL GATE — prove the run:
"$RT/scripts/compose-verify-run.sh" envio321-port-01 --require-executed --legba --json   # expect valid_run
```

### `args.items` shape (one item per handler-family; leaves edit in /tmp/sonar-canary)
```jsonc
{ "id": "family-nft-transfer",
  "task": "Work in /tmp/sonar-canary on branch feat/envio-321-port. Port THESE handler files [list] from the alpha.17 API to 3.2.1: `export const handleX = ContractName.Event.handler(async ({event,context})=>{...})` + `import {...} from \"generated\"` → side-effecting `indexer.onEvent({contract:\"ContractName\", event:\"EventName\"}, async ({event,context})=>{...})` + `import { indexer, type Entity } from \"envio\"`. PRESERVE all entity read/write logic verbatim (context.Entity.get/set survives; isPreload is a real 3.2.1 BaseHandlerContext property). EDIT only your family's files; tsc-check them; do NOT run git or `envio codegen` (consolidated verification runs after — avoids parallel .envio races). Reference the PROVEN ported example: src/probe_handlers/honey-jar-probe.ts.",
  "acceptance": "every handler in the family uses indexer.onEvent (or contractRegister), imports from \"envio\", no `from \"generated\"`, entity logic unchanged, tsc-clean for the family." }
```
After the segment converges + FAGAN APPROVES, run the consolidated gate yourself:
`cd /tmp/sonar-canary && ENVIO321_CONFIG=config.yaml pnpm verify:321` (L1 codegen→L2 tsc→L3 **real
registration check** recorded==configured→L4 createTestIndexer→L5 vitest) + `pnpm verify:321-bijection`.
The registration gap closes from 83→0 as families land.

## Load Order
1. **This doc.** 2. `grimoires/loa/sdd.md` §2A (the port design + the per-handler transform + AC-PORT-1..9). 3. `grimoires/loa/NOTES.md` (`2026-06-17 (night)` resume block — the live recipe + branch lineage). 4. The composition yaml (above). 5. The proven reference handler `src/probe_handlers/honey-jar-probe.ts`.

## Persona
ARCH (OSTROM, the-arcade) for the structure + **FAGAN** (construct-fagan) as the craft-gate (the composition wires it). Executor = main-loop Claude driving the `/compose` runtime.

## What to Build (in order)
1. **The 30-handler fan-out** (this is the `args.items` run). Batch by family per **SDD §2A.5**.
   The 31 files in `src/handlers/` (`constants.ts` is shared constants, NOT a handler — exclude;
   **`sf-vaults.ts` is the ONLY `contractRegister`+Effects+viem handler → EXCLUDE here, solo next**).
   Suggested families (group the remaining 29): NFT-Transfer (honey-jar-nfts, milady-collection,
   mibera-collection, crayons-collections, tracked-erc721, …), ERC-1155 (badges1155, mints1155,
   puru-apiculture1155, mibera-sets, mibera-zora, cubbadges/candies1155…), Vaults-DeFi
   (aquabera-vault-direct, aquabera-wall, henlo-vault, moneycomb-vault, fatbera, fatbera-core, bgt,
   paddlefi), Mibera (mibera-premint, mibera-liquid-backing, mibera-staking, vm-minted), Markets-misc
   (friendtech, seaport, apdao-auction, tracked-erc20, mints, crayons, mirror-observability).
2. **sf-vaults SOLO** — a separate `code-implement-and-review` run (opus leaf, not sonnet — 1189
   lines, 2 `contractRegister`, 2 Effects, a Berachain viem client). Its Cloud-RPC config risk
   (flatline SKP-003) is UNPROVEN — verify the registration check covers its dynamic contracts.
3. **FINALIZE** — delete the now-obsolete `src/EventHandlers.ts` (+ `src/belts/mibera/EventHandlers.mibera.ts`); run the full `pnpm verify:321` on `config.yaml` → registration gap must be **0/83**, bijection clean.
4. **Cloud re-deploy gate (AC-PORT-9)** — push `feat/envio-321-port`; the operator points an Envio
   Cloud instance at it (full `config.yaml`) and confirms it gets PAST the crash-loop + syncs the 6
   chains. THE only Cloud round-trip. → unblocks the managed deploy → 6-chain price/version → `bd-buho`.

## Quality Rules (FAGAN / data-validity lens)
- The transform is **registration-shape only** — entity read/write bodies must be byte-identical (a silent logic change is the #1 risk; FAGAN verifies TASK-conformance first, diff-quality second).
- Each family passes the **registration check** (L3): the ported handlers must ACTUALLY register (recorded == configured), not just be statically present — catches a present-but-never-fired `onEvent`.
- `contractRegister` (sf-vaults) is covered by the bijection's dynamic branch (SKP-005) — don't false-pass it.
- Match `honey-jar-probe.ts` exactly for the import + `onEvent` shape. No scope creep (Barth).

## What NOT to Build
- Do NOT re-do the foundation or touch the verify-net (`scripts/verify-envio-321.sh`, `check-onevent-bijection.mjs`, `test/registration-coverage.test.ts`) — it's proven.
- Do NOT port sf-vaults in the fan-out — it's solo/last.
- Do NOT run `envio codegen`/`git` inside parallel leaves (races on `.envio/`) — consolidate + verify after.
- Do NOT push or deploy autonomously — the operator drives the push + the Cloud re-deploy.
- Do NOT touch `.claude/`.

## Verify
- Per-family: tsc-clean + the leaf's acceptance.
- Consolidated: `ENVIO321_CONFIG=config.yaml pnpm verify:321` → L1 codegen exit 0, L3 registration **0/83→0**, L5 vitest green; `pnpm verify:321-bijection` clean.
- `/compose` terminal gate per run: `compose-verify-run <id> --require-executed --legba` → **valid_run**.
- Final: the Cloud re-deploy (AC-PORT-9) syncs without crash-loop.

## Review provenance + Open operator decisions
- SDD §2A was **flatline-reviewed** (16 blockers / 100% agreement, `a2a/flatline/sdd-review.json`); the foundation folded in the verify-net + the dynamic-bijection + the isPreload grounding + the hardened L3.
- **Open (operator decides at the seams):** the **parity methodology** (flatline SKP-002/012 — validate the ported indexer vs **on-chain ground-truth**, NOT the alpha.17 live green, since comparing two engine versions is noise) — resolve before the Cloud-parity step; and the **events-pillar on Cloud** (R1: the private-repo postinstall — likely "keep a small pillar service" vs vendor/give-Cloud-access) — a separate track, post-port.

## Key References
| Topic | Path |
|---|---|
| Port design + transform + AC-PORT-1..9 | `grimoires/loa/sdd.md` §2A |
| Live resume recipe + branch lineage | `grimoires/loa/NOTES.md` (2026-06-17 night) |
| Proven ported handler (the reference) | `/tmp/sonar-canary/src/probe_handlers/honey-jar-probe.ts` |
| Verify-net | `scripts/verify-envio-321.sh` · `scripts/check-onevent-bijection.mjs` · `test/registration-coverage.test.ts` |
| Composition | `…/construct-rooms-substrate/compositions/code-implement-and-review.yaml` |
| Beads | cycle `envio-3.2.1-api-port`: `bd-o0g` (S183 port) · `bd-voi` (S184 finalize) |
| ADR + verdict (the why) | `grimoires/loa/context/2026-06-15-indexing-strategy-reframe-adr.md` · `…tco-verdict.md` |
