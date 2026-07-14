# SPIRAL — SVM deep-history indexer (BOEHM, structuring-a-spiral)

> **Lens**: BOEHM · construct-boehm/skills/structuring-a-spiral · applied 2026-07-06
> **Commitment**: self-host a full-genesis Solana NFT indexer into `svm.collection_event`
> **Fallback in reserve**: **SQD Portal + our §4.5-proven decoder** — the proven floor.
> It already decodes the free SQD lake at 1767/1767 (#140-#142). It is NOT a co-equal arm;
> it is what every NO-GO drops to.
> **Inputs**: sdd.md · sprint.md · context/2026-07-06-boehm-economics-svm-indexer.md · GATE-1 record

## Re-rank — 2026-07-06 (post-CYCLE-1 · BOEHM structuring-a-spiral)

**CYCLE 1 fired: NO-GO for Envio HyperSync-Solana (bd-rdnj closed).** Two independent kills —
(1) rolling retention floor ~slot 391,791,680 sits 89M–290M slots above every canary era; (2) the
documented endpoint `solana.hypersync.xyz` is NXDOMAIN on both public resolvers (eth.hypersync.xyz
resolves = zone healthy). Full evidence: `grimoires/loa/context/2026-07-06-lake-decision-record.md`.

**Consequence — the comparison collapsed.** R1 is RETIRED and Envio is eliminated on coverage, so
**SQD Portal is the lake, not a fallback.** The LakeAdapter seam's primary justification ("one
harness, two lakes") evaporates; the `EnvioHyperSyncAdapter` is untestable and CUT. The resource
canary runs on the *existing* `sqd-loader.ts` (Strategy A) — it never needed the seam.

**New cycle order (highest remaining exposure first):**
- ~~CYCLE 1 (R1 genesis)~~ ✅ DONE → NO-GO. Envio out.
- ~~CYCLE 2 (R2 parity)~~ → PROVEN-ELSEWHERE. SQD decodes at 1767/1767 live (test/sqd-45-gate-integration.test.ts). Envio arm moot. bd-9jdy (generalize `runParityGate`) demoted to optional (SQD lane = regression floor only).
- **CYCLE 3 (R3 resource / density-wall) → NOW THE ACTIVE HIGHEST-EXPOSURE CYCLE.** bd-5sqe, needs-a-box, SQD-only. The real remaining unknown: does full-genesis sync collapse the ~400k mint-filtered-windowed request count, and does it fit a box w/o KF-015 OOM + co-locate on the belt-indexer Railway box ($0-marginal)?
- CYCLE 4 (R4 schema) → bd-lx00, after CYCLE 3.

**Descopes (JOBS negative-allocation):** bd-mbtb `EnvioHyperSyncAdapter` CUT; bd-mbtb LakeAdapter+SqdPortalAdapter + bd-9jdy demoted to optional (future Envio re-eval option value only, see re-open conditions in the decision record). bd-5sqe deps on bd-mbtb/bd-9jdy REMOVED — it uses the shipped loader.

## Risk register (ranked by exposure = P(loss) × cost(loss); buckets, not forecasts)

| # | risk | P(loss) | cost(loss) | exposure | status |
|---|---|---|---|---|---|
| R0 | self-host-vs-metered is the wrong model | MED | very high | HIGH | **RETIRED** — cost curve drawn (~26×/yr, no crossover, structurally unbounded). No cycle. |
| R1 | Envio HyperSync-Solana genesis coverage insufficient for the canary mints (GATE-1) | MED | high | **HIGH** | **RETIRED** — CYCLE 1 NO-GO: NXDOMAIN endpoint + rolling floor 391.79M > all canary eras. Envio eliminated; SQD is the lake. |
| R2 | Envio decode parity — adapter can't reproduce the §4.5 reference (GATE-2) | MED | medium | MED | **MOOT/PROVEN** — SQD 1767/1767 live; no Envio lake to compare. bd-9jdy optional. |
| R3 | resource fit — density-wall recurs, KF-015 OOM, or won't co-locate (GATE-3) | LOW-MED | medium | MED | **RETIRED** — CYCLE 3 measured: seq density wall real (5–10 d), Strategy B refuted, escape = parallel range-partition (validated + **BUILT**: src/svm/sqd-parallel-loader.ts, ~6–12 h/coll). RAM/storage non-binding. |
| R4 | schema drift onto the existing PK (GATE-4) | LOW | low | LOW | **RETIRED** — CYCLE 4 GATE-4 PASS (measured, scratch Railway PG): 0 collisions, idempotent, 0 clobbers. `source=sqd-stream`, cursor reuses `sqd_cursor_slot`. No new migration. |
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
