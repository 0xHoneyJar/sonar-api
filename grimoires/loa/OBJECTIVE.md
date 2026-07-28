# Objective — Freeside MVP

**One sentence:** A community's contract goes into one registry, and its holders
come out as a list with roles.

Everything not on that path is out of scope. This file is the only thing that
defines "done". If work isn't traceable to the check below, it doesn't happen.

---

## ▶ RESUME HERE

**Current step: 1 of 7 — unified contracts registry (sonar-api)**

To continue in a fresh session, paste exactly this:

> Read `grimoires/loa/OBJECTIVE.md` and continue from the current step.

**Last session — 2026-07-28:** guardrails armed. MVP MODE added to all three
CLAUDE.md files, `PARKED.md` created in all three, all four Loa generators
(continuous_learning, compound_learning, gpt_review, run_bridge) switched off.
No application code changed yet.

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

Each step is one `/goal` in one session. **Update this list and the RESUME block
the moment a step completes** — a session that ends without updating them has
lost the thread, which is the exact failure this file exists to stop.

- [ ] **1. One registry** — sonar. A single contracts file where `chain` and
      `standard` are fields. Modeled on `ecosystem-squid`'s `CONTRACTS` map.
- [ ] **2. Fix warplets** — sonar. 0 holders → correct list. Proves the add path
      actually works.
- [ ] **3. Collapse the wiring** — sonar. 8 configs → 1. Delete the ~20 off-path
      handlers; keep ERC-721 + Seaport.
- [ ] **4. Serve the right table** — score. `/communities/:id/members` reads
      `community_member_state`, not `community_core_member`.
- [ ] **5. Trim the surface** — score. 31 `/communities` routes → the 4 the MVP
      needs.
- [ ] **6. Clean the registry** — db. Drop the 5 test fixtures; un-pause veecon.
- [ ] **7. Run the check** — all 4 conditions green → ship card → the door.

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
