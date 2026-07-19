# ADR — Robinhood ownership via dedicated HyperIndex sidecar

**Status:** Accepted  
**Date:** 2026-07-19  
**Target:** `eip155:4663` / StonkBrokers `0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0`

## Decision

Deploy a **Robinhood-only HyperIndex sidecar** on a dedicated Railway service and
**dedicated Postgres database**, HyperSync-pinned with **no RPC fallback**. Route
Kitchen readiness through a Robinhood-specific `CollectionStatusReader`. Keep the
Henlo monobelt `config.yaml` unchanged.

Adapter identity (feeds capability digest):

```text
prepare_adapter_id:      belt.evm-erc721.robinhood-sidecar
prepare_adapter_version: rh-hyperindex-sidecar.v1
```

## Why not monobelt

Envio lists Robinhood 4663 as first-class HyperSync/HyperIndex. The production
blocker is **topology-sensitive resume**: adding `evm.chains.4663` changes the
persisted `envio_info` identity and refuses resume without reset or a second
indexer. A bad RH source previously stalled all chains. Shared Postgres/`public`
also couples Envio wipes to Kitchen (#236).

## Ranking (default = 1)

1. RH-only HyperIndex sidecar, dedicated DB — **default**
2. Thin HyperSync client worker → app-owned tables — kill-criteria fallback
3. Ponder / SQD / custom RPC walker — further fallbacks
4. Add 4663 on next KF-013 monobelt wipe — tactical only after #236 + canary
5. Recognize-only forever — fails product objective

## Isolation invariant

```text
Kitchen job DB       — Kitchen only
Henlo monobelt DB    — monobelt only
Robinhood sidecar DB — RH indexer only
```

Canary may use a disposable schema on a throwaway DB. Production must not share
Envio credentials with Kitchen or the monobelt.

## Contract truth (until canary passes)

Recognize for 4663 stays live. Kitchen `ownership_index.v1` preparation for 4663
is **disabled** (not advertised `available` under `belt.evm-erc721`) until the
sidecar can produce coverage-bound readiness.

## Canary

See `grimoires/loa/coordination/collection-report/robinhood-sidecar-canary.md`
and in-repo scaffold:

- `config.robinhood-sidecar.yaml`
- `src/sidecars/robinhood/EventHandlers.ts`

## Kill → thin HyperSync worker

Abandon HyperIndex sidecar if HyperSync is not selected, wildcard fatal returns,
digest mismatch, exact-config resume requires `-r`, backfill >4h or lag >60s
steady-state, or migrations escape the dedicated DB.

## Monobelt wipe add (non-goal)

Only after: #236 closed, sidecar proven, blue/green re-index authorized, and
operators accept future chain-topology changes still invalidate monobelt resume.
Even then, monobelt inclusion is not the strategic destination.

## References

- Envio HyperSync networks (Robinhood 4663)
- Envio multichain / incompatible config resume
- `prd.robinhood-live-recognize.md`
- sonar-api issues #232 / #234 / #236
- SVM SQD edge precedent (`src/svm/sqd-parallel-loader.ts`)
