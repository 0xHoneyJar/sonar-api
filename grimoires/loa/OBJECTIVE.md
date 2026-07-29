# Objective — Freeside MVP

**One sentence:** A community's contract goes into one registry, and its holders
come out as a list with roles.

Everything not on that path is out of scope. This file is the only thing that
defines "done". If work isn't traceable to the check below, it doesn't happen.

---

## ✅ SHIPPED — 2026-07-28

**All 7 steps closed. All 4 check conditions green. zerker's verdict: SHIP.**
Logged at `score-api/grimoires/loa/DECISIONS.md`.

| condition | result |
|---|---|
| warplets returns a holders list | **21,098 holders / 49,134 tokens** (was 0) |
| adding a contract = one registry entry | 8 configs → **1** (generated), 32 handlers → **6**, 85 entries |
| `/members` serves the `community_member_state` spine | live: `?include_facts=true` → holdings, first_seen, tenure_days, roles |
| all 9 in-scope communities return a list | **44,715 holders / 112,874 tokens**, none empty |

Tests 1,234 pass / 1 fail (pre-existing). `/communities` 36 routes → 4, live.

### ▶ CLOSE-OUT — 2026-07-29 end of day. START HERE TOMORROW.

**Everything is committed and pushed.** sonar `1945c1a9`, score-api `d33c3bc1`.
Nothing held back, nothing uncommitted, no branch waiting.

**State:** 9 of 9 in-scope communities non-empty, **44,735 holders**. score-api
typecheck 0 / 2,104 tests pass. sonar 570 tests pass, 31 typecheck errors (all
pre-existing `envio has no exported member` codegen gaps — never introduced by
this work, and down from 553).

**The belt is mid-backfill** after this morning's `envio start -r`. At close:
`health=catchup, stalls=0`, four chains at tip, Ethereum ~18m out, Base ~1.6h.
Check with `pnpm belt:progress`. A `FULL_STALL` on a single sample is usually
HyperSync mid-commit, not a fault — sample over a longer interval before
believing it.

**~85,000 lines removed today**, `config.yaml` byte-identical throughout — the
registry stayed authoritative the whole way. sonar `src/truth-contract` (20,075)
and score-api story-v3 (18,074 → 559) are both gone.

**THE ONLY THING THAT NEEDS ZERKER:** set `ALARM_DISCORD_WEBHOOK_URL` in the
Trigger.dev prod env. Detection works and always did; the pager has never had a
destination, which is why warplets sat dead for weeks. Today's fix makes an
undelivered alarm land as `error` on the checker's own row — so a dead pager is
now *visible*, but still not *working* until that variable exists.

**Optional, not urgent, no order between them:** `src/svm/` (935 lines + 2 live
Railway services — a decommissioning decision, not a cleanup); score-api's
~4,900 remaining off-lane lines; the `self` / `sense` / `canonical` operator
tools. All recorded in the PARKED.md files. Read them; don't mine them.

### Post-ship session — 2026-07-29

Re-ran the check live against production: **all four conditions still hold** —
44,715 holders across the 9, 0 empty, `/v1/communities/:id/members` serving
facts + roles.

**Kept: the alarm-delivery fix (follow-on 5).** Detection already existed and
was firing (`silent_drop`, warplets, hourly). The hole was the sink: the
checker persisted `delivered: deliverable.length` — the count that passed the
cooldown filter, not the count the pager took. Production showed
`raised: 1, delivered: 1` beside an EMPTY `alarms` map, which is only reachable
when every `postDiscordAlarm` returned false. Delivery is now counted honestly
and an undelivered alarm lands as `error` on the checker's own row — the one
fault that cannot page itself. This is what let warplets stay dark for weeks.

**Reverted: a chain-order fix for mibera.** Diagnosis was right — mibera has
been frozen since 2026-07-21 because sonar's `Action` carries no `blockNumber`/
`transactionIndex`, and story-v3's exact-capture gate rejects the 46 rows that
arrived after (measured: 46 `source_event_identity_missing` + 46
`transaction_ordering_incomplete`). The history that DOES have block numbers
came from a one-off RPC backfill (`scripts/ops/backfill-tx-identity.ts`, run
2026-07-19, deleted 2026-07-23), not from the indexer — which has never emitted
them for any community (3.8M of 3.9M rows lack them).

