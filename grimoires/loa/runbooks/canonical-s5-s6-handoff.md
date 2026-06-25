# Canonical event normalization — S5/S6 cross-building handoff

The producer-side canonical `NftActivity` normalization is BUILT + MERGED through the
sonar-only boundary (S1–S4, all FAGAN-approved, all INERT). This runbook is the handoff
for the two remaining sprints, which are **cross-building** (need the score-mibera consumer
+ real data + live secrets) and therefore could not be auto-completed from a sonar session.

The governing invariant throughout: **nothing emits or projects live ahead of a validated
consumer** (deployed-but-unconsumed). S5 validates; only then does S6 flip anything live.

## What is already shipped (INERT)

| Piece | Where | State |
|-------|-------|-------|
| `NftActivity` contract | `@0xhoneyjar/events` (loa-freeside #311, main `5d69285a`) | merged |
| SVM mapper | `src/canonical/map-svm.ts` (sonar #86) | merged, pure |
| EVM mapper | `src/canonical/map-evm.ts` (sonar #87) | merged, pure |
| Emit layer | `src/canonical/emit.ts` (sonar #87) | merged, gate OFF |
| `action` projection | `scripts/action-contract.json` + `action-projection.sql` | pending-exposure |
| Typed errors | `src/canonical/errors.ts` | merged |
| **S5 parity gate** | `src/canonical/parity.ts` + `scripts/s5-parity-dryrun.ts` | merged, runnable |

## Producer real-data validation (DONE — `npm run validate:svm-canonical`)

The SVM mapper has been validated against the LIVE `svm.collection_event` data (read-only):
**30,000 / 30,000 real Pythians events map cleanly through `map-svm` → valid `NftActivity`, zero
`SchemaInvalid`** (verbs: mint 3,682 = the holder count cross-check, transfer 21,016, sale 5,302).
The script (`scripts/validate-svm-canonical-live.ts`) also writes a real-data `canonical-sample.json`
— the producer half of the S5 dry-run.

- **S6 backfill LESSON (load-bearing):** Hasura serializes `bigint` columns (`price`, `slot`) as
  STRINGS and `timestamptz` (`block_time`) as an ISO string on the wire — the Helius source gives
  numbers. Any Hasura-sourced adapter (the S6 backfill) MUST `Number()`-convert `price`/`slot` and
  parse `block_time` to unix seconds before feeding `map-svm`, or every row trips the integer guard.
- **EVM real-data validation is BLOCKED on data availability (not done):** the gateway's EVM read
  surface (`belt-contract.json`) exposes only `Transfer` (no `logIndex`, no `timestamp`, no sale
  entity), so `map-evm`'s carrier selection + sale-join can't be exercised against live data here. It
  needs the S4/S6 EVM Hasura adapter (with logIndex/timestamp) + the MintActivity SALE rows (score-api
  territory) — i.e. it converges with the S5 join-parity below, not a standalone producer check.

## S5 — the consumer-parity GATE (run BEFORE any backfill)

Goal: prove the canonical stream COVERS what score-mibera's current fetchers produce, by the
§4 dedup identity `(tx, asset_ref, verb)`, on a SMALL sample — before the full backfill.

1. Produce a canonical sample: run the mappers over a slice of native entities →
   `canonical.json` (an `NftActivity[]`). (Emit to the `.staging` subject / flag still OFF — or
   skip emit entirely and just serialize the mapper output for the dry-run.)
2. Get score-mibera's current `(tx, asset_ref, verb)` tuples for the same slice → `legacy.json`.
3. Run the gate:
   ```
   npx tsx scripts/s5-parity-dryrun.ts canonical.json legacy.json
   ```
   Exit 0 = parity holds (with real overlap) · 1 = FAILED or vacuous · 2 = usage/IO.

Interpreting the report (in priority order):
- **`legacyOnly` / `parityHolds=false`** — the canonical stream LOST something the consumer
  relies on. Hard stop. Fix the producer; do NOT proceed.
- **`verbDisagreements`** — read these FIRST. A `(tx, asset_ref)` the producer classified
  differently than the consumer (e.g. a sale demoted to a transfer — the map-evm MINOR-1
  leading-zero join-miss). These are real losses (already in `legacyOnly`), named separately so
  they can't hide among tolerable over-emits.
- **`canonicalOnly` (the MAJOR-3 decision)** — producer extras, mostly market-routing-hop
  `verb=transfer` over-emits. These do NOT fail parity. DECIDE here, with real mibera topology:
  does score-mibera's dedup tolerate them, or must the producer suppress routing hops? (Suppression
  was deferred precisely because a no-data heuristic risks silent loss on multi-leg pre/post chains
  — see `map-evm.ts` header.) Subtract `verbDisagreements` verbs before treating the rest as tolerable.
- **`valueParityChecked: false`** — this gate is PRESENCE parity only. The re-derived sale
  `from`/`to`/`value` (ported from score-api `fetchMiberaBuyers/Sellers`) is NOT checked here. Run a
  SEPARATE value-parity pass over `matched` before trusting a GREEN (the legacy input here is key-only).
- **`matched=0` with `parityHolds=true`** — vacuous: the legacy sample was empty/non-overlapping.
  The CLI already exits 1 on this; a real go/no-go needs `matched > 0` + complete inputs.

## S6 — go-live (ONLY on a validated S5 parity)

Land these 4 prerequisites at the composition root FIRST (they are documented in the
`src/canonical/emit.ts` header; do NOT flip the flag without them):

1. **Durable prev-hash store** (or a consumer-side chain-reset handshake). The InMemory store
   re-genesis-es the chain on restart, which a chain-verifying consumer surfaces as
   `prev-hash-broken` on every restart envelope. The canonical chain's value IS verifiability.
2. **Build the live emitter via `makeCanonicalEmitterIfEnabled`** (the gate as a capability —
   returns null when disabled), never the raw factory.
3. **A DISTINCT signing seed** — `SONAR_CANONICAL_SIGNING_SEED_HEX`, NEVER reuse
   `SONAR_SIGNING_SEED_HEX`. The keyId guard is label-only; it cannot detect wrong key material.
4. **A `recovery` config** (maxRetries + deadLetter + onAlert) so a transient NATS blip is an
   observable dead-letter, not a silently-dropped `Left`.

Then, in order:
1. Apply `action-projection.sql` to belt-hasura-selfhost (run_sql + `pg_track_table` +
   public-role select), mirroring the `svm.collection_event` go-live (#82).
2. Promote `canonical_action` in `scripts/action-contract.json` from `pending-exposure` → `live`
   (the `verify:action-contract` CI guard then hard-fails on future drift).
3. Full EVM+SVM backfill → canonical (serialized emit, content-addressed `event_id` so a re-run
   is idempotent). Reconcile counts.
4. Flip `SONAR_CANONICAL_EMIT_ENABLED=true`.
5. Schedule the `nft.mint.detected` deprecation (a future cycle, ≥30d overlap; the consumer
   atomically cuts over — subscribe `nft.activity.recorded.*` + unsubscribe mint-detected — and
   dedups by `(tx, asset_ref, verb)` during the overlap window).

## References

- Cycle docs (local): `grimoires/loa/cycles/canonical-event-normalization/{prd,sdd,sprint}.md` (SDD §8.5 = the S5 checklist).
- Contract: `@0xhoneyjar/events` `NftActivitySchema` (the single home; version `*.v2` for any non-additive change, ≥30d overlap).
