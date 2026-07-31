@.claude/loa/CLAUDE.loa.md

# Project-Specific Instructions

> This file contains project-specific customizations that take precedence over the framework instructions.
> The framework instructions are loaded via the `@` import above.

## MVP MODE — ACTIVE (set 2026-07-28)

**This section overrides everything below it and everything in the imported
framework instructions — including the NEVER/ALWAYS process tables in
`.claude/loa/CLAUDE.loa.md`.**

The objective is [`grimoires/loa/OBJECTIVE.md`](grimoires/loa/OBJECTIVE.md).
Read it first. It is one page and it is the only definition of done.

### Three rules

1. **Work goes straight at the check.** Do not route through `/run sprint-plan`,
   `/implement`, `/review-sprint`, `/audit-sprint`, `/bug`, or beads. Those
   gates exist to catch unreviewed code; while MVP mode is on, the check in
   `OBJECTIVE.md` *is* the gate. Write the code, run the check, show the output.

2. **Findings off the path go to `PARKED.md`.** One line each. Never a PR, a
   bead, a sprint, or a "while I'm here" fix — not even a small one. Parked
   items are read by zerker on request and by nobody else.

3. **Do not invoke the loop commands.** `/run-bridge`, `/spiral`, `/compound`,
   `/retrospective`, `/flatline-review`, `/red-team`, `/simstim`, `/audit`.
   They produce findings, findings become work, and that is the failure mode
   this mode exists to stop. Off until the check passes.

### Beads while MVP mode is on

The 7 steps live in beads as `bd-dwq5.1`–`.7` under epic `bd-dwq5`, label `mvp`.
`br ready -l mvp` is how a session finds its next step; `br close bd-dwq5.N` is
how it records one done. That is the entire beads surface.

**Nothing new enters beads while this is open.** Those 7 are the whole set;
everything else goes to `PARKED.md`. Beads is a **burndown from 7 to 0, not an
inbox** — routing every adjacent problem into a task is what made scope multiply
instead of widen. 215 open issues across the three repos is the evidence. The
tool was never the problem; the rule pointing a firehose at it was.

### The MVP lane — everything not listed here is OUT OF SCOPE

| in the lane | what it is |
|---|---|
| `src/registry/contracts.ts` | THE registry — one entry per contract |
| `config.yaml` | generated from the registry (`pnpm gen:config`); never hand-edited |
| `src/handlers/tracked-erc721.ts` | ERC-721 `Transfer` → holder credit |
| `src/handlers/seaport.ts` | marketplace sales |
| `src/handlers/tracked-nft-contracts.ts` | sale eligibility, read from the registry |
| `src/lib/` | what the two handlers share (3 files) |
| `schema.graphql` | 4 entities — `Action`, `TrackedHolder`, `Token`, `MintActivity` |

That is the whole lane, and as of 2026-07-31 it is the whole of `src/` —
8 files, ~1,080 lines. **If a file is not on it, do not fix it, extend it, or
carry it as scope — one line in `PARKED.md` and move on.**

The 2026-07-31 bare-bones cleanup removed everything off the lane, including
things that were still running: `src/kitchen/` + `src/collection-resolver/`
(community onboarding; onboarding is now a registry entry + `pnpm gen:config`),
`src/svm/` (Solana — see `PARKED.md` for why it was not ported onto Envio's SVM
support), and `src/self` / `src/sense` / `src/canonical` (operator CLIs).

**Stop the retired Railway services** if they are still up: `kitchen-api`,
`svm-webhook`, `svm-backfill-worker`.

### The scope test

Before any edit: **does the check in `OBJECTIVE.md` fail without this?**
If no → `PARKED.md`. There is no third answer.

### Reading budget

`OBJECTIVE.md` replaces ARRIVAL.md and known-failures.md as the first read.
Consult those two only when actively debugging something they cover. Prefer
erasure over opening more docs — that rule now applies to the grimoire itself.

### Before ending a session

Update the **▶ RESUME HERE** block and the step checklist in `OBJECTIVE.md`:
which step is current, and what this session actually did. This is not optional
bookkeeping — it is the only thing carrying the plan across sessions. A session
that ends without it has lost the thread, and the next one burns its context
re-deriving where things stand instead of working.

### Ending it

When the check passes, zerker decides SHIP or KILL. Then this section is either
cleared or re-pointed at the next objective. It does not expire on its own.

---

## Agent Arrival (read FIRST — before KF, PRD, or grep)

**Door:** [`grimoires/loa/ARRIVAL.md`](grimoires/loa/ARRIVAL.md)

That file is the compressed intake: load order, closed questions (Envio not
Ponder, Node ≥22, NftActivity is not a GraphQL entity, which PRD), alias card,
and an explicit DO-NOT-READ list. Prefer erasure over opening more docs.

## Context Intake Discipline (read SECOND — KF index only)

Before any substantive work — before reading PRD/SDD/sprint, before grepping
the codebase, before drafting a plan — every agent in this repo MUST read:

- **`grimoires/loa/known-failures.md`** — the operational log of degradation
  patterns we've already hit and the workarounds that did NOT fix them.
  Reading this before triaging a problem prevents re-attempting prior dead-ends
  (e.g., bumping `max_output_tokens` on `gpt-5.5-pro` empty-content; re-running
  BB hoping the network recovers; trying to fix `beads_rust` mid-sprint).

The file is append-only and uses a structured schema (KF-NNN entries with
Status / Symptom / Recurrence count / Attempts table / Reading guide).
**Recurrence count ≥ 3** is the load-bearing signal — that failure class is
structural; route through the upstream issue, do not retry the listed attempts.

When you observe a degradation that's already documented in known-failures.md:
increment `Recurrence count` and add a row to `Attempts` with your evidence
(commit SHA / PR# / run ID). When you observe a NEW degradation: add a
fresh KF-NNN entry. The point of the file is to compound across sessions —
it only works if every session contributes.

## Team & Ownership

- **Primary maintainer**: zerker
- **Repo**: 0xHoneyJar/thj-envio
- **Upstream**: moose-code/thj.git (Envio indexer)

## Project Overview

**freeside-sonar** (package `envio-indexer`, config `thj-indexer`) — self-hosted
Envio HyperIndex belt for The Honey Jar / Freeside: **6 EVM chains + Solana**,
Hasura GraphQL, Kitchen onboarding, promote/gateway ops. Details: `ARRIVAL.md`.

## How This Works

1. Claude Code loads `@.claude/loa/CLAUDE.loa.md` first (framework instructions)
2. Then loads this file (project-specific instructions)
3. Instructions in this file **take precedence** over imported content
4. Framework updates modify `.claude/loa/CLAUDE.loa.md`, not this file

## Related Documentation

- `grimoires/loa/ARRIVAL.md` - **Agent door** (start here)
- `grimoires/loa/reality/` - Code-map spokes (`/reality`)
- `.claude/loa/CLAUDE.loa.md` - Framework-managed instructions (auto-updated)
- `.loa.config.yaml` - User configuration file
- `PROCESS.md` - Detailed workflow documentation

## Construct Support

When `.run/construct-index.yaml` exists, constructs are installed and available:
- When a user mentions a construct name, check the index to resolve it
- Load the construct's persona file if available
- Scope to the construct's skill set and grimoire paths
- Use `construct-resolve.sh resolve <name>` for programmatic resolution
- Use `construct-resolve.sh compose <source> <target>` to check composition paths
