# freeside-sonar — THJ onchain indexer

> Token holders and marketplace sales across 6 EVM chains, served over one GraphQL endpoint.

![Framework](https://img.shields.io/badge/built%20with-Envio%20HyperIndex-orange)
![Chains](https://img.shields.io/badge/chains-6%20EVM-blue)
![Runtime](https://img.shields.io/badge/node-22%2B-green)
![Deploy](https://img.shields.io/badge/deploy-self--hosted%20(Railway)-8A2BE2)

Repo `0xHoneyJar/thj-envio` · config name `thj-indexer` · maintainer **zerker**.

Query live production (no auth for reads):

```bash
curl -s -X POST https://sonar.0xhoneyjar.xyz/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block } }"}'
```

## What it is

A self-hosted Envio HyperIndex belt. Downstream products need consistent
cross-chain holder truth; querying RPC per product is slow and re-derives the
same work. This syncs from genesis off the open data lake and serves reads
through Hasura behind a rate-limited gateway.

Fourteen source files, ~1,810 lines:

```
src/registry/contracts.ts        THE contracts registry — one entry per contract
src/registry/marketplaces.ts     THE marketplace registry — one entry per deployment
src/handlers/tracked-erc721.ts   Transfer                 → holders, per-token owner
src/handlers/tracked-erc1155.ts  TransferSingle/Batch     → per-tokenId balances
src/handlers/tracked-erc20.ts    Transfer                 → token balances
src/handlers/marketplaces/       Seaport, Blur, Blur v2   → sales
src/lib/                         what the lanes share — Action rows, mint
                                 detection, ownership writes, recordSale()
src/EventHandlers.ts             registers all six lanes
```

`config.yaml` is **generated** from the registries and never hand-edited.
See [ARCHITECTURE.md](ARCHITECTURE.md).

## Adding a community

One entry in `src/registry/contracts.ts`:

```ts
{ community: "warplets",
  address:   "0x699727f9e01a822efdcf7333073f0461e5914b4e",
  chain:     8453,
  standard:  "erc721",
  startBlock: 12345678 }
```

Then:

```bash
pnpm gen:config   # regenerates config.yaml
pnpm test         # contract-registry.test.ts asserts byte-identity
```

`standard` takes `erc721`, `erc1155`, or `erc20` — it is a field, so any of the
three is the same one-entry procedure. There is no second declaration site, no
handler code, and no per-community special case; CI fails if `config.yaml`
drifts from what the registry generates.

A staking vault or escrow gets `custodial: true` instead. It is not indexed —
the entry exists so the ERC-721 lane recognises the counterparty and leaves
holder credit with the wallet that deposited. Without it the vault ranks as the
top holder and every staker silently loses credit.

## Develop

```bash
pnpm install
pnpm codegen      # envio codegen — reads config.yaml + schema.graphql
pnpm dev          # local indexer
pnpm test
```

Requires **Node >= 22** (`.nvmrc` pins it — `nvm use`) and `ENVIO_API_TOKEN`
(see `.env.example`). Node 20 runs the tests fine but `pnpm dev` fails: envio's
handler autoload uses `fs.promises.glob`, which landed in 22.

## Entities

`Action`, `MintActivity`, `TrackedHolder`, `Token`, `TrackedHolder1155`,
`TrackedTokenBalance` — all of `schema.graphql`. score-api reads `Action` and
`MintActivity`; `scripts/verify-belt-contract.mjs` runs daily in CI to catch
drift on that wire before a consumer does.

Every `hold*` action carries `numeric1` as the wallet's **running balance after
the event**, not a delta. That is what lets score-api rebuild daily holder counts
and any as-of holders list from `Action` alone, so the belt stores no history of
its own.

## Scope

EVM only. All three token lanes exist and are tested; the registry currently
declares 74 ERC-721 contracts and no ERC-1155 or ERC-20 ones, so those two are
wired and idle. Solana is deliberately out — `PARKED.md` records why it was not
ported onto Envio's SVM support, and what would have to change for it to be.
