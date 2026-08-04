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
| `src/handlers/marketplaces/seaport.ts` | `OrderFulfilled(...)` | `MintActivity` |
| `src/handlers/marketplaces/blur.ts` | `OrdersMatched(...)` | `MintActivity` |
| `src/handlers/marketplaces/blur-v2.ts` | `Execution721Packed(...)` | `MintActivity` |

The marketplace lanes write **only** `MintActivity` — they never call
`recordAction`. The belt does not assert that a Transfer *was* a sale: the token
lane records the movement, the marketplace lane records the settlement, and the
two are joined downstream on `(chainId, txHash, contract, tokenId)`. Absence of a
sale row means UNKNOWN, not "not a sale" — inferring the flag from the transfer
alone scored ~29% precision on 409 sampled transfers.

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
the event** — not a delta — plus `direction` (`in`/`out`) in `context`. That
holds for `hold721`, `hold1155`, and `hold20` alike.

This is what lets score-api reconstruct daily holder counts and any as-of holders
list from `Action` alone, so the belt stores no snapshots and no history. The
indexer does the accounting; the consumer does the time travel. Changing
`numeric1` to a delta on any lane silently breaks every historical curve
downstream.

`Action.id` is part of that contract, not an opaque key. There is no `logIndex`
column; score-api parses it out of the id, which must stay
`<txHash>_<logIndex>[_<suffix>...]`. Same-block events tie on `timestamp`, so
losing the log index costs intra-block ordering — measured, that put azuki's
summed supply at 12,636 against a true 10,000. `test/action-id-format.test.ts`
runs the consumer's own parser over every id all three lanes emit, because the
schema guard sees types and not values and so cannot catch a format change.

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

**Envio Cloud, connected through the GitHub App.** The repo carries no
deployment files: no Dockerfile, no proxy config, no host-specific build step.
Envio reads `package.json`, `config.yaml`, `schema.graphql`, and `src/`, and
that is the whole interface.

The self-hosted Railway stack that preceded it — an indexer container, a Hasura
service, and a Caddy gateway, five files and ten services — was deleted rather
than kept running in parallel: there are no users to keep up, and `git revert`
restores it if Envio Cloud does not work out. [MIGRATION.md](MIGRATION.md) has
the cutover steps and what it cost to run.

What that removed, and is worth not rebuilding: the `ENVIO_RESTART` re-init
dance (a fresh init crashes envio's persisted-state upsert, so seeding a new
chain took a deploy-crash-redeploy sequence), and a `ca-certificates` line in a
Dockerfile whose removal silently took all six chains down with TLS failures.

One thing the gateway did that Envio Cloud does not: it owned the public URL, so
belt recovery was an upstream swap and consumers never changed. On Envio Cloud
the endpoint is the vendor's. Putting `sonar.0xhoneyjar.xyz` in front of it as a
CNAME is what keeps that control point.

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
