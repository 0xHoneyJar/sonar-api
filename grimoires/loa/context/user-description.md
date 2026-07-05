# Project Description (from /plan)
> Auto-generated from operator's /plan invocation, 2026-07-05.

Cycle svm-sqd-substrate — SqdCollectionEventSource: SQD Portal (portal.sqd.dev, solana-mainnet
from block 0, real-time; verified OPEN/unauthenticated 2026-07-05, height 430,902,735) as the $0
block-stream substrate for Solana history + live tail. Decode mint/transfer/burn from token-balance
diffs; converge on svm.collection_event's content-addressed PK; validate via the §4.5 gate against
the pythians 30,006-event fixture. Resolves the Clay/FFF/GG member-era problem (balance history is
metadata-era-agnostic); replaces Dune bulk egress (20cr/MB free tier) and stale BigQuery (frozen
2025-03-31); fulfills the block-stream seam anticipated in src/svm/nft-collection-source.ts.
Constraints: metered-provider-spike-protocol (shaped probe before commitment), operator Dune-approval
rule (NOTES standing constraint), bridgebuilder-review merge gate (operator rule).
