# Sprint Plan: One gate in, one shape out — config-derived collection identity

**Type**: architecture / bugfix
**Bug ID**: 20260726-2b6573
**Sprint**: sprint-bug-191
**Predecessor**: sprint-bug-190 (`grimoires/loa/a2a/bug-20260725-224d57/`) — removed the transfer
and sale allowlists. This removes the last one.
**Evidence**: `grimoires/loa/context/2026-07-25-marketplace-sale-detection.md`

---

## Sprint goal

**Add an ERC-721 contract address to `config.yaml` and it flows through the same gates to
the same shape, with zero TypeScript edits — on any chain.**

score-api gets one consistent baseline: a stable collection identifier, a uniform sale
row, and machine-readable coverage telling it whether a missing sale means *no sale* or
*we don't cover that venue*.

Scoped to **architecture, not coverage**. Venue decoders are data completeness for legacy
collections and are explicitly deferred — see §Deferred.

## The one gap left

sprint-bug-190 removed two of the three hardcoded lists. The third is
`TRACKED_ERC721_COLLECTION_KEYS`, and it is what breaks the "same shape out" promise:

```
chain 1:      13 collections —  1 named ("azuki"), 12 RAW ADDRESSES
chain 8453:    8 collections —  8 named, 0 raw
chain 80094:   2 collections —  2 named, 0 raw
```

`just_t00ns` — a real onboarded community — reaches score-api as
`0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9`. The join key is a name for some collections
and a hex string for others. Kitchen patches `config.yaml` on onboarding but never touches
this map — the same defect class as the other two lists.

**The name is already in the config**, written by Kitchen's `sanitizeKitchenLabel`:

```yaml
- 0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9 # kitchen_just_t00ns (eip155:1; physical_job …)
- 0xcb28749c24af4797808364d71d71539bc01e76d4 # based_punks (deploy 12774442)
```

We already parse this file (`src/handlers/marketplaces/tracked-nft-contracts.ts`, built
last sprint). Extend that parser to read `address → label` and the map deletes itself.

**Feasibility measured 2026-07-26**: deriving the key from the comment's first token
reproduces **18 of 28** existing keys exactly. The 10 misses are all Mibera fractures,
whose comments read `# fracture #1` rather than `# miparcels`. That is a config-data
defect, not a parser limitation — T1 fixes the comments so the parser is universal.

## Tasks

### T1 — Make the config comments carry the real key
Fix the 10 fracture entries (`miparcels`, `miladies`, `mireveal_1_1` … `mireveal_8_8`) so
the comment's first token IS the collection key.

**AC**: all 28 currently-named collections derive their exact existing key from config
alone. No key changes value.

**Verify first**: comment-only edits should NOT flip Envio's `config_hash` — it is computed
from re-serialized YAML, which drops comments. **Confirm before relying on it.** If comments
do affect the hash, this folds into the T5 reindex rather than being a free change.

### T2 — Derive collection identity from config; delete the map
Extend the existing config parser to return `address → collectionKey`. Delete
`TRACKED_ERC721_COLLECTION_KEYS`. Keep the raw-address fallback for an address with no
comment — an unnamed collection is still indexed, just unnamed.

**AC**: `src/handlers/tracked-erc721.ts` no longer imports a hardcoded key map.

### T3 — Parity test (the migration's safety net)
Assert the derived map equals the pre-change hardcoded map, entry for entry.

**AC**: a snapshot test over all 28 entries. **`primaryCollection` must not change value
for any existing collection** — score-api joins on this exact string; a silent rename would
orphan every historical row.

### T4 — Coverage as data
Publish, in a form a consumer can read, per chain and per venue: what is covered, what is
not, and therefore whether an absent sale row is a fact or a gap.

Minimum content:
- Base, Berachain — covered; absence means no sale
- Ethereum — **Seaport only**. Modern collections index well (just_t00ns 75.6%); legacy
  ones do not (azuki 4.6%). Blur / Wyvern / X2Y2 declared uncovered.
- Solana — **uncovered except `pythians`** (5 of 6 collections have zero sale rows)

**AC**: score-api can answer "is this collection's sale data complete?" from data, not from
tribal knowledge or a findings doc.

### T5 — Onboarding proof + deploy
Add one new ERC-721 to `config.yaml` and confirm it produces a named collection, transfers,
and sale rows **with no TypeScript change**. Then one reindex.

**AC**: the onboarding path is proven end-to-end, not assumed. Post-deploy: chain-1 named
collections go from 1 to 13; Base and Berachain unchanged.

## Acceptance criteria

| # | bar |
|---|---|
| AC1 | Every collection on every chain reports a stable non-address `primaryCollection` |
| AC2 | No existing `primaryCollection` value changes — proven by the T3 parity test |
| AC3 | Adding a contract requires **zero** TypeScript edits — proven by T5, not asserted |
| AC4 | Coverage is machine-readable; Solana and the ETH venues declared uncovered |
| AC5 | Base ≥ 91% and Berachain unchanged — no regression from last sprint |

## Testing

The two gates that caught every real defect in sprint-bug-190 both stay:

1. **Real-log replay** (`test/base-seaport-real-fills.test.ts`) — decoder vs chain truth
2. **Config-binding assertion** (`test/sale-attribution-bindings.test.ts`) — a decoder with
   no binding silently yields zero rows while every handler test passes

T3's parity test joins them as the third gate: **a refactor that changes a downstream join
key is a data migration, not a refactor.**

## Deferred — deliberately

- **Blur / Wyvern / X2Y2 / Element / Blend decoders.** Coverage, not architecture. Evidence
  they are not MVP-blocking: just_t00ns 75.6% and the Base eight ~91.6% on Seaport alone —
  *newer communities already work*. Only azuki (4.6%) is materially short, because its
  history predates Seaport. Blur alone → ~28%; Blur + Wyvern → ~38%. Revisit when a legacy
  collection is load-bearing.
- **Solana deep history** — ~3.87M Helius credits (33,275 mints × 100 credits/call),
  recurring per community, against a repo doctrine already recording metered Solana history
  as "quota-outs + ~100x cost misses" (KF-018). SQD Portal is the free path and needs Magic
  Eden / Tensor instruction decoding — its own sprint. Helius stays correct for the live
  webhook. **Do not re-litigate without new pricing.**
- **Per-chain deployment split (SCALE.md D4)** — the real scalability fix: today any
  contract addition forces a full 6-chain reindex. Its own cycle; SCALE.md already says it
  "deserves its own kickoff cycle."

## Risks

| risk | mitigation |
|---|---|
| A derived key silently differs → orphans historical rows | T3 parity test is the gate; the sprint fails if any value changes |
| Comment edits flip `config_hash` and force a reindex | verified in T1 before relying on it; falls back into the T5 reindex |
| Two collections derive the same key | parser must reject duplicates loudly rather than pick one |

## Deploy sequence (corrected — step 2 is missing from KF-013)

1. `ENVIO_RESTART=1` → deploy → wipes and seeds
2. **Redeploy Hasura and wait for real cutover** — a wipe leaves its metadata pointing at
   dropped tables, and a naive health probe passes against the still-serving old container.
   Require consecutive successful probes after a delay.
3. `ENVIO_RESTART=0` → deploy → resumes and backfills
