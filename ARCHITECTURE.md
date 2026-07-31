# sonar-api architecture

An Envio HyperIndex belt. One registry, two handlers, six chains.

## The path

```
src/registry/contracts.ts  →  config.yaml  →  handlers  →  Postgres  →  Hasura  →  Caddy  →  score-api
     (the only                (generated,       (2 files)                        (belt-gateway)
      declaration site)        never edited)
```

Adding a community is **one entry** in `src/registry/contracts.ts`, then
`pnpm gen:config`. Nothing else. `test/contract-registry.test.ts` asserts
`config.yaml` is byte-identical to what the registry generates, so a second
declaration site cannot reappear.

## Handlers

| handler | event | writes |
|---|---|---|
| `src/handlers/tracked-erc721.ts` | `Transfer(address,address,uint256)` | `TrackedHolder`, `Token`, `Action` |
| `src/handlers/seaport.ts` | `OrderFulfilled(...)` | `MintActivity`, `Action` |

Both self-register on module load; `src/EventHandlers.ts` imports them for that
side effect only. `envio codegen` reads `config.yaml` + `schema.graphql`.

`src/lib/` holds the three pieces both handlers share: `actions.ts` (the `Action`
row), `mint-detection.ts` (zero-address and burn checks), `token-ownership.ts`
(the single `Token` write).

## Chains

Ethereum (1), Optimism (10), Base (8453), Arbitrum (42161), Zora (7777777),
Berachain (80094). All via HyperSync — there is no RPC configuration.

## Entities

Four, in `schema.graphql`: `Action`, `TrackedHolder`, `Token`, `MintActivity`.
score-api reads `Action` (belt pull) and `MintActivity` (sale attribution).

## Deployment

| service | built from | what it is |
|---|---|---|
| `belt-indexer-selfhost` | `Dockerfile.belt` | `pnpm envio start` |
| `belt-hasura-selfhost` | (Hasura image) | GraphQL over the indexed Postgres |
| `belt-gateway` | `Dockerfile.gateway` + `Caddyfile` | public URL, per-IP rate limit; reverse-proxies Hasura |

The gateway is a stable indirection: belt recovery swaps `BELT_UPSTREAM`, and
the public GraphQL URL never changes.

## Scope

ERC-721 on EVM only. ERC-1155 and Solana are deliberately out — see `PARKED.md`
for why Solana was not ported onto Envio's SVM support.
