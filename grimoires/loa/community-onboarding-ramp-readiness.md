# Community-Onboarding Ramp — Readiness Handoff

> The data-truth surface for the 10-EVM + 10-SVM community-onboarding ramp (#121). Written after the
> 2026-07-06 belt reindex that fixed the dark EVM ramp. **Live state is not in this file** — run the
> oracle. This is the map, not the territory.

## The one command

```bash
npx tsx scripts/ramp-readiness.ts          # table (community-onboarding ramp only)
npx tsx scripts/ramp-readiness.ts --all    # + all other tracked collections (mibera/lore/honeyjar)
npx tsx scripts/ramp-readiness.ts --json    # machine-readable (CI / score-api handoff)
```

It reads the SAME source-of-truth the indexer uses (`src/handlers/tracked-erc721/constants.ts`,
`src/svm/collection-registry.ts`, `config.yaml`) and cross-checks it against LIVE gateway state, so
"is this collection ready for score-api to pull?" is answered by data, not config intent. READ-ONLY.

### Verdicts
| Verdict | Meaning | Action |
|---|---|---|
| `READY` | holders/events > 0 AND chain caught up to head | score-api can pull |
| `READY·backfill` | holders > 0, chain still backfilling | pullable, still growing |
| `INDEXING` | chain hasn't scanned to head yet — can't conclude | wait, not broken |
| `MISSING ⚠` | chain at head but 0 holders/events | real defect — investigate |
| `NOT·BACKFILLED` | SVM collection with no events | needs the deep-history lane (BOEHM PRD) |
| `DRIFT ⚠` | key in constants.ts, no address in config.yaml | config/handler drift |
| `KEY·REVIEW` (flag) | collectionKey looks like a test fixture (`_e2e`/`_kitchen`/`_test`) | decide the real key before score-api binds (exact-string join) |

## Why this exists — the disease it kills

This pipeline's recurring failure is **completion signals decoupled from data truth**: an order reads
`fulfilled` (score-api #111), a community reads `active` (#409, #413), a collection sits in `config.yaml`
— yet the belt has **0 holders** for it. Consumers that trust config/order state advertise collections
that can't be rendered. The oracle makes the real per-collection state legible so "done" can't lie.

## Structural state (2026-07-06, post-reindex)

**EVM ramp (10) = Azuki (chain 1) + 8 Base batch-1 (chain 8453) + 1 deferred pair. STATUS: DARK — NOT ready.**
- **All 9 ramp collections = `MISSING ⚠` at head** (Azuki + all 8 Base): 0 holders / 0 actions. The
  pre-existing collections (OP lore, Berachain, Puru-1155, HoneyJar, Milady) index fine.
- **Root cause (#120, PROVEN — corrected 2026-07-07): a deploy-branch mismatch, NOT an envio bug.**
  `belt-indexer-selfhost` deploys from branch `feat/envio-321-port` @ `68d88cdcff` (2026-06-23, diverged
  from `main`, 750 commits behind). That commit's `config.yaml` has Milady but NOT Azuki (#119) or the
  Base batch (#124) — those merged to `main` only. **The community collections were never in the running
  config**, so they were never indexed. On-chain cross-check confirmed the collections are real + active
  (based_onchain_punks: 10k supply, 343 standard Transfers) — pure config-absence.
- Earlier "envio doesn't fetch a network added to a multi-network contract" theory (and a dedicated-
  per-chain-contract code fix) was WRONG and reverted — the shared `TrackedErc721` on `main` is correct
  and will index once the config actually reaches the deploy branch (OP/Bera prove it works).
- Fix = operator branch-topology decision (repoint belt to `main`, or merge/cherry-pick #119+#124 onto
  `feat/envio-321-port`) + reindex. Filed: `sprint-bug-192` / `bd-yd6a` / `grimoires/loa/a2a/bug-20260706-i120-10b99d/`.

**SVM ramp (10) = pythians + 9 registry batch-1** (owned by the Solana / BOEHM deep-history track).
- `READY`: pythians, mad_lads.
- `NOT·BACKFILLED`: the other 7 classic-SPL collections — these need the self-hosted deep-history lane
  (the `svm-deep-history-spike` PRD / BOEHM economics). smb_gen2's reconcile is `failed` (Helius quota,
  score-api #122). This is the active Solana workstream, not an EVM regression.

## Follow-ups before / during the full sync
1. **EVM ramp fix (#120, HIGH — deploy-branch reconciliation, NOT a code change)** — `sprint-bug-192`:
   get `main`'s community config (already correct under shared `TrackedErc721`) onto the belt's deploy
   branch `feat/envio-321-port` (repoint / merge / cherry-pick — operator call), then a full `--restart`.
   Then the ramp flips `{MISSING:9}` → `{READY:9}`. Gotcha: a Railway variable-toggle rebuilds from the
   git deploy branch, so `railway up` of a local fix is discarded — deploy via the branch.
2. **collectionKey decision (score-api #382)** — score-api joins `category_key === collectionKey` on the
   EXACT string. `azuki_kitchen_e2e` is a fixture-shaped key; decide `azuki_kitchen_e2e → azuki`
   (rename/alias) BEFORE promoting Azuki to a real community, or the sync yields 0 events even once
   indexing works. The oracle flags this as `KEY·REVIEW`.
3. **SVM 7** — tracked by the Solana deep-history track (BOEHM). Not an EVM concern.
4. **Readiness gate for score-api** — before scoring a community, gate on the oracle verdict `READY`
   (or `chain_metadata` caught-up + `TrackedHolder count > 0`), not on order/community status. This is
   the durable answer to score-api #121 Q2/Q4 (backfill-complete + lag signal).
