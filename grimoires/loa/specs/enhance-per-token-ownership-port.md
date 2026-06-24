# Session 9 — Per-token ownership port (finish the Envio→Ponder migration for inventory)

> The blue belt froze 11.7 days ago. The Stash still reads it. Green has every count but no per-token owner. This session closes the last structural gap so inventory cuts to green — and the operator's candies finally render.

## Context

`inventory-api` (the honeyroad Stash) renders **per-token** ownership — "which tokenIds does wallet X own." It reads that from the **blue/Envio belt's `Token` table** (130,921 rows). Blue **froze 2026-05-27** (build-crashed, Envio deprecated) — so inventory serves ~12-day-stale ownership and cannot move, because the **green/Ponder belt has no per-token-721 owner entity**. Green has holder *counts* (`TrackedHolder`), per-token *1155 balances* (`TrackedHolder1155`), and the full `action` event ledger — but nothing answering "wallet → tokenIds" for 721s. Score cut over (it needs counts); inventory/Stash can't.

This session adds the missing `token` entity + the 721 transfer handlers, reindexes green from genesis, repoints inventory, and cuts over. After it, Mibera #7702 + Tarot + Fractures + MST + GIF + Candies all render fresh from sovereign Ponder; blue is retired.

**This spec is HARDEN-grounded (2026-06-07).** A four-lens panel read the real code + live-probed both belts. It confirmed the reindex is genuinely required (the "projection avoids reindex" idea was about 1155 *counts*, not 721 *ownership*) and corrected the brief's S1 scope — see `## What to Build` and `## HARDEN provenance`.

## Run via — `code-implement-and-review` (REQUIRED)

This is a multi-file indexer build with a **data-validity** quality bar. Run it through the code build+review loop, not freehand:

- **Composition:** `code-implement-and-review` — resolve via `/compose` (registry: `~/bonfire/construct-compositions/compositions/**`).
- **Rails (the loop):** for each handler/entity task → `implement` (write the ponder entity/handler + pure-helper vitest) → **review seam** (operator inspects the diff) → `review` (FAGAN) → fold → next. The operator steers at each review seam.
- **Or, in-cycle:** `/run sprint` within the `sonar-belt-factory` cycle — the 8 beads below ARE the sprint. Same implement→review→audit gate.

## Review Cadence (HIGH STAKES — data-validity · NOT optional)

Per-token ownership is the data that renders what users own and drives the honeyroad distributor. **Single-model review is forbidden** (one corpus shares its blind spots). Each handler/entity verb gets the **cheval-routed multimodal council**:

```
.claude/constructs/packs/fagan/scripts/cheval-council.sh <diff>     # default; or /fagan
```

Bind review voices to **headless** adapters (subscription auth, no API key): codex-headless + a claude reviewer + gemini-headless. This is the cadence the `sonar-belt-factory` cycle (financial/data-validity) already mandates. `--skip-harden`-class shortcuts do not apply here.

## Load Order

1. `grimoires/loa/specs/enhance-per-token-ownership-port.md` — this doc (the build spec)
2. `grimoires/loa/context/per-token-ownership-port-brief.md` — the arch/context brief (HARDEN-corrected header)
3. `ponder.schema.ts` — the authoritative green schema (where `token` lands; `action`/`miberaTransfer`/`trackedHolder`/`candiesHolderBalance` live here)
4. `ponder-runtime/src/handlers/mibera-collection.ts` — the ONE fully-ledgered 721 handler (the pattern to mirror)
5. `ponder-runtime/src/handlers/general-mints.ts` — MST/GIF handler (mint-only — the S1c fix target, lines ~75-77)
6. `ponder.config.mibera.ts` — contract registrations (`TrackedErc721Bera` ~75-88; `BERA_START_BLOCK=21424739` ~135)
7. inventory-api `src/live-sonar.ts` — the consumer contract the entities MUST satisfy byte-exact (do NOT change field names without changing this)
8. `decisions/` ADR-010 + `grimoires/loa/runbooks/candies-holder-balance-reindex.md` — the operator-led reindex/cutover procedure

## Persona

