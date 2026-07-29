# Parked

Findings that are real but not on the path to `grimoires/loa/OBJECTIVE.md`.

**One line each. No PRs, no beads, no sprints.** Read by zerker on request.

Format: `YYYY-MM-DD — what it is — where (file:line or table)`

---

2026-07-28 — `community_registry` holds 5 test fixtures in production: azuki_2, azuki_3, azuki_marathon_e2e, e2e_409_probe, kitchen_smoke — score-api DB
2026-07-28 — Top-level `contracts:` (41) and per-chain `chains[].contracts` (50) counts disagree — sonar config.yaml
2026-07-28 — `EventHandlers.ts` was deleted at PR #75 and silently broke `envio codegen`; unnoticed until 2026-06-29 restore. No test guards codegen on redeploy — sonar
2026-07-28 — 7 extra belt configs beyond config.yaml: mibera, bench.eth, probe, robinhood-sidecar, sf-vaults, test-eventfilter, test-rebate — sonar
2026-07-28 — `src/svm/` is a parallel indexer (24 files, 4,561 lines) with its own registry, unreachable from the main contracts path — sonar
2026-07-28 — 31 routes on `/communities` alone; MVP needs 4 — score-api src/serve/rest/communities.ts
2026-07-28 — `community_core_member` (5 cols, no score) vs `community_member_state` (the real data) — two tables, two truths — score-api DB
2026-07-28 — 265 SQL migrations against 66 live tables — score-api
2026-07-28 — 27 open PRs and 901 branches across the three repos, unclear which are live — all
2026-07-28 — purupuru (51,752 holders), mad_lads (12,212), veecon (5,316), pythenians (3,238) all marked `paused` — score-api DB
2026-07-28 — `config.mibera.yaml` has drifted from `config.yaml` (TrackedErc721 chain 80094 missing 9 Fractured Mibera addrs; EthTrackedErc721 chain 1 missing 14) — 3 tests in `test/verify-belt-config.test.ts` + 2 in `test/azuki-chain1-tracked-erc721.test.ts` fail on main, pre-existing — sonar
2026-07-28 — `config.robinhood-sidecar.yaml` declares 4 addresses that appear in no other config (0x08dc7cb3…, 0x539cdd04…, 0x9ec6c5b9…, 0xa34d46ab…), so they are outside the registry — sonar
2026-07-28 — 23 ERC-721 collections previously indexed holders under their raw 0x address as collectionKey (hardcoded map had 28, config bound 51); registry now names them, so existing rows carry the old key until re-index — sonar src/registry/contracts.ts
2026-07-28 — sonar's warplets key was never the problem: it emits `collectionKey`/`category_key` = `warplets`, matching `community_tracked_contracts.category_key` exactly; the break was entirely score-side — verified against DB
2026-07-28 — `npx tsc --noEmit -p tsconfig.json` reports 553 errors on main, nearly all "run envio codegen" type absences — sonar
2026-07-28 — Kitchen onboarding patches `config.yaml` directly (`appendTrackedErc721ToChainBlock`), but config.yaml is now generated from the registry — Kitchen must write a registry entry instead; until then its patches fail `test/contract-registry.test.ts` loudly rather than drifting silently — sonar src/kitchen/config-patcher.ts:51
2026-07-28 — Optimism (chain 10) tracks 8 ERC-721s but has never had a Seaport binding, so OP sales are unattributed; pre-dates bd-dwq5.3 and is encoded as an exception in the registry test — sonar test/contract-registry.test.ts
2026-07-28 — FIXED as the registry `custodial` field (bd-dwq5.3 reopen): Mibera staking (paddlefi/jiko) passthrough is back, now a field not a branch — sonar src/registry/contracts.ts
2026-07-28 — `src/truth-contract/` (16,767 lines) pins a Mibera producer identity whose source files were deleted at bd-dwq5.3; 3 byte-digest pins dropped, the subsystem itself left standing and off-path — sonar test/truth-contract.producer-generation.test.ts
2026-07-28 — 3 test files still fail on main and are untouched by bd-dwq5.3: labels/reconcile-rpc, sense/live/solana, metadata-egress.browser-boundary — sonar
2026-07-28 — Custody passthrough credits the depositor until the token leaves the vault, so a liquidation or sale *out of* paddlefi (vault → new wallet) leaves credit with the original staker and gives the buyer none; matches pre-collapse behavior, needs a per-token custody record to fix — sonar src/handlers/tracked-erc721.ts
2026-07-28 — mibera's holder rows were last scored 2026-07-21, so the custody fix only takes effect on the next sonar re-index + rescore — score-api community_member_state