**But story-v3 is not in the MVP**, and the check does not fail without it:
mibera returns 2,726 holders, so condition 4 passes. The fix touched the sonar
schema (forcing a re-index), the bronze upsert, and the wire contract — real
work for a path the MVP does not use. Reverted whole rather than carried as
scope. mibera stays stale until story-v3 is actually in scope; that is the
trade, and it is deliberate.

**Superseded 2026-07-29 (score-api):** story-v3 was disabled for mibera
(`community_story_configs.enabled=false` — the only row), the v3 lane branch was
cut from `trigger/jobs/community-goal-scoring.ts`, and the 4 files that fell
unreachable (6,439 lines: `story-run-orchestrator`, `story-snapshot-store`,
`story-truth-gates`, `story-snapshot-publisher`) plus 5 story-only test files
were deleted. **mibera is unfrozen** — 2,746 holders, `generated_at`
2026-07-29, via the legacy lane; the other 8 in-scope communities are
unchanged; `community_story_events` (55,624 rows) preserved.

**Needs zerker:** (a) `ALARM_DISCORD_WEBHOOK_URL` in the Trigger.dev prod env —
alarms have been going nowhere; (b) `COMMUNITY_SCORING_MACHINE_PRESET=medium-1x`
(unchanged from below — warplets logged 77 never-run ticks, latest 02:00Z).

### Post-ship session — 2026-07-29 (truth-contract removed)

`src/truth-contract/` is gone — 45 files, the largest off-lane subsystem here and
the original scope drift this cycle exists to undo. Removed together so nothing is
left half-wired: the subsystem, its 19 vitest files + `truth-promotion-gate.test.mjs`,
`tsconfig.truth-contract.json`, the 14 `/truth/` package.json scripts, 3
`scripts/verify-truth-*` files, `scripts/staged-reconciler-harness.ts` (truth-only,
name doesn't match `/truth/`), and `.github/workflows/truth-contract.yml` (all four
of its jobs were truth verifiers). A reachability rescan from the real entry points —
side-effect imports included, so the MVP handlers are not miscounted as dead — found
exactly one cascade: `src/collection-resolver/trust-protocol.ts`, whose only non-truth
consumer was the harness. Removed. **33,921 lines deleted.**

Checks: tsc 31 errors before → **31 after, byte-identical breakdown**; suite
**570 passed / 48 skipped / 0 failed** (was 734/48/0 — the delta is the 164 truth
tests); `envio codegen` exit 0; `config.yaml` md5 `f5e72b32…` **unchanged**; all 9
communities hold their exact baselines (warplets 21,098 … nodes_by_hunter 657).

**Committed, deliberately NOT pushed** — main auto-deploys and the belt is
mid-backfill (Base and Ethereum still catching up). Pushing restarts hours of
indexing for a change that touches no runtime path.

### Follow-ons carried out of the cycle

1. **Redeploy the indexer** — the collapse is committed but not running in
   production. Nothing sonar-side is live until it is.
2. **Watch mibera's next index** — the `custodial` fix is unit-tested but has not
   run against real data. mibera last indexed 2026-07-21.
3. **Kitchen onboarding** writes `config.yaml` directly, which is now generated.
   It must write a registry entry instead. Fails loudly; manual onboarding works.
4. **`src/svm/`** — 24 files, still standing. Deleting it is an open decision.
5. **The OOM blind spot** — an OOM-killed scoring child never records a tick
   outcome, so nothing pages. It hid warplets for weeks. First thing worth fixing.

MVP MODE stays on until the next objective is set or it is cleared. The parked
lists in all three repos are the backlog — read them, don't mine them.

