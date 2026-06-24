# What's Left to Build — sovereign per-token ownership + the compose substrate

> The Stash renders images + counts, but not *which* tokens you own. One structural gap stands between here and a fully-rendering Stash (incl. your candies). This is the map of everything left, grounded 2026-06-07.

## TL;DR (the one-screen answer)

- ✅ **DONE + LIVE:** sovereign metadata (mst/candies/tarot/gif/fractures), Stash images, Berachain Alchemy killed, #68 candies-balance code — plus tonight's **verified** self-transfer hardening (`e146eee0`).
- 🔨 **THE remaining build:** the **per-token ownership port** — makes the Stash render fresh per-token ownership + candies *cards*. **4 code beads + 1 read-only verify**, then **3 operator-gated** steps.
- 🧰 **Substrate:** the compose runtime needs **`bd-ii1m`** before it can reliably run high-stakes builds — it **misrouted tonight** (built the wrong thing).
- 🔓 **Decisions pending:** `e146eee0` keep/revert · `bd-54c` seed rotation (do now) · `bd-gpc` genesis fallback.

## What's already done (so you know the boundary)

| Thread | State |
|--------|-------|
| Sovereign metadata (5 collections) | ✅ LIVE — serve from CloudFront KVS pointer |
| Stash images | ✅ LIVE |
| Berachain Alchemy kill (S4b) | ✅ DONE — 8 consumers migrated |
| #68 candies-balance (`candiesHolderBalance`) | ✅ code complete; + `e146eee0` self-transfer guard (verified: tsc clean, 24/24) |
| `review_routing` schema gap (`bd-l9h0`) | ✅ FIXED this session (composition.schema.json v1.4) |

## What's LEFT (grouped, with current bead IDs)

### A. The per-token ownership port — THE build
> Detailed flatline-hardened spec: **`grimoires/loa/specs/enhance-per-token-ownership-port.md`** (12 blockers folded). This map is the index; that doc is the how.

**Agent-buildable now (the code):**
| # | Bead | What | Status |
|---|------|------|--------|
| 1 | `bd-jyn` (S1a) | `token` 721 entity + Mibera handler (upsert, per-collection burn, `(block,logIndex)`) | ⚠ OPEN — **tonight's autonomous build MISROUTED; not done** |
| 2 | `bd-1jg` (S1b) | `TrackedErc721Bera:Transfer` handler (Tarot + 10 Fractures + apdao_seat) — **net-new** | OPEN |
| 3 | `bd-d2b` (S1c) | `GeneralMints` fix — write owner on secondary transfer+burn (MST + GIF) | OPEN |
| 4 | `bd-3nh` (S2) | `chain_metadata` freshness entity (NOT per-block write; entity name = `chain_metadata`) | OPEN |
| 5 | `bd-gpc` (S3-pre) | VERIFY green genesis coverage (read-only SQL on `ponder.action`) — **gates the reindex** | OPEN |

**Operator-gated (after the code):**
| # | Bead | What |
|---|------|------|
| 6 | `bd-r90` (S3) | Green reindex from genesis — rides `bd-umw.4` dry-run, ADR-010, **never from an agent session** |
| 7 | `bd-rr0` (S4) | inventory-api repoint (query-mapping code may land; the **deploy** flip waits for the reindex) |
| 8 | `bd-4kf` (S5) | Cutover → green, verify Stash, **keep blue until verified**, retire blue/green-v1/v2 |

**Urgent + independent:** `bd-54c` 🔐 — rotate `SONAR_SIGNING_SEED_HEX` NOW (exposed in a transcript; signs attestations across the whole build window). Not blocked by anything.

**Optional:** `bd-ok3` — candies **COUNT** stopgap from live `TrackedHolder1155` (your wallet's candies total shows today; the per-edition *cards* still need #2/#6).

### B. Compose substrate — make the high-stakes build vehicle reliable
| Bead | What | Status |
|------|------|--------|
| `bd-l9h0` | `review_routing` schema gap | ✅ FIXED this session |
| `bd-ii1m` | `code-implement-and-review` points at **dead agents** (codex-rescue/codex-review); emitter has no built-in-agent passthrough; `construct-fagan` not registered | OPEN — **the durable fix** |

**Why it matters:** tonight's autonomous build misrouted partly because of this drift. Until `bd-ii1m` lands (emitter passthrough + yaml migration + register `construct-fagan`), the compose runtime can't be trusted to run the per-token build autonomously.

### C. The loose end — `e146eee0` decision
The verified candies self-transfer fix sits on `feat/candies-holder-balance` (the #68 branch). **Keep** (recommended — it hardens #68 before it ships; real supply-inflation bug) or **revert** (if you want that branch scoped strictly to its PR).

## Run via — supervised, NOT the autonomous compose (the hard lesson from tonight)

Tonight's `general-purpose`-implementer-via-compose **misrouted** on `bd-jyn`: wrong task, wrong branch, and the loop "converged" anyway. The **FAGAN cross-model review works** (it caught a real bug) — it's the autonomous **implement** stage that's unreliable for complex multi-file ponder work. So the loop for the 4 code beads is:

- **Implement supervised, one bead at a time** — a focused session (or a tightly-constrained agent with the branch pre-created + single-file scope so it can't wander), NOT a fire-and-forget autonomous compose.
- **Review each diff via FAGAN** — `.claude/constructs/packs/fagan/scripts/cheval-council.sh <diff>` or `/fagan` (the cross-model council — it's the part that already works). Data-validity surface → single-model review is forbidden.
- **OR** fix `bd-ii1m` first, then the autonomous `code-implement-and-review` compose becomes trustworthy for the remaining beads.

## Review Cadence (HIGH STAKES — data-validity)

Per-token ownership renders what users own + drives the distributor. Every entity/handler diff → the **cheval multimodal council** (codex + claude + gemini headless). Conservation invariant asserted per collection post-reindex. Single-model review forbidden.

## Verify (end-state)

`Token(where:{collection,owner,isBurned:false}){tokenId}` on green returns the operator wallet's Mibera #7702 + Tarot + Fractures + MST; candies cards render from `candiesHolderBalance`; row count ≈ blue's ~130k; conservation holds; blue retired.

## Open operator decisions

1. **`e146eee0`** — keep (rec.) or revert.
2. **`bd-54c`** — rotate the signing seed now (independent, urgent).
3. **`bd-gpc`** — genesis-boundary result may force a true-genesis (not boundary-forward) reindex.
4. **Vehicle** — fix `bd-ii1m` first (then autonomous compose), or build the 4 code beads supervised now?

## Key References

| Topic | Where |
|-------|-------|
| Per-token detailed spec | `grimoires/loa/specs/enhance-per-token-ownership-port.md` |
| Belt topology + the gap | memory `project_sovereign-metadata-migration` |
| Reindex/cutover procedure | ADR-010 + `grimoires/loa/runbooks/candies-holder-balance-reindex.md` + `bd-umw.4` |
| Compose substrate drift | loa-constructs `bd-ii1m` |
| Green gateway (live) | `belt-gateway-production.up.railway.app/v1/graphql` |
