# sonar-api architecture

An Envio HyperIndex belt. Two registries, six handlers, six chains.

## The path

```
src/registry/contracts.ts     →  config.yaml  →  handlers  →  Postgres  →  Hasura  →  Caddy  →  score-api
src/registry/marketplaces.ts     (generated,      (6 files)                        (belt-gateway)
     (the only                    never edited)
      declaration sites)
```

Adding a community is **one entry** in `src/registry/contracts.ts`, then
`pnpm gen:config`. Nothing else. `test/contract-registry.test.ts` asserts
`config.yaml` is byte-identical to what the registry generates, so a second
declaration site cannot reappear.

## Handlers

One lane per token standard, one per marketplace. The standard is a **field** on
the registry entry, so no lane needs a per-community case.

| handler | event | writes |
|---|---|---|
| `src/handlers/tracked-erc721.ts` | `Transfer(address,address,uint256)` | `TrackedHolder`, `Token`, `Action` |
| `src/handlers/tracked-erc1155.ts` | `TransferSingle`, `TransferBatch` | `TrackedHolder1155`, `Action` |
| `src/handlers/tracked-erc20.ts` | `Transfer(address,address,uint256)` | `TrackedTokenBalance`, `Action` |
| `src/handlers/marketplaces/seaport.ts` | `OrderFulfilled(...)` | `MintActivity`, `Action` |
| `src/handlers/marketplaces/blur.ts` | `OrdersMatched(...)` | `MintActivity`, `Action` |
| `src/handlers/marketplaces/blur-v2.ts` | `Execution721Packed(...)` | `MintActivity`, `Action` |

ERC-721 and ERC-20 share a topic0 and differ only in whether the third argument
is indexed, so a contract registered under the wrong `standard` decodes garbage
rather than failing loudly. `test/contract-registry.test.ts` asserts no address
is registered under two standards on one chain.

All six self-register on module load; `src/EventHandlers.ts` imports them for
that side effect only. `envio codegen` reads `config.yaml` + `schema.graphql`.
`scripts/check-onevent-bijection.mjs` asserts every config pair has a handler and
every handler has a config pair.

`src/lib/` holds what the lanes share: `actions.ts` (the `Action` row and event
identity), `mint-detection.ts` (zero-address and burn checks), `token-ownership.ts`
(the single `Token` write), `erc1155-holder.ts` (the per-tokenId balance write),
`sale.ts` (`recordSale()` — every marketplace decoder ends here).

## The ledger contract

Every `hold*` action carries `numeric1` as the wallet's **running balance after
the event** — not a delta — plus `direction` (`in`/`out`) in `context` and an
exact `logIndex`. That holds for `hold721`, `hold1155`, and `hold20` alike.

This is what lets score-api reconstruct daily holder counts and any as-of holders
list from `Action` alone, so the belt stores no snapshots and no history. The
indexer does the accounting; the consumer does the time travel. Changing
`numeric1` to a delta on any lane silently breaks every historical curve
downstream.

## Chains

Ethereum (1), Optimism (10), Base (8453), Arbitrum (42161), Zora (7777777),
Berachain (80094). All via HyperSync — there is no RPC configuration.

## Entities

Six, in `schema.graphql`:

| entity | written by | read by |
|---|---|---|
| `Action` | every handler | score-api (bronze event pull) |
| `MintActivity` | the three marketplace handlers | score-api (sale attribution) |
| `TrackedHolder` | erc721 | holder counts |
| `Token` | erc721 | per-token owner |
| `TrackedHolder1155` | erc1155 | per-(contract, chain, tokenId, wallet) balance |
| `TrackedTokenBalance` | erc20 | per-(wallet, token, chain) balance |

The two balance entities delete rows at zero rather than storing `0` — an absent
row and a zero row must not both mean "holds none".

`scripts/verify-belt-contract.mjs` introspects the live schema daily in CI and
fails on drift in what score-api depends on.

## Deployment

| service | built from | what it is |
|---|---|---|
| `belt-indexer-selfhost` | `Dockerfile.belt` | `pnpm envio start` |
| `belt-hasura-selfhost` | (Hasura image) | GraphQL over the indexed Postgres |
| `belt-gateway` | `Dockerfile.gateway` + `Caddyfile` | public URL, per-IP rate limit; reverse-proxies Hasura |

The gateway is a stable indirection: belt recovery swaps `BELT_UPSTREAM`, and
the public GraphQL URL never changes.

Migrating this to Envio Cloud is staged in [MIGRATION.md](MIGRATION.md) — planned,
not executed. Railway is still the live belt.

## Scope

EVM only: ERC-721, ERC-1155, and ERC-20 lanes all exist and are tested. The
registry currently declares 74 ERC-721 contracts and no ERC-1155 or ERC-20 ones,
so those two lanes are wired and idle — populating them is registry entries, not
code.

Solana is deliberately out; `PARKED.md` records why it was not ported onto
Envio's SVM support and what would have to change.

Snapshots and holder history are also out, by design — see "The ledger contract"
above. score-api derives them from `Action` (`src/gold/holder-ledger.ts`,
`community_holder_daily`).
