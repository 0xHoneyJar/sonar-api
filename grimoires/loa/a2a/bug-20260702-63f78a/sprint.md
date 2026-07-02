# Sprint Plan: Bug Fix — chain-1 Azuki TrackedErc721 never indexes holders

**Type**: bugfix
**Bug ID**: 20260702-63f78a
**Source**: /bug (triage)
**Sprint**: sprint-bug-172

---

## sprint-bug-172: chain-1 Azuki TrackedErc721 never indexes holders

### Sprint Goal
Fix the reported bug with a failing test proving the fix.

### Deliverables
- [ ] Failing test that reproduces the bug (config/subscription gap)
- [ ] Source code fix (config + CI gate + optional start_block)
- [ ] Operator verification: Azuki `TrackedHolder_aggregate` > 0 on production after redeploy
- [ ] Triage analysis document

### Technical Tasks

#### Task 1: Write Failing Test [G-5]
- Create integration test reproducing the gap (chain-1 Azuki in config but absent from belt contract gate / subscription validation)
- Verify test fails with current code
- Test file: `test/azuki-chain1-tracked-erc721.test.ts` (proposed)

**Acceptance Criteria**:
- Test fails with current code, proving the bug exists
- Test name clearly describes the bug scenario
- Test is isolated (no side effects on other tests)

#### Task 2: Implement Fix [G-1, G-2]
- Fix root cause in `config.yaml`, `scripts/verify-belt-config.js`, `test/verify-belt-config.test.ts`
- Redeploy belt with KF-013 if required
- Verify failing test passes; run full test suite

**Acceptance Criteria**:
- Failing test now passes
- No regressions in existing tests
- Production GraphQL shows Azuki holders > 0
- Fix addresses root cause (not just symptoms)

### Acceptance Criteria
- [ ] Bug is no longer reproducible on production GraphQL
- [ ] Failing test proves the fix
- [ ] No regressions in existing tests
- [ ] #111 unblocked (advance-ingredient after holder probe)

### Triage Reference
See: grimoires/loa/a2a/bug-20260702-63f78a/triage.md
