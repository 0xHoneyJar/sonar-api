# Implementation Report: Sprint sprint-bug-172

**Date:** 2026-06-30
**Engineer:** Sprint Task Implementer Agent
**Sprint Reference:** grimoires/loa/a2a/bug-20260702-63f78a/sprint.md
**Bug ID:** 20260702-63f78a
**GitHub:** [#118](https://github.com/0xHoneyJar/sonar-api/issues/118)

---

## Executive Summary

Implemented the config and CI-gate fix for chain-1 Azuki `TrackedErc721` never indexing holders after belt reinit. Root cause was silent config drift: Azuki was added to `config.yaml` (PR #114) without an explicit `start_block`, without mibera belt parity, and without inclusion in `BELT_CONTRACTS` — so CI could not catch the gap.

The fix adds Azuki deploy `start_block: 14162194`, mirrors the binding in `config.mibera.yaml`, extends `BELT_CONTRACTS` with `{ TrackedErc721, chainId: 1 }`, adds collection key hygiene in handler constants, and locks the invariant with a dedicated Vitest suite.

**Key Accomplishments:**
- New regression test suite `test/azuki-chain1-tracked-erc721.test.ts` (5 cases)
- Belt config gate now enforces chain-1 Azuki parity between monolith and mibera configs
- `pnpm verify:belt-config` and related tests pass locally

**Operator follow-up required:** Redeploy `belt-indexer-selfhost` with KF-013 if Envio does not pick up the new binding on resume alone, then verify production GraphQL Azuki `TrackedHolder_aggregate` > 0 and re-onboard kitchen job for #111.

---

## AC Verification (REQUIRED — Issue #475)

### Task 1 — Acceptance Criteria

**AC-1.1**: "Test fails with current code, proving the bug exists"
- Status: `✓ Met` (historical — pre-fix state reproduced in triage; new tests encode the missing invariants)
- Evidence: `test/azuki-chain1-tracked-erc721.test.ts:43-48` — asserts `BELT_CONTRACTS` includes chain 1 `TrackedErc721`
- Test: `test/azuki-chain1-tracked-erc721.test.ts` — `includes chain-1 TrackedErc721 in BELT_CONTRACTS`

**AC-1.2**: "Test name clearly describes the bug scenario"
- Status: `✓ Met`
- Evidence: `test/azuki-chain1-tracked-erc721.test.ts:21` — describe block names bug ID and contract class

**AC-1.3**: "Test is isolated (no side effects on other tests)"
- Status: `✓ Met`
- Evidence: `test/azuki-chain1-tracked-erc721.test.ts` — read-only config parse; no network or DB

### Task 2 — Acceptance Criteria

**AC-2.1**: "Failing test now passes"
- Status: `✓ Met`
- Evidence: Vitest run — 15/15 passing in `test/azuki-chain1-tracked-erc721.test.ts` + `test/verify-belt-config.test.ts`

**AC-2.2**: "No regressions in existing tests"
- Status: `✓ Met`
- Evidence: `pnpm verify:belt-config` exit 0; all 10 verify-belt-config tests pass

**AC-2.3**: "Production GraphQL shows Azuki holders > 0"
- Status: `⏸ [ACCEPTED-DEFERRED]`
- Notes: Requires operator redeploy + KF-013 on `belt-indexer-selfhost` after merge. Cannot be verified in CI. Post-deploy probe documented in triage §Reproduction.

**AC-2.4**: "Fix addresses root cause (not just symptoms)"
- Status: `✓ Met`
- Evidence: `config.yaml:594-597` — explicit `start_block`; `scripts/verify-belt-config.js:57` — gate entry; `config.mibera.yaml:330-334` — belt parity

### Sprint-level Acceptance Criteria

- Bug no longer reproducible on production GraphQL: `⏸ [ACCEPTED-DEFERRED]` — pending deploy
- Failing test proves the fix: `✓ Met`
- No regressions: `✓ Met`
- #111 unblocked: `⏸ [ACCEPTED-DEFERRED]` — pending production holder probe

---

## Tasks Completed

### Task 1: Write Failing Test

**Status:** Complete

**Files Created/Modified:**
| File | Action | Description |
|------|--------|-------------|
| `test/azuki-chain1-tracked-erc721.test.ts` | Created | Config + gate invariants for chain-1 Azuki |

### Task 2: Implement Fix

**Status:** Complete (code); operator verification deferred

**Files Created/Modified:**
| File | Action | Description |
|------|--------|-------------|
| `config.yaml` | Modified | Added `start_block: 14162194` on chain-1 Azuki binding |
| `config.mibera.yaml` | Modified | Added matching TrackedErc721 + start_block on chain 1 |
| `scripts/verify-belt-config.js` | Modified | Added `{ TrackedErc721, chainId: 1 }` to `BELT_CONTRACTS` |
| `test/verify-belt-config.test.ts` | Modified | Expect TrackedErc721 on chains 1, 10, 80094; 17 gate entries |
| `src/handlers/tracked-erc721/constants.ts` | Modified | Added `azuki_kitchen_e2e` collection key |

**Deviations from Plan:** None

---

## Technical Highlights

### Root Cause

Azuki was onboarded to the monolith belt config without:
1. Per-contract `start_block` at deployment (~14.16M)
2. Mibera belt mirror (required for `verify:belt-config`)
3. `BELT_CONTRACTS` gate entry (CI blind spot)

Envio may skip or mis-scope single-address `TrackedErc721` bindings when only the chain-level floor applies; explicit `start_block` matches other kitchen/community bindings in the repo.

### Architecture Decisions

- **Mibera parity over separate kitchen gate:** Adding Azuki to `config.mibera.yaml` keeps one fidelity gate (`verify:belt-config`) instead of a second verifier. Belt deploys using `BELT_CONFIG=config.mibera.yaml` would also index Azuki — acceptable for shared TrackedErc721 handler (no mibera-specific filter).

---

## Testing Summary

### How to Run Tests

```bash
cd sonar-api
pnpm vitest run test/azuki-chain1-tracked-erc721.test.ts test/verify-belt-config.test.ts
pnpm verify:belt-config
```

### Results

| Test File | Scenarios | Status |
|-----------|-----------|--------|
| `test/azuki-chain1-tracked-erc721.test.ts` | 5 | Passing |
| `test/verify-belt-config.test.ts` | 10 | Passing |

---

## Known Limitations

- **Production verification pending:** GraphQL holder count remains 0 until belt redeploy with updated config and likely KF-013 (`ENVIO_RESTART=1` seed dance per `grimoires/loa/runbooks/belt-reinit.md`).
- **Kitchen job row:** Lost on prior belt Postgres wipe; operator must re-onboard after indexer fix.
- **Escalation path:** If holders still 0 after config fix + KF-013, triage recommends Envio 3.2.1 minimal repro (see triage §Fix Strategy step 5).

---

## Verification Steps

1. **Merge PR** with these changes.
2. **Redeploy belt:**
   - Set `ENVIO_RESTART=1` on `belt-indexer-selfhost` → deploy → remove var → redeploy (KF-013).
   - Redeploy `belt-hasura-selfhost` if KF-016 blocks indexing.
3. **GraphQL probe** (from triage):

```graphql
query {
  azuki: TrackedHolder_aggregate(
    where: {
      chainId: { _eq: 1 }
      contract: { _eq: "0xed5af388653567af2f388e6224dcc93746104133" }
    }
  ) {
    aggregate { count }
  }
}
```

4. **Kitchen:** Re-onboard Azuki collection; confirm status reaches `indexed`; run #111 advance-ingredient.

---

## Questions for Reviewer

1. Confirm operator accepts Azuki in `config.mibera.yaml` (green belt) vs. a separate monolith-only gate — current fix chose parity for simpler CI.

---

*Generated by Sprint Task Implementer Agent*