ARCH (Ostrom — structure) + **data-integrity lens** (the per-token-correctness / conservation conscience — `scar` for the trust boundary, the coherence-sweep doctrine for the aggregate-vs-per-token trap). NOT a visual lens. The quality dimension here is *correctness of ownership*, measured in field-exactness + conservation invariants + reorg-safety.

sonar-api is **dual-runtime**: `src/handlers/*.ts` (envio, `import from "generated"`) LOOK like main but production serves **Ponder green**. Indexer changes land in `ponder.schema.ts` (root) + `ponder-runtime/src/handlers/*.ts` (`import { ponder } from "ponder:registry"`). Branch base: **`b-1-green-belt`** (green-v3's deploy branch) — NOT main, NOT `feat/sonar-sense-solana`. Rebase #68's `feat/candies-holder-balance` on (shares the `d2a45381` ancestor) so one reindex backfills both.

## What to Build (in order)

> The 8 beads are the build sequence. S1a–c + S2 can run in parallel after the entity exists; the reindex (S3) is **operator-gated** and blocked behind all of them + the verify gate.

### 1. `bd-jyn` — S1a: the `token` 721 ownership entity + Mibera handler
New ponder entity `token` in `ponder.schema.ts`: `id = {contract}_{chainId}_{tokenId}`, fields `owner` (hex, **indexed**), `contract` (hex, indexed), `collection`/`collectionKey`, `chainId`, `tokenId` (bigint), `isBurned` (bool), `lastTransferTime`. **Field names MUST be byte-exact to the consumer**: inventory queries `Token(where: {collection, owner, isBurned: false}) { tokenId }`. Extend `mibera-collection.ts` (already writes mint+burn+secondary-transfer to `action`+`miberaTransfer`) to **also upsert the `token` current-owner**: mint (`from==0x0`) creates; transfer sets `owner=to`; burn (`to==0x0`) sets `isBurned=true`.

### 2. `bd-1jg` — S1b: the **missing** `TrackedErc721Bera:Transfer` handler (Tarot + Fractures) — NET-NEW
🔴 **Grounding finding — the brief was wrong here.** Tarot (`0x4B08…`) + the 10 Fractures + apdao_seat are registered as `TrackedErc721Bera` in `ponder.config.mibera.ts:75-88` but **have no handler on green** — `ponder.on("TrackedErc721Bera:Transfer")` does not exist; envio's `src/handlers/tracked-erc721.ts` was never ported. Their transfers hit green and **vanish**. Write the handler (port from the envio twin); write the `token` entity per transfer (owner=to, isBurned on `to==0x0`). This is net-new, not "extend."

### 3. `bd-d2b` — S1c: fix `GeneralMints` (MST + GIF) — currently mint-only
🔴 **Grounding finding.** `general-mints.ts:75-77` does `if (fromLower !== ZERO) return` — **mint-only**; every secondary transfer + burn for MST (`0x0483…`) / GIF (`0x2309…`) is dropped (a token minted to A then sold to B still shows A). Extend to upsert the `token` owner on non-mint transfers + burns **without breaking the load-bearing mint path** (verify the early-return isn't guarding other logic first).

### 4. `bd-3nh` — S2: `chain_metadata` freshness equivalent
Green has **no** `chain_metadata` (Envio artifact). inventory reads `chain_metadata(where: {chain_id}) { latest_processed_block }` for its ACVP `as_of_block`.
- 🎯 **The entity MUST be named `chain_metadata`** (flatline B5/B9) with fields exactly `chain_id` + `latest_processed_block` — its GraphQL root field is the consumer's query name. NOT `chain_head`.
- 🎯 **Do NOT write it on every block** (flatline B11 — DB lock contention). Two acceptable designs (H6): (a) expose Ponder's internal `_ponder_meta`/checkpoint as a `chain_metadata`-named view (no write path, preferred); or (b) a throttled block handler that updates only every N blocks. Pick (a) if the checkpoint exposes a per-chain processed block; else (b) with N tuned so freshness ≥ inventory's tolerance without per-block writes.

### 5. `bd-gpc` — S3-pre: VERIFY green genesis coverage (before the reindex)
⚠ **Unproven risk.** `BERA_START_BLOCK=21424739` (`ponder.config.mibera.ts:135`) = the blue-freeze block. If green forward-indexes from this boundary and leans on frozen pre-boundary history, the new entities backfill only **post-boundary** → incomplete ownership. Read-only check on `ponder_v3`: `SELECT DISTINCT action_type, primary_collection FROM ponder.action` + confirm pre-boundary Mibera history is present. **Gates `bd-r90`.**
- 🎯 **Define the fail branch** (flatline B12/H3 — gate without a failure path is operational ambiguity). If pre-boundary history is **ABSENT**: the only fix is a **true-genesis reindex** (start block → collection genesis, not the freeze boundary). That is an OPERATOR decision (cost + window). Until it lands, **inventory keeps reading blue** (stale-but-complete) rather than green (fresh-but-truncated) — the safe default is "do not cut over to a truncated green." Record the decision + interim-serving choice in the bead before `bd-r90`.

### 6. `bd-r90` — S3: green reindex from genesis (🔒 OPERATOR-GATED, ADR-010)
Deploy `b-1-green-belt` + S1a-c + S2 + #68 to `belt-indexer-green-v3` (schema `ponder_v3`, `Postgres-vRR1`). Reindex from genesis to backfill `token`, `candiesHolderBalance`, freshness. Verify row counts ≈ blue's `Token` (~130k). **Never run from an agent session** — rides `bd-umw.4` (dry-run promotion) + the green-PG ≠ blue-PG wipe guard.

### 7. `bd-rr0` — S4: inventory-api repoint + query mapping
On `feat/wire-candies-balances`: set `SONAR_GRAPHQL_ENDPOINT` → `https://belt-gateway-production.up.railway.app/v1/graphql` (green). The queries already match the planned entities (`Token`/`chain_metadata`/`TrackedHolder`/`CandiesHolderBalance`). `liveCandiesBalances`/`getHoldings` candies routing (#17) is **done**. Verify read-only against green for the operator wallet **before** deploy.
- 🎯 **Code may land; the DEPLOY waits for the reindex** (flatline B3). Repointing the prod endpoint to green BEFORE `bd-r90` completes serves empty/truncated ownership. The env flip is part of cutover (`bd-4kf`), not this task — `bd-rr0` is the query-mapping code only.

### 8. `bd-4kf` — S5: cutover + cleanup
Deploy inventory (verify-gated, endpoint flip to green). Confirm Stash renders end-to-end from green for the operator wallet.
- 🎯 **Keep blue until green is verified** (flatline H5). Do NOT retire blue (`belt-indexer`) until the green cutover is confirmed serving correct per-token ownership — blue is the rollback path. Retire blue + green-v1 + green-v2 only after the verify gate passes. Consolidation target: green-v3 + one rollback = 2 indexers.

### 🔐 IMMEDIATE (decoupled from the build) — rotate `SONAR_SIGNING_SEED_HEX` NOW
🎯 **flatline B4/B7/H2 — the panel's #1 point: rotation should block, not trail, the build.** The shared signing seed appeared in a sub-agent transcript; it's the same seed across all 3 greens. Deferring rotation to cutover (`bd-4kf`) leaves the exposed seed signing attestations across the entire multi-day build+reindex+verify window. **It is independent of the per-token work** — rotate it as soon as the operator can (Railway env, all green services), tracked as its own bead (`bd-54c`), NOT bundled into cutover. Not a confirmed public leak (transcript-local), but the conservative call is rotate-now.

### Optional · `bd-ok3` — candies COUNT stopgap (operator decision)
🟡 `mibera_drugs` IS live on green's `TrackedHolder1155` (384 holder rows) — but **`tokenId: null`** (holder-total, no per-edition). inventory could show candies **count > 0 today** (partial "till candies") without the reindex. Per-token candy **cards** (operator holds #3565/#2957) still need S1+#68+reindex. **Operator decides:** ship the count stopgap now, or wait for proper per-token.

## Quality Rules (data-integrity lens) — flatline-hardened 2026-06-07

- **Entity NAME is the GraphQL contract, not just the fields** (flatline B5/B9). Ponder derives the GraphQL root field from the entity name. The consumer queries `Token(...)` and `chain_metadata(...)` byte-exact → the entities/Hasura-tracked root fields MUST resolve to exactly `Token` and `chain_metadata`. Naming the freshness entity `chain_head` makes the consumer's `chain_metadata(...)` query **silently return null**. Pin the name → root-field mapping in the same PR as the entity; verify via the `metadata-diff` snapshot, not by assumption.
- **Field names are a contract.** `token` exposes exactly `tokenId`, `collection`, `owner`, `isBurned`; candies `candiesHolderBalance.holder_id` is **confirmed present** (ponder.schema.ts:123 — no longer "unverified", flatline B6). Change both ends in the same PR or neither.
- **Burn detection is per-collection, NOT hardcoded `to == 0x0`** (flatline B1 — real bug). Many 721s burn to a dead address (`0x…dEaD`, `0xdead…beef`) rather than `address(0)`. Before writing each collection's handler, VERIFY its actual burn pattern (read the contract / sample on-chain burns); treat the collection's real burn sink(s) as `isBurned=true`. Tarot/Fractures/apdao_seat burn patterns are unverified — verify, don't assume.
- **The token handler UPSERTS, never update-only** (flatline B2 — pre-boundary edge). A token transferred but whose mint predates the index boundary has no prior row. On any Transfer, `insert(token).onConflictDoUpdate(owner=to,…)` — create-if-absent. An update-only handler silently drops every pre-boundary token's ownership.
- **Last-write-wins is ordered by `(blockNumber, logIndex)`, not insert order** (flatline B10/H4). Two transfers of the same token in one block resolve by `logIndex`. Make the reorg contract explicit: the `action` ledger is the only reorg-safe source; the `token` projection re-derives on reorg.
- **Conservation invariant per collection:** `mints − burns == current non-burned token rows`. Assert post-reindex. `token` MUST be keyed per `(contract,chainId,tokenId)`, never rolled up (the coherence sweep proved whole-contract aggregates lie per-token).
- **Do not break the mint path** when extending `GeneralMints` — add the non-mint branch beside the early-return, vitest the pure helper.
- **Handlers can't be unit-tested without the runtime** — extract pure helpers (pattern: `mibera-liquid-backing/shared.ts`) + vitest those. Typecheck: `npx tsc -p ponder-runtime/tsconfig.json --noEmit`.

## What NOT to Build

- **No resurrecting Envio/blue.** It's deprecated; the cutover retires it. (The one-line ESM build fix is a bridge only if the operator explicitly wants fresh data before green lands — not part of this build.)
- **No new green indexer service.** Reuse green-v3 (`ponder_v3`/`Postgres-vRR1`). green-v1/v2 are retired, not extended.
- **No per-token 1155 rework** — #68's `candiesHolderBalance` is the candies per-token path; carry it, don't re-derive. `TrackedHolder1155` stays the holder-aggregate.
- **No running the reindex from an agent session** (ADR-010). Build + verify + hand the green reindex/cutover to the operator.
- **No "while I'm here" handler ports** for collections inventory doesn't render.

## Verify

- **Unit:** `npx tsc -p ponder-runtime/tsconfig.json --noEmit` clean; pure-helper vitests pass (mint/transfer/burn → owner transitions; conservation).
- **Schema→GraphQL:** at cutover `scripts/cutover-hasura-tracking.sh` auto-tracks `token`; regenerate `test/hasura-contract/metadata-diff.test.ts` snapshot.
- **Post-reindex (read-only, green):** `Token(where:{collection,owner,isBurned:false}){tokenId}` returns the operator wallet's Mibera #7702 + Tarot + Fractures (#1059/#1060) + MST; row count ≈ blue's ~130k; conservation holds.
- **End-to-end:** inventory pointed at green → honeyroad Stash renders fresh per-token + candies cards for the operator wallet.

## Key References

| Topic | Where (byte-exact) |
|-------|--------------------|
| Consumer 721 query | inventory `src/live-sonar.ts:87` — `Token(where:{collection,owner,isBurned:false}){tokenId}` |
| Consumer freshness query | inventory `src/live-sonar.ts:42` — `chain_metadata(where:{chain_id}){latest_processed_block}` |
| Consumer count query | inventory `src/live-sonar.ts:61` — `TrackedHolder(where:{collectionKey,address}){tokenCount}` (works on green as-is) |
| Consumer candies query | inventory `src/live-sonar.ts:99` — `CandiesHolderBalance(where:{holder_id,amount:{_gt:"0"}}){contract tokenId amount}` (holder_id CONFIRMED — ponder.schema.ts:123) |
| Endpoint to set | `SONAR_GRAPHQL_ENDPOINT=https://belt-gateway-production.up.railway.app/v1/graphql` (green; unset by default) |
| Mibera handler (mirror) | `ponder-runtime/src/handlers/mibera-collection.ts:77-262` |
| GeneralMints mint-only bug | `ponder-runtime/src/handlers/general-mints.ts:75-77` |
| TrackedErc721Bera registration (no handler) | `ponder.config.mibera.ts:75-88` |
| Genesis boundary | `ponder.config.mibera.ts:135` — `BERA_START_BLOCK=21424739` |
| Action ledger | `ponder.schema.ts:743` — `action` (numeric1=tokenId, context JSON {from,to}) |
| Candies entity (#68) | `ponder.schema.ts:123` — `candiesHolderBalance` (feat/candies-holder-balance) |
| Belts (live) | green gateway = `belt-gateway-production…/v1/graphql` (LIVE, ~head); blue = frozen 2026-05-27 @ block 21424739 |
| Reindex/cutover procedure | ADR-010 + `grimoires/loa/runbooks/candies-holder-balance-reindex.md` + rides `bd-umw.4` |

## HARDEN provenance

Four-lens grounded panel + 3 live belt probes (2026-06-07):
- **Reindex-vs-projection (highest value):** verdict **REINDEX REQUIRED**. The `token-4=2575` projection proof was per-token **1155 counts** (`puru_apiculture`), not **721 ownership**; even it needed a reindex. `bd-r90` stays.
- **S1 corrected (3× bigger):** Tarot/Fractures have **no** 721 handler (`bd-1jg`); MST/GIF are **mint-only** (`bd-d2b`). Only Mibera was fully ledgered.
- **Candies fast-path found:** `mibera_drugs` live on green `TrackedHolder1155` but `tokenId:null` → count-only stopgap possible (`bd-ok3`); per-token cards still need #68+reindex.
- **Live-confirmed:** blue frozen 11.7d (block 21424739, Token 130,921 rows); green live ~head (block 21682518); gateway serves green; green has no `Token`/`chain_metadata`.
- **Open operator decisions:** (a) ship `bd-ok3` candies-count stopgap now vs wait for per-token; (b) `bd-gpc` genesis-boundary result may force a true-genesis (not boundary-forward) reindex; (c) the reindex + cutover + seed-rotation are operator-led (ADR-010).

### Flatline provenance (2026-06-07, 3-model: claude + codex + gemini headless)
Independent cross-model gate (different corpus than the Claude-only HARDEN panel). Verdict: 8 HIGH_CONSENSUS, 0 DISPUTED, **12 BLOCKERS, 100% agreement**, 166s, $0 (subscription). Full JSON: `grimoires/loa/a2a/flatline/sdd-review.json`. **All 12 folded** into this doc + beads:
- B1 burn≠`0x0` (dead-address burns) → Quality Rules + `bd-1jg`/`bd-jyn`. B2 upsert-not-update (pre-boundary) → Quality Rules + `bd-jyn`. B5/B9 entity-name=GraphQL-root → Quality Rules + `bd-3nh`. B6 holder_id resolved (confirmed). B10 `(block,logIndex)` ordering → Quality Rules. B11 no per-block chain_metadata write → `bd-3nh`. B3 repoint-code-vs-deploy split → `bd-rr0`/`bd-4kf`. H5 keep-blue-until-verified → `bd-4kf`. B7/H7 apdao_seat explicit → `bd-1jg`. H8 `bd-ok3` stopgap needs a removal story.
- **Surfaced (operator):** B4/B7/H2 seed rotate-NOW (decoupled → `bd-54c`); B8/B12/H3 genesis-coverage fail branch → `bd-gpc`.
