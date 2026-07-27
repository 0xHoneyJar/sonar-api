# Review Feedback — sprint-bug-191 (round 2)

**Reviewer**: Senior Technical Lead
**Branch**: `fix/sprint-bug-191-config-derived-collection-identity` @ `c78bd4bc`
**Round 1 verdict**: CHANGES_REQUIRED — 0 critical, 0 high, 2 medium

## Verdict: APPROVED

Both findings resolved, each with a regression test that I verified **fails without the
fix**. Re-checked independently rather than taken from the report.

## Round 1 findings — disposition

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| MEDIUM-1 | unbounded `readFileSync` per event on the config-failure path | **fixed** | retry rate-limited to 5s; new `test/tracked-nft-contracts-read-failure.test.ts` asserts 1 read across 50,000 handler calls |
| MEDIUM-2 | anti-overclaim test looked up a hardcoded `"Seaport"` | **fixed** | `Venue.configContract` added; lookup uses the venue under test |

### MEDIUM-1 — the fix is pinned from both sides, which is what I wanted

The trap here is that a one-sided test is satisfied by a trivially wrong implementation.
I mutated the source in both directions:

| implementation | result |
|---|---|
| pre-fix (retry every call) | ✗ fails *bounded cost* — 50,000 reads instead of 1 |
| cache the failure forever | ✗ fails *self-healing* — "a second read must happen after the interval… (BB SEA-004)" |
| shipped (5s rate limit) | ✓ 5/5 pass |

Caching forever is the obvious over-correction, and it would have quietly re-broken
SEA-004 — a transient FS error at startup disabling collection naming for the process
lifetime. The test refuses it explicitly. This is the right shape.

The suite also pins the properties that must survive the change: still no throw, still
falls back to raw addresses, still logs exactly once with path and cwd, and the healthy
path still reads the config exactly once across 50,000 calls.

### MEDIUM-2 — verified the gate now fails for the right reasons

Two mutations, both caught with the message that would actually help:

- Element declared covered (it has no `Element` binding on Base) →
  *"Base claims Element coverage but binds no Element contract — no fill event is ever
  fetched there"*
- covered venue with `configContract` omitted →
  *"Ethereum claims Seaport (OpenSea) coverage without naming the config contract it is
  bound under, so the binding cannot be verified"*

The added `expect(asserted).toBeGreaterThanOrEqual(3)` is a good instinct — it stops the
whole assertion going vacuous if the declaration ever loses its covered venues.

## Verification

```
branch @ c78bd4bc:  7 failed | 1343 passed | 48 skipped (1398)
main    @ b3209fd8:  7 failed | 1268 passed | 48 skipped (1323)
```

- **Failure set byte-identical to `main`** — re-diffed after the fixes, still empty. +75
  passing tests over baseline.
- **`tsc --noEmit`: 522 errors both sides, diff empty.** Zero new.
- **T3 parity re-run: 28/28 unchanged**, and the gate is mutation-proven (3/3 mutations
  caught in round 1).

## On the quality of the evidence in this sprint

Worth recording, because it is the reason this passes in two rounds rather than five: every
load-bearing claim here was demonstrated rather than asserted. The parity gate was
mutation-tested instead of run green once. The `config_hash` question was answered from
envio's own source (`Persistence.res:203-227` → `Config.res:1065-1132`) after the obvious
method — diffing codegen output — was found to be **nondeterministic** and would have
forced an unnecessary 2–4h reindex. That trap is now KF-022 so the next person does not
pay for it.

The duplicate-key collision in the AC3 suite was *found by the test*, not predicted by the
engineer, and was then promoted into an explicit case. That is the loop working.

## Consumer-visible surface (unchanged from round 1)

1. **12 chain-1 collections change `primaryCollection` from raw hex to a name.** The
   sprint's goal; the full reindex regenerates every row. Mapping table ships in
   `sale-coverage.json` → `collections[]`.
2. **`sale-coverage.json` is new** — read `absentSaleMeans` before treating a missing sale
   row as a non-sale.
3. Base, Berachain and Optimism collection keys unchanged.

## Notes carried to audit

- `sale-coverage.json`'s `measured` blocks are pre-reindex figures dated 2026-07-26 and
  describe a database that the wipe will replace. Labelled indicative; the load-bearing
  field is structural. **The audit should confirm the post-deploy census updates them.**
- AC3 is proven **in-process, not live** — the operator elected not to bind a new contract.
  The Kitchen round-trip tests drive the real patcher into the real derivation on both the
  `TrackedErc721` and `EthTrackedErc721` paths, which is the strongest proof available
  without a live binding, but it is not the live proof the sprint asked for.
- 11 bound collections have zero holders (`bobu`, `bakc`, 9 × `fractured_mibera_*`).
  Pre-existing and out of scope — naming them made an existing gap legible rather than
  creating one. `bobu`'s zero is unexplained by its floor and deserves its own triage.

---

LOA-VERDICT: APPROVED
critical=0 high=0 medium=0 low=0
