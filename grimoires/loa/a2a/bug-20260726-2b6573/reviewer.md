# Implementation Report — sprint-bug-191

**Bug ID**: 20260726-2b6573
**Branch**: `fix/sprint-bug-191-config-derived-collection-identity`
**Sprint**: `grimoires/loa/a2a/bug-20260726-2b6573/sprint.md`
**Predecessor**: sprint-bug-190 (`grimoires/loa/a2a/bug-20260725-224d57/`)
**Evidence**: `grimoires/loa/context/2026-07-25-marketplace-sale-detection.md`
**Baseline**: `main` @ `b3209fd8`

## Status

| Task | State |
|------|-------|
| T1 — config comments carry the real key | done (+ hash gate verified) |
| T2 — derive identity from config; delete the map | done |
| T3 — parity test over all 28 keys | done — **28/28 unchanged** |
| T4 — coverage as data | done (`sale-coverage.json`, generated + sync-gated) |
| T5 — onboarding proof | **test-only, by operator decision** (see §Decisions) |
| T5 — deploy | pending gates |

## Test results

```
branch:  6 failed | 112 passed | 7 skipped (125 files)   7 failed | 1338 passed | 48 skipped
main:    6 failed | 110 passed | 7 skipped (123 files)   7 failed | 1268 passed | 48 skipped
```

**The failure set is byte-identical to `main`** — `diff` of the sorted `FAIL` lines from both
runs is empty. All 7 are pre-existing (`config.mibera.yaml` parity ×3+2, solana live probe,
envio smoke harness, metadata egress boundary). **+70 passing tests, zero regressions.**

**Type check**: `tsc --noEmit` yields **522 errors on `main` and 522 on this branch**, diffed
error-by-error after normalising line/column — **zero new, zero fixed**. The baseline is the
pre-existing missing-codegen cascade, out of scope.

## Changes

| File | Change |
|------|--------|
| `config.yaml` | comment-only. 12 chain-1 + 9 Berachain collections given keys; 10 fracture comments reordered so the key leads; convention block added above `- name: TrackedErc721`; Mibera glossary relocated here |
| `src/handlers/marketplaces/tracked-nft-contracts.ts` | `parse` → `parseDocument` walker; adds `deriveCollectionKeys`, `collectionKeyFromComment`, `collectionKeyFor`; one cached parse feeds both maps |
| `src/handlers/tracked-erc721.ts` | `TRACKED_ERC721_COLLECTION_KEYS[addr]` → `collectionKeyFor(chainId, addr)` |
| `src/handlers/tracked-erc721/constants.ts` | **deleted** — the map was its only export |
| `src/kitchen/config-patcher.ts` | `sanitizeKitchenLabel` collapses spaces to `_` |
| `src/sale-coverage.ts` | **new** — capability declaration + document builder |
| `scripts/gen-sale-coverage.ts` | **new** — writes/checks `sale-coverage.json` |
| `sale-coverage.json` | **new** — the generated artifact (603 lines) |
| `scripts/ramp-readiness.ts` | key source swapped; `EthTrackedErc721` added to the address map |
| `test/collection-key-parity.test.ts` | **new** — 59 tests (AC1/AC2/AC3 + duplicate + hazards) |
| `test/sale-coverage.test.ts` | **new** — 11 tests (AC4 + sync + anti-overclaim) |
| `test/azuki-chain1-tracked-erc721.test.ts`, `test/base-tracked-erc721-batch1.test.ts` | re-pointed at the derived map |

## The gate that mattered — T3 parity

**All 28 pre-change keys derive from `config.yaml` unchanged.** No `primaryCollection` value
changes, so no historical row orphans and no stop-and-report was triggered.

The test pins the 28 as a **verbatim frozen copy** of the deleted map rather than importing
it — the point is comparison against a historical artifact, so it must not move when the
source moves.

Derived map is now **51 collections** (28 → 51): 15 on chain 1 (was 1 named), 7 OP, 8 Base,
21 Berachain. Post-deploy the observable count on chain 1 goes **1 → 13** — the two extra
bound addresses (`bobu`, `bakc`) emit no transfers today and so produce no rows.

## T1's verify-first, answered

Comment-only edits **cannot** trip Envio 3.2.1's resume-time compatibility check. Two
independent lines of evidence:

1. **Structural** — parsing `config.yaml` before and after with the failsafe schema and
   `JSON.stringify`-ing both yields identical strings (24,488 chars each).
2. **Mechanism** — the check is `Config.diffPaths(stored, current)` over
   `Config.getPublicConfigJson() |> stripSensitiveData`
   (`node_modules/envio/src/Persistence.res:203-227`, `Main.res:684`, `Config.res:1065-1132`).
   That is a **structured JSON projection of the parsed config**; comments do not exist in it.

**Do not use `envio codegen` output as a config-drift signal.** Two runs against a byte-identical
config produce different `.envio/types.d.ts` (contract ordering varies) — measured here, three
runs, three hashes. Logged as a new known-failure entry.

## Notable decisions

**The first whitespace-delimited token of the trailing comment is the key.** Prose goes after
it, in parentheses. Enforced by `/^[a-z0-9][a-z0-9_-]*$/`; anything else is treated as prose
and the collection falls back to its raw address.

