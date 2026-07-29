# Objective — Freeside MVP

**One sentence:** A community's contract goes into one registry, and its holders
come out as a list with roles.

Everything not on that path is out of scope. This file is the only thing that
defines "done". If work isn't traceable to the check below, it doesn't happen.

---

## ▶ RESUME HERE

**What's next is a command, not something you have to remember:**

```bash
br ready -l mvp --limit 0        # run from sonar-api/
```

It prints exactly the steps that are unblocked right now. **Beads owns step
state; this file owns the goal and the check.** There is no third source of
truth, and nothing here needs hand-updating to stay accurate.

To continue in a fresh session: `cd` into the repo for that step, then paste

> Read `grimoires/loa/OBJECTIVE.md`, run `br ready -l mvp`, and continue.

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
