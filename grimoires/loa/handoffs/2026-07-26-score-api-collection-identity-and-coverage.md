# Handoff → score-api: collection identity is now stable everywhere, and coverage is declared

**From**: sonar-api (freeside-sonar belt) · sprint-bug-191 · PR #254
**Date**: 2026-07-26
**Affects**: any score-api code that joins on `primaryCollection`, and the `conviction` score
**Predecessor**: sprint-bug-190 (PR #249) — `viaMarketplace` removal, `paymentToken`, nullable `amountPaid`

---

## 1. The identifier is now one shape on every chain

Before this change `primaryCollection` was a **name** for some collections and a **raw hex
address** for others. Measured on the live gateway 2026-07-26, chain 1 emitted transfers for
13 collections: `azuki`, plus 12 raw addresses.

That is fixed. Every indexed collection on every chain now reports a stable, non-address
identifier, derived from `config.yaml` rather than a hardcoded TypeScript map. **Adding a
collection is now a config edit; the identifier appears automatically.**

### What changes for you

**Base, Berachain and Optimism: nothing.** All 28 previously-named collections keep their
exact identifier — pinned by a parity test that fails the build if any value moves.

**Chain 1 (Ethereum): 12 identifiers change** from a hex address to a name. If you hold any
state keyed on the old hex strings, remap it:

| was (`primaryCollection`) | now |
|---|---|
| `0x306b1ea3ecdf94ab739f1910bbda052ed4a9f949` | `beanz` |
| `0xb6a37b5d14d502c3ab0ae6f3a0e058bc9517786e` | `azuki_elementals` |
| `0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d` | `bayc` |
| `0x60e4d786628fea6478f785a6d7e704777c86a7c6` | `mayc` |
| `0xbd3531da5cf5857e7cfaa92426877b022e612cf8` | `pudgy_penguins` |
| `0x524cab2ec69124574082676e6f654a18df49a048` | `lil_pudgys` |
| `0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab` | `redacted_remilio_babies` |
| `0x8a90cab2b38dba80c64b7734e58ee1db38b8992e` | `doodles` |
| `0x23581767a106ae21c074b2276d25e5c3e136a68b` | `moonbirds` |
| `0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03` | `nouns` |
| `0x79fcdef22feed20eddacbb2587640e45491b757f` | `mfers` |
| `0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9` | `kitchen_just_t00ns` |

`azuki` (`0xed5af388…`) was already named and is unchanged.

The belt is fully reindexed as part of this change, so **sonar's own rows are regenerated
under the new identifiers** — there are no stale hex rows on our side. The remap is only
needed for state score-api persists itself.

The authoritative machine-readable list is `sale-coverage.json` → `collections[]`, giving
`collectionKey`, `chainId` and `contract` for all 51 indexed collections.

### One naming caveat worth knowing

Collections onboarded automatically through Kitchen get a **digest-based** identifier —
`kitchen_eip155_1_<12 hex>` — because the label is generated from the deployment digest to
guarantee uniqueness. It is stable and collision-free but not human-readable. Collections
onboarded with an explicit label (like `kitchen_just_t00ns`) keep that label. If you want
readable keys for future communities, the label has to be supplied at onboarding time —
tell us and we will thread it through.

---

## 2. Coverage is now declared as data — read it before scoring

New artifact: **`sale-coverage.json`** at the repo root, regenerated from `config.yaml` and
kept in sync by a test.

It answers the question that matters to `conviction`: **when there is no sale row against a
transfer, is that a fact or a gap?**

```jsonc
"chains": [{ "chainId": 8453, "absentSaleMeans": "unknown", "coveredVenues": [...], "uncoveredVenues": [...] }]
```

`absentSaleMeans` is the load-bearing field:

| value | meaning |
|---|---|
| `no_sale` | every venue trading here is decoded — absence really is "they did not sell" |
| `unknown` | at least one venue is undecoded — absence proves **nothing** |
| `not_applicable` | no NFT collections indexed on this chain |

### Current state

| chain | verdict | why |
|---|---|---|
| **Berachain (80094)** | **`no_sale`** | Seaport only venue observed across 138 sampled txs. The one chain where absence is a fact. |
| **Base (8453)** | `unknown` | Seaport decoded (93.4% of transfers resolve). **Element is confirmed live and undecoded.** |
| **Ethereum (1)** | `unknown` | Seaport only — and Seaport is ~7% of observed Azuki sales. **Blur, Wyvern, X2Y2, LooksRare all uncovered.** |
| **Optimism (10)** | `unknown` | No marketplace bound at all. Its 7 collections structurally cannot have sale data. Zero is not evidence. |
| **Arbitrum / Zora** | `not_applicable` | no collections indexed |
| **Solana** | `unknown` | **uncovered except `pythians`** |

Solana is declared per collection because the exception is per collection:

| collection | sale rows |
|---|---|
| `pythians` | **5,369** (covered) |
| `mad_lads` | 0 of 225,035 events |
| `smb_gen2` | 0 of 137,538 events |
| `degods` | 0 of 126,550 events |
| `daa_higher_self` | 0 of 48,011 events |
| `y00ts` | 0 of 2,308 events |
| `claynosaurz`, `famous_fox`, `galactic_geckos` | not indexed at all |

Those five are ownership-only imports. **They have transfer history and zero sale history.
Reading that as "these holders never sold" is wrong.**

---

## 3. The request we need you to act on

⚠️ **Treat `absentSaleMeans: "unknown"` as unknown, not as a pass.**

`conviction` rewards *not* selling. This file states publicly which venues produce no sale
row. A holder who sells on Blur today keeps full conviction — and can now look up that this
works.

Our security audit recorded this as a MEDIUM with the reasoning that hiding the gap does not
close it (the gap is discoverable by selling once and watching the score), and that the
alternative — silently treating gaps as confirmed non-sales — is the defect this whole cycle
exists to fix. But the mitigation has to live on your side:

> A conviction score computed over a chain/venue we do not decode should be **withheld or
> confidence-weighted, not awarded.**

Concretely, on Ethereum, Optimism and Solana-except-`pythians`, a "never sold" conclusion is
currently unsupported by the data. Base and Berachain are safe to score on.

---

## 4. Carried forward from sprint-bug-190 (still true)

1. `amountPaid` is **nullable** — an unpriced sale gets a row rather than vanishing.
2. `paymentToken` exists and **floor/average math must group by it** — zero address means
   native; ~10% of Base and ~50% of Berachain sales settle in a wrapped token.
3. `viaMarketplace` is **gone**. It was ~29% precise / ~28% sensitive on Ethereum, and 122 of
   172 `true` values were Blur **Blend** loan collateral — borrowing against an NFT reported
   as selling it. Do not resurrect it from a cached schema.
4. The sale signal is `MintActivity{activityType: SALE}`, joined on
   `(chainId, txHash, contract, tokenId)`, carrying `operator`.
5. Prices are attacker-influenceable (wash trading is not detectable on-chain). Use **median
   or trimmed statistics with outlier rejection, never a mean.**

---

## 5. Deliberately not done

- **Blur / Wyvern / X2Y2 / Element / Blend decoders** — coverage, not architecture. Newer
  communities already work (just_t00ns 75.6%, the Base eight ~91.6% on Seaport alone); only
  azuki (4.6%) is materially short because its history predates Seaport. Blur alone would
  take Ethereum to ~28%, Blur + Wyvern to ~38%. Revisit when a legacy collection becomes
  load-bearing for a score.
- **Solana deep history** — ~3.87M Helius credits (33,275 mints × 100 credits/call),
  recurring per community. SQD Portal is the free path and needs Magic Eden / Tensor
  instruction decoding — its own sprint. **Not to be re-litigated without new pricing.**
- **Per-chain deployment split** (SCALE.md D4) — today any contract addition forces a full
  6-chain reindex. Registered as `cycle-d4-per-chain-split` in the sprint ledger; it is the
  real scalability fix for community onboarding and deserves its own cycle.