**Last session — 2026-07-28 (step 3, collapse the wiring — closed):** `config.yaml`
is now **generated** from `src/registry/contracts.ts` (`pnpm gen:config`), 994 → 174
lines, and `test/contract-registry.test.ts` asserts byte-identity — so the 41-vs-50
double-declaration cannot come back. 7 extra belt configs gone, ~30 handlers gone,
two left: `TrackedErc721.Transfer` and `Seaport.OrderFulfilled`. Registry trimmed to
erc721 + seaport (133 → 83 entries). All 9 in-scope communities hold their exact
baseline holder counts; `envio codegen --config config.yaml` exits 0; failing tests
7 → 1 (the rest pre-existing). Commit `3fa230e3`.

**Step 3 reopened and re-closed — 2026-07-28 (custody):** the collapse had dropped
the Mibera staking passthrough, which would have made the paddlefi vault the #1
mibera holder at 455 (real top wallet: 395) and stripped credit from 462 stakers on
the next re-index. Restored as a **field**, not a branch: `custodial: true` on the
registry entry, the two vaults registered under `mibera_collection`, and the ERC-721
handler skips holder adjustment when either counterparty is custodial. Custodial
entries are excluded from `TRACKED_CONTRACTS`, so `config.yaml` is byte-identical
(83 contracts, unchanged). `test/tracked-erc721-custody.test.ts` (4 tests) fails 3/4
without the fix; suite 1234 passed, only the 3 known pre-existing files fail;
`envio codegen` exits 0; all 9 communities hold their exact baselines.

**⚠ Carried into step 7:** Kitchen still patches `config.yaml` directly
(`src/kitchen/config-patcher.ts`) — it has to write a registry entry instead, or its
next onboarding fails the byte-identity test. **`src/svm/` was NOT deleted** — see
the report; that is zerker's call, not a silent one.

**Step 2 (prior session, warplets):** warplets now returns **21,098
holders holding 49,134 tokens** in `community_member_state` (was 0 rows). The
cause was **not** a key mismatch — sonar emits `collectionKey = "warplets"` and
`community_tracked_contracts.category_key = 'warplets'`, they agree, and 2.45M
events had been landing correctly all along. The break was score-side: the
warplets scoring child needs **1.76 GB peak RSS / 66s**, and the Trigger.dev
child task runs on `small-2x` (1 GB), so it was OOM-killed every tick. An OOM
kill is not a catchable throw, so `recordTickOutcome` never ran and the tick
ledger stayed `expected` — 62 of them, 0 `ran`, the only community in that
state. Fixed for now by a forced re-score through the real job path
(`scripts/debug/rescore-community.ts warplets`).

**⚠ Open ops action (needs zerker — no deploy credentials here):** set
`COMMUNITY_SCORING_MACHINE_PRESET=medium-1x` (2 GB) in the Trigger.dev prod env
and run `pnpm trigger:deploy` from score-api. The preset is read at deploy time.
Until that lands, warplets is a frozen snapshot: every scheduled tick will OOM
again and it will not pick up new events.

**Step 1 (prior session):** guardrails armed. MVP MODE in all three CLAUDE.md
files, `PARKED.md` in all three, all four Loa generators (continuous_learning,
compound_learning, gpt_review, run_bridge) switched off, and the 7 steps created
as `bd-dwq5.1`–`.7` under epic `bd-dwq5`.

---

## The check

Done means all four hold, proven by command output:

1. `warplets` (`0x699727f9e01a822efdcf7333073f0461e5914b4e`, Base 8453, erc721)
   returns a non-empty holders list with correct balances.
2. Adding a contract means **one entry in one registry file** — no handler code,
   no second declaration site, no per-community special case.
3. `GET /communities/:id/members` serves `community_member_state`
   (wallet, balance, held_since, role) — the table with real data.
4. All 9 in-scope communities return a list. No community returns 0 rows.

---

## Scope

**In**
- ERC-721, EVM: azuki, veecon_2024_tickets, kemonokaki, based_onchain_punks,
  mibera, based_punks, lil_bangers, nodes_by_hunter (23,618 holders)
