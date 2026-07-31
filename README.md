# freeside-sonar — THJ onchain indexer

> ERC-721 holders and marketplace sales across 6 EVM chains, served over one GraphQL endpoint.

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
same work, and hosted indexers charge per deployment so every contract addition
is a billable reindex. This syncs from genesis off the open data lake and serves
reads through Hasura behind a rate-limited gateway.

Eight source files, ~1,080 lines:

```
src/registry/contracts.ts     THE registry — one entry per contract
src/handlers/tracked-erc721.ts  Transfer  → holders
src/handlers/seaport.ts         OrderFulfilled → sales
src/handlers/tracked-nft-contracts.ts  sale-eligibility, read from the registry
src/lib/{actions,mint-detection,token-ownership}.ts   what both handlers share
src/EventHandlers.ts          registers the two handlers
```

`config.yaml` is **generated** from the registry and never hand-edited.
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

That is the whole procedure. There is no second declaration site, no handler
code, and no per-community special case — CI fails if `config.yaml` drifts from
what the registry generates.

## Develop

```bash
pnpm install
pnpm codegen      # envio codegen — reads config.yaml + schema.graphql
pnpm dev          # local indexer
pnpm test
```

Requires Node >= 22 and `ENVIO_API_TOKEN` (see `.env.example`).

## Entities

`Action`, `TrackedHolder`, `Token`, `MintActivity` — all of `schema.graphql`.
score-api reads `Action` and `MintActivity`; `scripts/verify-belt-contract.mjs`
runs daily in CI to catch drift on that wire before a consumer does.

## Scope

ERC-721 on EVM. ERC-1155 and Solana are deliberately out — `PARKED.md` records
why Solana was not ported onto Envio's SVM support, and what would have to change
for it to be.
