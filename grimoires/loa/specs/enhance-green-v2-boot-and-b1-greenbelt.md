# Session 7 — Sovereign finish: green-v2 boot → B-1 green belt → app repoint

> Session 6 cut Mibera over to ponder (live). The RLAI sweep then found + fixed 4 *silent* Mibera-gap handlers (PR #49, committed, NOT deployed). This session boots green-v2 to free Ruggy/Score/cubquests **live**, ports the remaining green belt (RLAI-gated), repoints the apps off the dead hosted Envio onto the sovereign belt, and retires blue.

> **Mode**: ARCH (OSTROM) + the RLAI methodology (rlaihf RLAIF — probe→grade→ledger). No craft lens (handlers + data + ops).
> **Date**: 2026-05-29 · **Authority**: operator (zksoju) · **Status**: ready-to-build

## Context (what's true at handoff)
- **Mibera is live on ponder** via belt-gateway → belt-hasura-green → `ponder.*` (vRR1). Field-parity fixed (223 `column_config` camelCase aliases). Blue hot as failback.
- **RLAI sweep (this session)** graded the 8 Sprint-M "accept-frozen-only" entities against the LIVE territory: **4 real silent gaps** (`mint_event`/GeneralMints→Ruggy NATS · `bgt_boost_event`/BgtToken · `badge_holder`+amt+bal/CubBadges1155→cubquests · `candies_backing`+inv+order/CandiesMarket1155→Score), 4 refuted. Root pattern: **registered-but-unsubscribed** (contract in `ponder.config`, no `ponder.on` → events silently discarded).
- **All 4 gap handlers PORTED + FAGAN-approved + committed** (f95e1028 + d2a45381, PR #49) + henlo + mirror green-belt ported. **NOT deployed** — build_id forces a fresh-green-boot. So Ruggy/Score/cubquests are **coded-freed, not live-freed.** The boot is the activation.
- RLAI ledger substrate at `evals/sonar-migration/` (12 graded rows) = the reusable parity gate.

## Run via — `code-implement-and-review` + the RLAI parity gate (REQUIRED)
- **green-belt group ports**: `@~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml` — CODEX-RESCUE ports envio→ponder handler → FAGAN parity review, per group; operator directs at each group boundary.
- **EVERY port's parity claim is RLAI-graded** before trust: `construct-scar` territory probe → `construct-protocol` adversarial grade (refute-first) → a row in `evals/sonar-migration/handler-gap-ledger.jsonl` (`cohort: b1-group-<X>`). *The map is not the territory* — grade against the live system, never the spec/diff.
- **The boot is mechanical**: the proven Sprint-M transform + `green-v2-boot-spec.md`.

## Load Order
1. `@~/bonfire/construct-compositions/compositions/delivery/code-implement-and-review.yaml` — the port loop
2. `grimoires/loa/specs/green-v2-boot-spec.md` — **the boot runbook (DO FIRST — frees Ruggy/Score/cubquests live)**
3. `grimoires/loa/specs/enhance-b1-and-global-flip.md` — the green-belt B-1 build doc
4. `grimoires/loa/migration/b-1-handler-gap.md` + `b-1-green-belt-map.yaml` — green-belt work-list + entity→column map
5. `evals/sonar-migration/{README.md, handler-gap-ledger.jsonl, handler-gap-row.ts, handler-gap-read.mjs}` — the RLAI parity gate
6. coordinator `~/bonfire/sonar-ponder-coordinator/grimoires/loa/migration-A-data-migration-spec.md` — App. B/C/D + the RLAI UPDATE note (Appendix-C corrected)

## What to Build (in order)
### 1. green-v2 fresh-green-boot — FREE RUGGY/SCORE/CUBQUESTS (immediate, highest value)
Follow `green-v2-boot-spec.md` exactly. `[operator]` deploy belt-indexer-green-v2 (env=belt-indexer-green + `DATABASE_SCHEMA=ponder_v2` + `BELT_CONFIG=ponder.config.ts`, branch code) → `[agent]` frozen-import below-boundary into `ponder_v2` + monitor cold-sync backfill to head → `[agent]` validate (count/checksum parity · gaps advance past boundary · **live-mint test for Ruggy** · Score/cubquests resume; each → RLAI ledger row `cohort: green-v2-boot`) → `[operator+agent, SACRED]` re-track belt-hasura-green `ponder`→`ponder_v2` + **re-apply the 223 column_config + henlo/mirror aliases**; gateway already→belt-hasura-green; green-v1 + blue HOT; auto-rollback; **restart Ruggy's bot once** (`initialPrevHashPolicy:any`).

### 2. green-belt B-1 — the 6 remaining groups
Per `b-1-plan.md` order: **G-apdao → C-moneycomb → E-henlo-vault → A-validator → F-set-and-forgetti → B-honeyjar-genesis** (+ NEW chains **Arbitrum 42161 + Zora 7777777** — re-ground their boundaries from live envio `chain_metadata`, never reuse a Mibera boundary). Each: `code-implement-and-review` port (schema + handler + ABI + register in `ponder.config.ts`) → an RLAI ledger row. **henlo needs the Berachain `TrackedErc20` registration** (handler is dormant without it — HENLO is a Berachain token). All land on a coordinated boot (fold into green-v2 if not yet repointed, or a later boot).

### 3. App repoint — the sovereign finish line
The apps' source defaults to the **DEAD hosted Envio** (`indexer.hyperindex.xyz/914708e`, frozen Feb-2025 / bera block 1.1M). Repoint each live consumer's **runtime** `ENVIO_GRAPHQL_URL` off 914708e onto the belt-gateway (Score confirmed on belt via migration-A §8; **verify** cubquests + the green-belt apps' runtime endpoints — Trigger.dev/Railway/Vercel). Per [[sovereign-belt-latent-until-apps-repointed]]. **THEN retire blue.**

## Design Rules / Invariants
- **The map is not the territory** — every migration claim graded against the live system (the RLAI gate); `registered-but-unsubscribed` = the silent-gap signature; verify contract-active via an INDEPENDENT RPC witness (never ponder's own sync store) AND a live-consumer (trace the PascalCase root field to a real call site).
- **build_id discipline** — schema/handler changes → fresh-green-boot (no hot-add); deployed config == boot config exactly.
- **`ponder.config.mibera.ts` is the LIVE green's config — NEVER edit it.** Green-belt contracts register in `ponder.config.ts`.
- **Field-parity** — re-apply `column_config` (the camelCase contract) whenever re-tracking Hasura on a new schema, or consumers regress to snake_case.
- New chains (Arb/Zora): re-ground boundaries from live envio `chain_metadata`.

## What NOT to Build
- NO re-announcing the *missed* shadow/gif mints (historical → `isLiveEvent` gate; manual emit is risky). Only future mints announce.
- NO editing `ponder.config.mibera.ts` (the live green).
- NO trusting the spec/diff over the territory — grade every port via the RLAI ledger.

## Verify
- **Boot**: green-v2 `is_ready=1`; the 4 gap tables advance past the boundary; a live shadow/gif mint → `pending_emits` → NATS → #stonehenge; Score/cubquests reads resume; AC-2..6 + `nats-reconciliation-24h.sh` clean.
- **Green-belt**: per-group count + checksum parity vs blue + an RLAI ledger row (`real`/verified).

## Key References
| Topic | Path |
|---|---|
| The boot runbook (do first) | `grimoires/loa/specs/green-v2-boot-spec.md` |
| green-belt B-1 build doc | `grimoires/loa/specs/enhance-b1-and-global-flip.md` |
| green-belt work-list + map | `grimoires/loa/migration/b-1-handler-gap.md` · `b-1-green-belt-map.yaml` |
| RLAI parity gate | `evals/sonar-migration/` |
| Proven Sprint-M pattern | coordinator `migration-A-data-migration-spec.md` App. B/C/D |
| PR (4 gap handlers + henlo + mirror) | https://github.com/0xHoneyJar/sonar-api/pull/49 |
| Ruggy issue | https://github.com/0xHoneyJar/sonar-api/issues/50 |
