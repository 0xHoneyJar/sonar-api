# Types / Entities

> Ride 2026-07-19 · 95 GraphQL types in `schema.graphql`

## Core ownership / activity

| Type | Line | Notes |
|------|-----:|-------|
| Action | 1 | Overlay grammar (hold/mint/transfer/burn labels) |
| Transfer | 14 | Transfer events |
| Token | 350 | Ownership index (`id`, owner, collection…) |
| UserBalance | 361 | User balances |
| TrackedHolder | 291 | Generic ERC-721 holders |
| TrackedHolder1155 | 302 | ERC-1155 holders |
| TrackedTokenBalance | 985 | ERC-20 / tracked token balances |
| Holder | 280 | HoneyJar-family holders |
| CollectionStat / GlobalCollectionStat | 324 / 335 | Collection aggregates |

## Mibera / marketplace

| Type | Line |
|------|-----:|
| MiberaTrade / CandiesTrade / TradeStats | 597+ |
| MiberaStakedToken / MiberaStaker / MiberaLoan* | 820+ |
| MintActivity / MiberaTransfer / MiberaOrder | 896+ |
| Friendtech* / MirrorArticle* | 1134+ |
| ApdaoAuction* | 1212+ |

## Protocol / vault / burn

Vault*, Aquabera*, Henlo*, NftBurn*, Bgt*, Validator*, Paddle*, SF*, Premint*, Treasury*, Badge*, Candies*

## Canonical TS (off-schema)

| Symbol | Source |
|--------|--------|
| `NftActivity` / `NftActivitySchema` | `@0xhoneyjar/events` via `src/canonical/*` |
| Parity key / compare | `src/canonical/parity.ts` |
| `SchemaInvalid` errors | `src/canonical/errors.ts` |

## Naming note

HoneyJar-family often uses `collection`; generic tracked lane uses `collectionKey`. `[GROUNDED: consistency-report N-01]`
