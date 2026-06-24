---
session: 10
date: 2026-06-07
type: kickoff
status: planned
cycle: sonar-belt-factory
stakes: data-validity (HIGH)
---

# Session 10 — What's Left to Build (kickoff)

## Scope
- Consolidated, honest inventory of all remaining build work after the per-token kickoff (session 9) + tonight's events (autonomous build misroute, e146eee0, schema fix).
- THE remaining build = the per-token ownership port (4 code beads + 1 verify + 3 operator-gated). Makes the Stash render fresh per-token + candies cards.
- Substrate: bd-ii1m (compose runtime durable fix) so high-stakes builds run reliably.
- The vehicle lesson: implement supervised, NOT autonomous compose (it misrouted tonight); FAGAN review works.

## Artifacts
- What's-left map (this kickoff): `grimoires/loa/specs/enhance-whats-left.md`
- Per-token detailed spec: `grimoires/loa/specs/enhance-per-token-ownership-port.md`
- Beads: sonar-api bd-jyn/bd-1jg/bd-d2b/bd-3nh/bd-gpc/bd-r90/bd-rr0/bd-4kf/bd-ok3/bd-54c · loa-constructs bd-ii1m (bd-l9h0 CLOSED)

## Prior session
Session 9 hardened the per-token port (kickoff + 4-agent HARDEN + 3-model flatline, 12 blockers folded, 11 beads). Tonight: fixed the review_routing schema gap (bd-l9h0), fired the compose build — which MISROUTED (bd-jyn not built; instead the FAGAN council found + fixed a real candies self-transfer supply-inflation bug, e146eee0, verified green, on the #68 branch).

## Decisions made
- bd-jyn remains OPEN (autonomous build did not do it).
- e146eee0 is a verified, sound fix — keep/revert is an operator call.
- The autonomous general-purpose-compose path is unreliable for complex ponder work → build supervised, review via FAGAN/cheval-council.
- bd-l9h0 closed (schema fixed + verified); bd-ii1m is the remaining compose-substrate fix.

## Open operator decisions
1. e146eee0 keep (rec.) or revert.
2. bd-54c rotate signing seed now (independent, urgent).
3. bd-gpc genesis-boundary result may force a true-genesis reindex.
4. Vehicle: fix bd-ii1m first (then autonomous compose) or build the 4 code beads supervised now?
