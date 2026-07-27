# Security Audit — sprint-bug-191

**Auditor**: Paranoid Cypherpunk Auditor
**Branch**: `fix/sprint-bug-191-config-derived-collection-identity` @ `c78bd4bc`
**Prerequisite**: review APPROVED (round 2, 0 open findings)
**Surface**: 17 files, 1 deleted. Indexer handler + YAML config parser + Kitchen label
sanitiser + a newly published artifact. No auth code, no API endpoint, no new user-input
path — but see MEDIUM-1: this sprint **promotes an existing input to a trust boundary**.

## Verdict: APPROVED - LETS FUCKING GO

0 CRITICAL, 0 HIGH. Two MEDIUM and one LOW below. None block; all three are constraints on
the consumer or the next workstream, and the most important one is already mitigated by a
design choice the engineer made for correctness reasons rather than security ones.

## Checklist

| Area | Result |
|------|--------|
| Hardcoded secrets | **clean** — scanned the full `main...HEAD` diff. Every `token` hit is `paymentToken`/`tokenId`/"soul bound fungible token"/prose. The only `process.env` read added is `BELT_CONFIG`, unchanged from sprint-bug-190 |
| Injection surface | **reduced** — no SQL, no shell, no eval. The one write path (`sanitizeKitchenLabel` → YAML comment) now strips a **strictly larger** character set than before: `[^A-Za-z0-9_-]` vs `[^A-Za-z0-9 _-]`. Newlines were already impossible; spaces are now too |
| YAML parsing safety | **unchanged-safe** — `parse` → `parseDocument`, both with `schema: "failsafe"`, which disables custom tags and type coercion entirely. `parseDocument` builds an AST; it evaluates nothing. The `yaml` package's default `maxAliasCount` billion-laughs guard still applies |
| ReDoS | **clean, measured** — all six new/changed patterns probed with adversarial 50,000-char inputs. Worst case 1.96ms. No nested quantifiers; every pattern is anchored or a single character class |
| Path traversal | **acceptable, unchanged** — `BELT_CONFIG` selects the config path, but it is operator-set infrastructure config at the same trust level as the rest of the deploy |
| Auth / authz | **n/a** — no access-control code touched |
| PII | **clean** — wallet and contract addresses only, already public chain data |
| Error handling / info disclosure | **clean** — new logs print the config path, `cwd`, and contract addresses. `cwd` is a container-local path, already disclosed by the pre-existing log |
| Denial of service | **improved** — review MEDIUM-1's fix removes an unbounded per-event `readFileSync` on the failure path. Verified: 1 read across 50,000 handler calls, and the mutation test proves the pre-fix code did 50,000 |
| Arithmetic | **n/a** — no money path touched in this diff |

## The trust-boundary question, traced end to end

This sprint makes a **YAML comment load-bearing**: it now determines `primaryCollection`,
which is score-api's join key. Comments were previously inert. That is a genuine trust
promotion and it deserved tracing rather than assuming.

**Path**: Kitchen ingest job → `deterministicJobLabel` → `sanitizeKitchenLabel` → YAML
comment → `collectionKeyFromComment` → `primaryCollection` → score-api.

**Finding: the production path is collision-free by construction.**
`src/kitchen/ingest-worker.ts:60-63` builds the label as
`kitchen_<namespace>_<reference>_<deployment digest[0:12]>` — machine-generated from the
deployment digest, never operator prose. Two collections cannot collide without a 48-bit
digest collision. The arbitrary-`label` parameter on `patchConfigForKitchenIngest` exists
but no production caller supplies one.

So the attack I went looking for — an authenticated caller onboarding a contract with
label `azuki` to poison the real Azuki's identity — **is not reachable through the
production drain**. Recording the reasoning because the next person to add a caller that
passes a human label re-opens it.

## MEDIUM-1 — a colliding key degrades the *victim*, and only CI catches it

**Files**: `src/handlers/marketplaces/tracked-nft-contracts.ts:180-205` (drop-both),
`src/kitchen/config-patcher.ts:112-160` (no collision check)

When two bindings claim one key, **both** fall back to raw addresses. That is the correct
choice and I would have blocked the alternative — a merge is undetectable downstream and
unrecoverable. But note the asymmetry it creates: a newly-added colliding entry does not
merely fail to get named, it **strips the name off the collection that was already there**.
Blast radius is the incumbent, not the newcomer.

Today that is contained: the production label is digest-unique, and
`test/collection-key-parity.test.ts` fails CI on any duplicate in the committed config. The
uncovered case is a **runtime** duplicate reaching a config the CI gate never sees — which
requires a caller passing a human label, i.e. the surface named above.

