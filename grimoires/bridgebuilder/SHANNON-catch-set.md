# SHANNON — Canonical Catch-Set

> A persona is prose until it's tested. This is the empirical spine of
> [[SHANNON]]: the **real silent-signal-loss defects** produced during the EVM
> Collection Onboarding cycle (2026-07-07/08), each framed as a channel and asked
> the one question — *would it have failed loud or silent, and does SHANNON's
> frame catch it?* If a future SHANNON review (or the BB persona) misses a defect
> of one of these shapes, the persona has regressed and should be sharpened here.
>
> This doc is signal-preservation applied reflexively to the review practice: we
> extracted the *meaning* of each bug (its failure shape), and we refuse to lose
> that signal to a closed PR nobody re-reads.

## The five real catches (all were silent; all reached "green")

| # | Defect (as shipped/proposed) | Channel & silent-loss point | SHANNON dimension | The scream that was missing |
|---|------------------------------|------------------------------|-------------------|------------------------------|
| **C1** | `seaport.ts` `TRACKED_COLLECTIONS` keyed the **corrupted** Azuki address `…dcc93746104133`; real Azuki is `…dc7c4b3241c544` | source (OrderFulfilled) → handler lookup: the wrong key matches **nothing** → 0 priced Azuki sales | **Faithful Labelling** / **Signal Fidelity** | No test asserted the key == the *real* contract; self-consistent with a config that was *also* corrupted. Caught only by diffing against main's canonical address. |
| **C2** | `tracked-erc721.ts` `updateTokenOwnership` lacked the staking-aware `effectiveOwner` logic `mibera-collection.ts` had | transfer → Token.owner: a staking deposit would set owner=staking-contract while holder count held → Token↔Holder **divergence** | **Meaning Integrity** (EVANS I-3) | The invariant was maintained by two hand-duplicated paths; nothing owned it. Held only by the accident that staking is Mibera-only. |
| **C3** | `MintActivity.id` omits `chainId` — on the entity FR-6 makes carry cross-chain sale value | two chains' sales → one id-space: identity **collision** waiting on address-reuse | **Identity & Provenance** (EVANS I-1) | Mitigation rode on Seaport-address-disjointness, not a correct natural key. Base Seaport was deferred for exactly this; mainnet re-triggered it. |
| **C4** | WETH compared checksummed vs stored `.toLowerCase()` (R-12) | consideration item → `amountPaid` sum: a checksummed constant matches nothing → `amountPaid=0` → dropped at the `>0n` guard | **Signal Fidelity** (the *silent zero*) | Would have summed to zero and dropped the sale with no error. Here a negative-control test (checksummed fixture asserts `amountPaid>0`) was added — the scream exists. |
| **C5** | `@index`-only for #153 assumed `Token` was populated; the **population wiring** was stranded on `cycle/sonar-belt-factory` | (absence of a) transfer → Token write: no handler wrote Mibera Token rows → `getNftsForOwner` returns `[]` | **Signal Fidelity** (the *silent skip* — a channel that was never wired) | Prod showed `tokenCount:66` but `tokenIds:[]`. The aggregate screamed correct while the enumeration was empty. Caught by reading #153's body, not the code. |

## What the catch-set teaches SHANNON (sharpenings)

- **C1 + C5**: *self-consistency is not correctness.* Two wrong things that agree (a
  corrupted key + a corrupted config; a missing writer + a passing aggregate) look
  green. SHANNON must trace to an **external ground truth** (the real contract on
  Etherscan; the issue body's prod evidence), never trust internal agreement.
- **C2 + C3**: *an invariant/identity with no single owner drifts.* When the same
  fact is written by ≥2 paths, or an identity omits part of its natural key, the
  failure is latent — it fires only when a new caller/chain arrives. SHANNON asks
  "who owns this invariant?" and "is this id the full natural key?" on every diff.
- **C4**: *the silent zero is the signature failure of a lossy channel.* Case
  mismatch, unit mismatch, unmatched join → 0 → dropped. SHANNON demands a
  **negative control** for any value that a lookup/sum could silently zero.
- **All five failed SILENT and passed GREEN.** Review + audit + a cross-model
  dissenter all APPROVED the code carrying C1/C2/C3 — because they read the diff
  for internal correctness, not for signal-loss against ground truth. That is
  precisely the gap SHANNON exists to close, and the reason it leads with *"where
  is the scream?"* rather than *"is the code correct?"*

## Use

Run this as a rubric when SHANNON (or BB-with-SHANNON) reviews a data-pipeline PR:
for each of the 5 shapes, ask "could a defect of THIS shape hide in this diff, and
would it be loud?" A `no test / no external-ground-truth check / no single owner`
answer on a high-value datum is the finding. Append new shapes here as they're
caught — the set compounds; losing a caught shape to memory is itself signal loss.

*Related: [[SHANNON]] · EVANS data-shape review (`grimoires/loa/a2a/evans-data-shape-review.md`) · the Loa NEVER-DROP discipline.*
