# PRD — Henlo pressure wipe (NFT + ERC-20 + Robinhood)

**Status:** Executing (operator-authorized wipe+resume)  
**Date:** 2026-07-19  
**Source list:** `loa-freeside/henlo-leaderboard-communities.csv`

## Goal

One monobelt wipe carries the Henlo leaderboard extraction plus Robinhood:

- ~60 new EVM ERC-721s (Eth / Arb / Base / OP / Bera / Zora)
- 14 EVM ERC-20s via `TrackedErc20` (config-only; not Kitchen admit)
- New chain `eip155:4663` + StonkBrokers

## Explicit skips

- CryptoPunks (non-standard Transfer — BB F-004)
- Solana assets
- ERC-1155 notes
- Blast (`81457`)
- Rows with no contract

## Procedure

KF-013 / `belt-reinit.md`: `ENVIO_RESTART=1` seed → verify `chain_metadata` count = 7 → delete var → resume → batch-admit NFTs → ack.