**Kitchen's write and the indexer's read now agree by construction.** `sanitizeKitchenLabel`
previously preserved spaces, so a label of "Wealthy Hypio Babies" would have keyed the
collection `wealthy`. Spaces now collapse to `_`. Without this, AC3 is false for every
multi-word community — the write side and read side would disagree silently.

**Duplicate keys drop BOTH claimants rather than picking a winner.** Two collections merged
under one key is unrecoverable downstream and undetectable by a consumer; two collections
left as raw addresses is neither. Logged at `console.error`, gated by test. The AC3 suite
proves it on a real collision (a "Nodes by Hunter" onboarding vs the existing
`nodes_by_hunter`) — that case was found by the test, not predicted.

**Scoped to `TrackedErc721` / `EthTrackedErc721`.** These are the two names
`handleTrackedErc721Transfer` registers for — routing facts, not a collection list. Adding a
collection under either needs no code edit. Without the scope, Seaport's four bindings per
chain would all derive `seaport` and poison the namespace.

**`src/handlers/tracked-erc721/constants.ts` deleted rather than emptied.** The map was its
only export. The Mibera naming glossary moved into `config.yaml` beside the addresses it
describes; the two "why this list is gone" tombstones live where readers are (the handler and
the config convention block).

**Coverage ships as a generated artifact, not a service endpoint.** Kitchen's image copies
only `src/kitchen`, `src/collection-resolver` and `migrations/kitchen` — serving coverage from
it would drag `config.yaml` and the whole `src/handlers` tree into a service kept deliberately
small. `sale-coverage.json` is committed, schema-versioned, and `test/sale-coverage.test.ts`
fails if it drifts from `config.yaml`.

**Capability and measurement are separated in the artifact.** `absentSaleMeans` is structural
and load-bearing; the `measured` blocks carry an explicit date and are labelled indicative.
A test forbids claiming `no_sale` on any chain that declares an uncovered venue.

## Honest coverage call — Base is `unknown`, not `no_sale`

The sprint says "Base, Berachain — covered; absence means no sale". The artifact declares Base
**`unknown`**, because Element (`0xa39a5f16…`, confirmed live on Base in the evidence doc §2)
is not decoded. Berachain is the only EVM chain declared `no_sale`. Overriding the sprint here
is deliberate: T4 exists so absence reads as *unknown* rather than *did not sell*, and
declaring Base complete while a confirmed venue is undecoded would be the exact error T4 is
meant to prevent. Base's measured 93.4% is carried alongside so the gap is sized, not hidden.

## Operator decision taken mid-sprint

T5's live binding was put to the operator because whichever address is bound becomes a
permanently indexed collection visible to score-api — not derivable from the repo. Two
verified, actively-traded Base candidates were offered (Beezie Collectibles, 136 Seaport fills
across four sampled 400-block windows; World Cups, 62).

**Decision: bind nothing.** AC3 therefore rests on the Kitchen round-trip tests, which drive
the real `patchConfigForKitchenIngest` into the real `deriveCollectionKeys` on both chain-1
(`EthTrackedErc721`) and Base (`TrackedErc721`) paths. **AC3 is proven in-process, not live.**

## Consequence: the reindex is now deliberate, not forced

With no new address, `config.yaml` is comment-only, and per T1 that alone would **not** force a
re-migration. The reindex is still required for a different reason: the handler change renames
12 chain-1 collections, and a plain resume would leave those collections with raw-address rows
in history and named rows going forward. Mixed values are worse than either. `ENVIO_RESTART=1`
is a choice made to keep `primaryCollection` internally consistent.

## Found, not fixed (out of scope)

- **11 bound collections have zero holders**: `bobu`, `bakc`, and the 9 `fractured_mibera_*`
  CR-OPS-IDX W1 seeds. Pre-existing; naming them merely made an existing gap legible.
  `bakc` is already `blocked=True, floor=None` in `floor-registry.w1.json`; `bobu`'s floor
  (14329363) is above the chain floor and should be covered, so its zero is unexplained.
- **`ramp-readiness.ts` omitted `EthTrackedErc721`** from its address map, so every chain-1
  collection reported DRIFT. Invisible while only `azuki` was named; fixed here because this
  change would have turned one false DRIFT into fifteen.
- **`config.mibera.yaml` parity failures** (5 of the 7 pre-existing) left alone, as in
  sprint-bug-190.

## Consumer-visible changes (score-api coordination)

1. **12 chain-1 collections change `primaryCollection` from a raw hex address to a name**
   (`0x306b1ea3…` → `beanz`, `0xbc4ca0ed…` → `bayc`, …). This is the sprint's goal, and the
   full reindex regenerates every row — but any score-api state keyed on the old hex strings
   must be remapped. Mapping table: `sale-coverage.json` → `collections[]`.
2. **`sale-coverage.json` is new** and is the answer to "is this collection's sale data
   complete?". Read `absentSaleMeans` before treating a missing sale row as a non-sale.
3. Base and Berachain collection keys are **unchanged**; Optimism unchanged.