- warplets — currently broken, 0 holders. The proof case.
- Marketplace sales (Seaport) — feeds `sold_recently` + sale facts

**Out, by decision — not deleted, sequenced**
- ERC-1155 → purupuru (51,752 holders). Returns as *one decoder* on the same
  registry, not a re-architecture.
- Solana → mad_lads (12,212), pythenians (3,238). Same: one decoder, later.
- Vaults, staking, BGT, badges, mints, friendtech, paddlefi, the 6 Mibera-
  specific handlers. Long-term vision, not MVP.
- CSV export. Backend serves the data; the download button is a frontend
  follow-up.
- Discord / Telegram role push. v2, right after MVP.

---

## The one path

Modeled on `0xHoneyJar/ecosystem-squid` (83 files, 51 commits, worked fine):

```
ONE registry entry  →  ONE indexing loop  →  holders  →  ONE endpoint  →  list
```

Registry entry shape — `chain` and `token_standard` are **fields**, so the flow
never differs by chain or standard:

```ts
{ community: "warplets",
  address:   "0x6997…",
  chain:     8453,
  standard:  "erc721",
  startBlock: 12345678 }
```

Adding a community is that. Nothing else.

---

## What this replaces

| | today | target |
|---|---|---|
| Config files | 8 | 1 |
| Ways to wire a community | 5 | 1 |
| Contract declaration sites | 2 (41 vs 50 — they disagree) | 1 |
| Handler files | 32 (10,076 lines) | ERC-721 + Seaport |
| Registries | 3 (config.yaml, svm/collection-registry, truth-contract) | 1 |

---

## The plan — 7 steps

Tracked in beads under epic **`bd-dwq5`**, label `mvp`. Each step is one `/goal`
in one session. Close each with `br close bd-dwq5.N` when it lands — that is the
only bookkeeping, and `br ready` derives everything else from it.

| id | step | repo |
|---|---|---|
| `bd-dwq5.1` | **One registry** — one contracts file; `chain` and `standard` are fields. Modeled on `ecosystem-squid`'s `CONTRACTS` map. | sonar |
| `bd-dwq5.2` | **Fix warplets** — 0 holders → correct list. Proves the add path works. | sonar |
| `bd-dwq5.3` | **Collapse the wiring** — 8 configs → 1; delete the ~20 off-path handlers. | sonar |
| `bd-dwq5.4` | **Serve the right table** — `/members` reads `community_member_state`. | score |
| `bd-dwq5.5` | **Trim the surface** — 31 `/communities` routes → 4. | score |
| `bd-dwq5.6` | **Clean the registry** — drop 5 test fixtures; un-pause veecon. | db |
| `bd-dwq5.7` | **Run the check** → ship card → the door. | all |

Dependencies are wired — 1→2→3, 4→5, and 7 blocked by 3, 5 and 6 — so
`br ready -l mvp` can only ever show work that is genuinely startable.

### The one beads rule

**While MVP mode is on, nothing new enters beads.** These 7 are the entire set.
Everything else discovered goes to `PARKED.md`.

Beads is a **burndown from 7 to 0**, not an inbox. That distinction is the whole
fix: the previous attempt routed every adjacent problem into a beads task, so
scope did not widen — it multiplied. There are 215 open issues across the three
repos as evidence. Beads was never the problem; the rule pointing a firehose at
it was.

**Step 1's goal, to paste after `/goal`:**

> sonar-api has one contracts registry file where every tracked contract is a
> single entry with address, chain, standard, and startBlock fields, and the
> indexing path reads only from it. Prove it by showing the file and a test that
> asserts every config.yaml contract resolves from the registry. Do not fix
> warplets yet, do not delete handlers yet — those are steps 2 and 3. Findings
> off this path go to PARKED.md. Stop after 15 turns and report.

---

## Rules while this is open

- Findings not on the path go to `PARKED.md`, one line. Never a PR, bead, or
  sprint without zerker asking.
- No new endpoint, table, or entity unless the check above needs it.
- Cleanup is deletion — git history is the archive.

---

_Set: 2026-07-28. Cleared when the check passes._