Worth weighing: the engineer's own AC3 test hit a real collision on its first run
("Nodes by Hunter" vs the existing `nodes_by_hunter`). Accidental collision is empirically
more likely than malicious.

**Not blocking** — production cannot currently reach it. **Required before any caller
supplies a human label**: reject a label whose sanitised key already appears in the config.
That check must live inside `src/kitchen/` — `Dockerfile.kitchen` copies only `src/kitchen`,
`src/collection-resolver` and `migrations/kitchen`, so it cannot import
`deriveCollectionKeys` from `src/handlers/`.

## MEDIUM-2 — publishing the gap map tells users how to evade the score

**File**: `sale-coverage.json`

score-api's `conviction` score rewards **not** selling. This artifact now states, precisely
and publicly, which venues produce no sale row: Blur, Wyvern, X2Y2 and LooksRare on
Ethereum; Element on Base; everything on Optimism; everything on Solana bar `pythians`.

A holder who wants to sell without their conviction score registering it can read this file
and pick Blur.

I am **not** recommending it be withheld. The gap exists whether or not it is documented, it
is trivially discoverable by selling once and observing the score, and the alternative —
score-api silently treating every gap as a confirmed non-sale — is the exact defect this
cycle exists to fix. Obscurity here buys nothing and costs correctness.

**Required of the consumer**: treat `absentSaleMeans: "unknown"` as genuinely unknown, not
as a pass. A conviction score computed over a chain/venue we do not decode should be
**withheld or confidence-weighted**, not awarded. Awarding full conviction on `unknown`
converts this document from a disclosure into an exploit manual. This belongs in score-api's
scoring design before the next scoring release, not after.

## LOW-1 — auto-onboarded collections get opaque identifiers

**File**: `src/kitchen/ingest-worker.ts:60-63`

The digest-based label that makes collisions impossible also makes the key unreadable:
a Kitchen-onboarded community reaches score-api as
`kitchen_eip155_1_a1b2c3d4e5f6`, not `just_t00ns`. The one live example
(`kitchen_just_t00ns`) predates this format and was evidently set by hand.

Not a security issue and not a regression — before this sprint those collections reached
score-api as raw hex, which is strictly worse. Recording it because making the comment
load-bearing turns a cosmetic label into a permanent public identifier, and "stable but
unreadable" is a product decision someone should make deliberately rather than inherit.

## Positive properties worth recording

**The failure mode is fail-closed for data correctness in every direction.** Unreadable
config → nothing named, no sales, loudly logged. Duplicate key → both unnamed, never
merged. Unusable comment → raw address, logged at startup. There is no path where this code
emits a *confidently wrong* identifier, which is the only failure that would corrupt
score-api irreversibly.

**`operator` remains unspoofable.** The sprint-bug-190 property holds unchanged: sale
`operator` comes from `event.srcAddress` and Seaport is bound by explicit address. Nothing
here moves sale decoding toward wildcard indexing. The standing constraint carries forward
— **wildcard indexing for fill events must not be adopted without an emitter allowlist**.

**The retry fix was pinned from both sides.** I checked the mutation evidence myself rather
than accepting it: reverting to per-event retry fails the bounded-cost test, and
over-correcting to cache-forever fails the self-healing test. A single-sided test would have
let the over-correction through, and that over-correction silently re-breaks BB SEA-004.

## Conditions

None blocking.

Two things must happen and neither is code in this diff:

1. **Post-deploy**, `sale-coverage.json`'s `measured` blocks describe a database the wipe
   destroys. They are labelled indicative and the load-bearing field is structural, so this
   is not a correctness defect — but they must be re-measured after the reindex.
2. **MEDIUM-2's consumer requirement** must reach score-api in writing, not just in this
   file. The handoff note is the mechanism.

## Notes for the record

- AC3 is proven in-process, not live, by operator decision. The audit takes no issue: the
  Kitchen round-trip test drives the real patcher into the real derivation on both contract
  names, which is a stronger proof than a single live binding would have been for the
  *mechanism*, and weaker only for the *deployment*.
- `.DS_Store` is modified in the working tree (pre-existing, unrelated). It is not staged
  and must not be committed — same note as sprint-bug-190.
- 11 bound collections with zero holders are pre-existing and out of scope. `bobu`'s zero is
  unexplained by its floor registry entry and deserves its own triage.

---

LOA-VERDICT: APPROVED
critical=0 high=0 medium=2 low=1
