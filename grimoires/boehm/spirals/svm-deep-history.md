# SPIRAL — SVM deep-history indexer (BOEHM, structuring-a-spiral)

> **Lens**: BOEHM · construct-boehm/skills/structuring-a-spiral · applied 2026-07-06
> **Commitment**: self-host a full-genesis Solana NFT indexer into `svm.collection_event`
> **Fallback in reserve**: **SQD Portal + our §4.5-proven decoder** — the proven floor.
> It already decodes the free SQD lake at 1767/1767 (#140-#142). It is NOT a co-equal arm;
> it is what every NO-GO drops to.
> **Inputs**: sdd.md · sprint.md · context/2026-07-06-boehm-economics-svm-indexer.md · GATE-1 record

## Risk register (ranked by exposure = P(loss) × cost(loss); buckets, not forecasts)

| # | risk | P(loss) | cost(loss) | exposure | status |
|---|---|---|---|---|---|
| R0 | self-host-vs-metered is the wrong model | MED | very high | HIGH | **RETIRED** — cost curve drawn (~26×/yr, no crossover, structurally unbounded). No cycle. |
| R1 | Envio HyperSync-Solana genesis coverage insufficient for the canary mints (GATE-1) | MED | high | **HIGH** | **CYCLE 1** — the open sub-question |
| R2 | Envio decode parity — adapter can't reproduce the §4.5 reference (GATE-2) | MED | medium | MED | CYCLE 2 |
| R3 | resource fit — density-wall recurs, KF-015 OOM, or won't co-locate (GATE-3) | LOW-MED | medium | MED | CYCLE 3 |
| R4 | schema drift onto the existing PK (GATE-4) | LOW | low | LOW | CYCLE 4 |
| R5 | Envio-vs-SQD **ops convenience** | HIGH | low | LOW | tie-breaker only |
| — | Envio-vs-SQD **cost** | — | — | — | **ZERO — identical curves; measured elsewhere** |

## Cycles (biggest uncertainty first — buy down HIGH exposure with the cheapest probe)

**CYCLE 1 — buys down R1 (genesis coverage).** The whole bet dies here if Envio's free lake
doesn't reach the collections' mint slots, so retire it first and cheaply.
- effort: the HyperSync-Solana **client** genesis-depth probe (bead bd-rdnj / T1.1) — a bounded
  query via the real client (not blind curl), against the two canary mint-eras: SMB gen2 (~2021,
  low slots) and pythians (~303M).
- evidence: HyperSync-Solana returns token-balance rows at **both** canaries' mint-era slots.
  *(experiment design → PLATT)*
- GATE 1: **GO** if it reaches genesis for both · **NO-GO → SQD fallback** (drop to the proven
  floor; Envio is out on coverage) · **RE-OPEN** if partial (some collections covered) — scope
  Envio to the covered set, SQD for the rest.

**CYCLE 2 — buys down R2 (decode parity).**
- effort: the lake-adapter seam + generalized §4.5 gate (T1.2/T1.3); run the Envio adapter's
  normalized rows through our unchanged decoder against the pythians fixture.
- evidence: ≥0.99 two-sided match, 0 unexpected, same ambiguous-group handling. *(→ PLATT)*
- GATE 2: **GO** if parity clears · **NO-GO → SQD fallback** · **RE-OPEN** if the gap is a
  fixable HyperSync field-mapping (re-map, re-run once).

**CYCLE 3 — buys down R3 (resource + the density-wall question).**
- effort: canary full-genesis sync (pythians + **mandatory** dense SMB gen2) on a box; measure
  peak RAM, wall-clock, storage, and **request-count** (the density-wall metric) + the Boehm
  co-location sub-metric (does it fit the existing belt-indexer Railway box → the $0-marginal).
- evidence: request-count collapses vs the ~400k mint-filtered-windowed wall; peak RAM fits a
  box with no KF-015 OOM; co-locates or needs a bounded own service. *(→ PLATT)*
- GATE 3: **GO** if fits + wall avoided · **NO-GO → resize once, else SQD** · **RE-OPEN** if a
  sync-strategy knob (window vs full-block-scan) fixes the count.

**CYCLE 4 — buys down R4 (schema convergence).**
- effort: insert-if-absent dry-run of decoded rows onto `svm.collection_event`.
- evidence: 0 PK collisions, 0 clobbers on `{tx_signature}:{nft_mint}:{instruction_index}`.
- GATE 4: **GO** · **NO-GO → size a migration** (never a framework flip — GATE-4 only sizes).

## Effort allocation (value-based — the negative allocation matters as much as the positive)

```
CYCLE 1 (genesis probe)   -> LARGEST relative weight — highest exposure, cheapest kill. Do first.
CYCLE 3 (resource canary) -> LARGE — the real unknown (density wall + co-location $0 claim).
CYCLE 2 (parity)          -> MEDIUM — bounded; our decoder is proven, only the adapter is new.
CYCLE 4 (schema)          -> SMALL — low exposure.
Envio-vs-SQD COST axis    -> ZERO — identical free-lake curves; measuring it retires no risk.
R0 self-host-vs-metered   -> ZERO — already retired by the drawn curve; do not re-spike.
```

## Inheritance

**This plan already IS a spiral — re-derived, now named.** The SDD's GATE-1..4 were risk-driven
cycles with go/no-go gates and SQD-as-fallback before this document existed. Naming it makes the
methodology a *choice*: we gate commitment on retired risk, not a waterfall to a presumed
framework. An unnamed spiral erodes; a named one holds.

## Route

- **PLATT** — design the crucial experiments: the genesis-depth query (C1), the parity kill-switch
  (C2), the resource canary's pass/fail instrumentation (C3). BOEHM draws the gate; PLATT builds
  the kill-switch that produces the evidence.
- **TETLOCK** — if any P(loss) bucket needs to become a calibrated number before an allocation
  call, calibrate it. (Buckets are ordering proxies here; none needs forecasting yet.)
- **JOBS** — no negative-allocation / scope-cut candidate surfaced; the spike is already minimal.

> Signal (handoff): C1-C3 evidence-bars → PLATT · P(loss) buckets → TETLOCK (calibration only if
> an allocation is contested) · scope → none. Confidence: HIGH on the structure (it re-states a
> validated SDD); MED on R3's box-fit until the canary runs.
