# sonar-api

An Envio HyperIndex belt. ERC-721 / ERC-1155 / ERC-20 holders and marketplace
sales across 6 EVM chains. Read [ARCHITECTURE.md](ARCHITECTURE.md) first — it is
one page and it is accurate.

## The one rule

**`src/registry/contracts.ts` and `src/registry/marketplaces.ts` are the only
declaration sites.** `config.yaml` is generated from them:

```bash
pnpm gen:config   # regenerate
pnpm test         # contract-registry.test.ts asserts byte-identity
```

Never hand-edit `config.yaml`. Adding a contract or a marketplace is one entry
plus that command — no handler code, no per-community case. CI fails if the two
drift.

## Adding things

| want | do |
|---|---|
| track a new collection | one entry in `contracts.ts` (`standard`: erc721 / erc1155 / erc20) |
| cover a new chain | entries in both registries with that `chain` |
| add a marketplace deployment | one entry in `marketplaces.ts` |
| add a *new* marketplace | a decoder in `src/handlers/marketplaces/`, a `Marketplace` union member, a lane in `scripts/gen-config.ts` |

Every decoder answers the same four questions — who sold, who bought, which
NFTs, what was paid — and hands them to `recordSale()` in `src/lib/sale.ts`.
No venue ABI belongs anywhere else.

## Before you commit

```bash
pnpm gen:config && pnpm codegen && pnpm test
npx tsc --noEmit -p tsconfig.json          # must be 0 errors
node scripts/check-onevent-bijection.mjs   # every config pair has a handler
```

## Things that bite

- **A new entity or column means a full re-index.** Envio's `isInitialized()`
  checks table existence, not the config hash, so a plain resume silently skips
  new bindings.
- **Real logs, not synthetic fixtures, for any decoder.** A decoder that passes
  hand-written tests and disagrees with the chain produces zero rows and no
  error. Both marketplace decoders are tested against captured mainnet logs;
  keep it that way.
- **Custody is not ownership.** Staking vaults and lending escrows (Blur Blend,
  the Mibera vaults) hold tokens on a user's behalf. They belong in the registry
  as `custodial: true` or they rank as top holders and strip the real one.
- **`Action.txHash` vs `MintActivity.transactionHash`** — the two entities
  disagree and both are load-bearing. Don't "fix" one alone.

## Consumer

score-api reads `Action` (bronze event pull) and `MintActivity` (sale
attribution) off the GraphQL endpoint, via its `INDEXER_GRAPHQL_URL`.
`scripts/verify-belt-contract.mjs` runs daily in CI and fails on drift.

Off-path findings go in [PARKED.md](PARKED.md), one line each.
