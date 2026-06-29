# T-M2 — Dry-run plan for the operator-paired PROD run

**Cycle**: `sonar-ponder-migration-v1` · **Task**: T-M2 (run plan) · **Status**: PLAN — execute in a separate operator-paired session
**Authored**: 2026-05-28 · **Branch**: `spike/t-m2-transform`
**This session did NOT run against prod.** No prod connection was ever opened. This document is the exact ordered runbook for the operator-paired session that does.

**Artifacts referenced**:
- Transform: `scripts/migration/transform.ts` (+ `entity-map.ts`, `pg.ts`)
- startBlock edits: `grimoires/loa/migration/t-m2-startblock-config.md`
- Map (source of truth): `grimoires/loa/migration/t-m1-entity-column-map.yaml`
- Spec: `sonar-ponder-coordinator/grimoires/loa/migration-A-data-migration-spec.md` (§4, §5 T-M2, Appendix B/C)

**Connection contract (sacred)**:
- `SRC_DATABASE_URL` → envio blue **Postgres-3vIC** (READ). `DST_DATABASE_URL` → ponder **Postgres-vRR1** (WRITE).
- Both supplied by the operator at run time. The transform refuses URLs matching `3vic`/`vrr1` unless `TM2_ALLOW_PROD=I_UNDERSTAND` is set (the prod-session opt-in — set it only in the prod session).
- Invocation (tsx is in the pnpm store): `node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs scripts/migration/transform.ts ...`

---

## Step 0 — Pre-flight, READ-ONLY against 3vIC (do FIRST)

Run the dry-run to capture the **source-of-truth per-entity counts** before touching vRR1. This connects READ-ONLY and writes nothing.

```bash
export TM2_ALLOW_PROD=I_UNDERSTAND
export SRC_DATABASE_URL='<3vIC read URL>'
export DST_DATABASE_URL='<vRR1 URL>'   # opened only to assert target tables exist
TSX=node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs
node $TSX scripts/migration/transform.ts --dry-run
```

Independently, run the raw per-entity count queries directly against 3vIC and SAVE them (this is the T-M3 parity baseline):

```sql
-- against Postgres-3vIC (public.* envio tables), for each of the 40 in-scope tables:
SELECT 'BadgeHolder'      AS entity, count(*) FROM public."BadgeHolder"
UNION ALL SELECT 'BadgeAmount',          count(*) FROM public."BadgeAmount"
UNION ALL SELECT 'BadgeBalance',         count(*) FROM public."BadgeBalance"
UNION ALL SELECT 'BgtBoostEvent',        count(*) FROM public."BgtBoostEvent"
UNION ALL SELECT 'CandiesInventory',     count(*) FROM public."CandiesInventory"
UNION ALL SELECT 'CandiesBacking',       count(*) FROM public."CandiesBacking"
UNION ALL SELECT 'DailyRfvSnapshot',     count(*) FROM public."DailyRfvSnapshot"
UNION ALL SELECT 'Erc1155MintEvent',     count(*) FROM public."Erc1155MintEvent"
UNION ALL SELECT 'FriendtechTrade',      count(*) FROM public."FriendtechTrade"
UNION ALL SELECT 'FriendtechHolder',     count(*) FROM public."FriendtechHolder"
UNION ALL SELECT 'FriendtechSubjectStats', count(*) FROM public."FriendtechSubjectStats"
UNION ALL SELECT 'MiberaLoan',           count(*) FROM public."MiberaLoan"
UNION ALL SELECT 'MiberaLoanStats',      count(*) FROM public."MiberaLoanStats"
UNION ALL SELECT 'MiberaOrder',          count(*) FROM public."MiberaOrder"
UNION ALL SELECT 'MiberaStakedToken',    count(*) FROM public."MiberaStakedToken"
UNION ALL SELECT 'MiberaStaker',         count(*) FROM public."MiberaStaker"
UNION ALL SELECT 'MiberaTransfer',       count(*) FROM public."MiberaTransfer"
UNION ALL SELECT 'MintActivity',         count(*) FROM public."MintActivity"
UNION ALL SELECT 'MintEvent',            count(*) FROM public."MintEvent"
UNION ALL SELECT 'NftBurn',              count(*) FROM public."NftBurn"
UNION ALL SELECT 'NftBurnStats',         count(*) FROM public."NftBurnStats"
UNION ALL SELECT 'PaddleSupply',         count(*) FROM public."PaddleSupply"
UNION ALL SELECT 'PaddleSupplier',       count(*) FROM public."PaddleSupplier"
UNION ALL SELECT 'PaddlePawn',           count(*) FROM public."PaddlePawn"
UNION ALL SELECT 'PaddleBorrower',       count(*) FROM public."PaddleBorrower"
UNION ALL SELECT 'PaddleLiquidation',    count(*) FROM public."PaddleLiquidation"
UNION ALL SELECT 'PremintParticipation', count(*) FROM public."PremintParticipation"
UNION ALL SELECT 'PremintRefund',        count(*) FROM public."PremintRefund"
UNION ALL SELECT 'PremintPhaseStats',    count(*) FROM public."PremintPhaseStats"
UNION ALL SELECT 'PremintUser',          count(*) FROM public."PremintUser"
UNION ALL SELECT 'TrackedHolder',        count(*) FROM public."TrackedHolder"
UNION ALL SELECT 'TrackedTokenBalance',  count(*) FROM public."TrackedTokenBalance"
UNION ALL SELECT 'TreasuryItem',         count(*) FROM public."TreasuryItem"
UNION ALL SELECT 'TreasuryActivity',     count(*) FROM public."TreasuryActivity"
UNION ALL SELECT 'TreasuryStats',        count(*) FROM public."TreasuryStats"
UNION ALL SELECT 'AquaberaDeposit',      count(*) FROM public."AquaberaDeposit"
UNION ALL SELECT 'AquaberaWithdrawal',   count(*) FROM public."AquaberaWithdrawal"
UNION ALL SELECT 'AquaberaBuilder',      count(*) FROM public."AquaberaBuilder"
UNION ALL SELECT 'AquaberaStats',        count(*) FROM public."AquaberaStats"
UNION ALL SELECT 'Action',               count(*) FROM public."Action";
```

Sanity-check the dry-run counts against these (they read the same tables). Expect ~5M rows total; the four big ones: `Action`~2.4M, `BgtBoostEvent`~1.47M, `BadgeAmount`/`BadgeBalance`~435k each.

**SKIP** envio-internal tables `Block`, `Transaction`, `AggregatedBlock`, `AggregatedTransaction` — the transform never touches them (they're not in the map).

---

## Step 1 — Empty-boot-ponder prerequisite CHECK (Appendix B finding 1)

The transform does NOT create tables and does NOT boot ponder. Before loading, confirm ponder has already booted once on the empty `ponder.*` schema on vRR1 (it owns the DDL + `_ponder_meta` + `_ponder_checkpoint` + a fixed `build_id`).

1. Apply the `startBlock` config edits NOW (`t-m2-startblock-config.md` §5) — schema/config must be frozen final **before** boot, because a post-boot schema change rotates `build_id` → "different Ponder app" error.
2. Boot ponder once on empty vRR1 (`DATABASE_SCHEMA=ponder ponder start --root ponder-runtime`). Let it create tables; it's fine for it to begin forward-indexing.
3. Verify the prerequisite: the transform's preflight asserts every target table exists and HARD-ERRORS listing any missing table. A clean (no-error) dry-run from Step 0 already proves all 40 `ponder.*` tables exist.

Entry-condition cross-check (spec §3): `ponder.*` should be 42 user tables (40 in-scope + `pending_emits` + `dead_letter_emits`), empty + ready.

---

## Step 2 — Batching / order (large tables, off-peak)

Run off-peak (the bridge means no time pressure — spec §3/§6). The transform keyset-paginates every table on its text PK `id` (`WHERE id > $cursor ORDER BY id LIMIT $batch`), so memory is bounded regardless of table size. Default batch 5000.

Recommended order: let the transform run all 40 in its map order (largest-first is fine; each entity is independent). For the very large tables, optionally raise batch and run them isolated to watch progress:

```bash
# Big tables first, isolated, larger batch:
node $TSX scripts/migration/transform.ts --only action          --batch 10000
node $TSX scripts/migration/transform.ts --only bgt_boost_event --batch 10000
node $TSX scripts/migration/transform.ts --only badge_amount,badge_balance --batch 10000
# Then everything else:
node $TSX scripts/migration/transform.ts --batch 5000   # idempotent — re-loads the big ones as no-ops
```

Or simply one shot: `node $TSX scripts/migration/transform.ts --batch 5000` (loads all 40).

---

## Step 3 — Trigger disable → load → enable (Appendix B finding 2)

This is automatic and per-entity inside the transform — no manual step. For each table it:
1. `ALTER TABLE ponder.<t> DISABLE TRIGGER USER` (suppresses ponder's `reorg` + `live_query` triggers; the `live_query` trigger otherwise makes an external INSERT FAIL outright, and `reorg` would make frozen rows reorg-revertable).
2. Keyset-batched `INSERT ... ON CONFLICT (id) DO UPDATE`.
3. `ALTER TABLE ponder.<t> ENABLE TRIGGER USER` (in a `finally` — re-enabled even on error).

Scratch-validated: load succeeds with triggers off; `tgenabled='O'` (enabled) confirmed on every table afterward. Frozen rows do NOT enter `_reorg__*` (genuinely immutable).

**Watch**: if the transform errors mid-table, its `finally` re-enables that table's triggers; re-running is safe (idempotent UPSERT). Confirm no table is left with `tgenabled='D'`:
```sql
SELECT relname, tgname, tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
WHERE relnamespace='ponder'::regnamespace AND NOT tgisinternal AND tgenabled='D';
-- expect 0 rows
```

---

## Step 4 — The `startBlock` config edits

Applied in Step 1 (before boot). See `t-m2-startblock-config.md` for the per-contract values. Summary: 8 rollup-touching contracts pin to `boundary` EXACTLY; the 2 Optimism append-only-pure ERC-1155 contracts get `boundary − finalityOverlap`. Do NOT change `startBlock` against a populated checkpoint after boot.

---

## Step 5 — Idempotent re-run + rollback

- **Re-run**: the whole transform is safely re-runnable. `ON CONFLICT (id) DO UPDATE` makes a second run byte-identical (scratch-proven: per-table md5 unchanged, no dupes). Use it freely to resume after an interruption.
- **The T-M3 overlap re-write**: when ponder forward-indexes the overlap blocks on the append-only-pure OP contracts, it re-writes those rows; the UPSERT tolerates this (PKs match). Rollup contracts have no overlap (boundary exactly), so no double-count.
- **Rollback (vRR1 is empty now)**: the safe rollback is `TRUNCATE` the loaded `ponder.*` tables and re-run. Because vRR1 starts empty, a truncate + re-load is clean. Trigger-aware truncate:
  ```sql
  -- per table, or scripted across the 40:
  ALTER TABLE ponder."action" DISABLE TRIGGER USER;
  TRUNCATE ponder."action";
  ALTER TABLE ponder."action" ENABLE TRIGGER USER;
  ```
  If ponder has already started forward-indexing into a table, prefer to STOP ponder before truncating, then re-boot after re-load (avoid truncating under a live writer).

---

## Step 6 — Hand-off to T-M3 validation

After the load completes:
1. Per-entity parity: `count(envio 3vIC) == count(ponder vRR1)` for all 40 (Step 0 baseline vs post-load counts) + aggregate checksum (e.g. `md5(string_agg(ordered key cols))`) — spec §5 T-M3.1.
2. Live-overlap diff (spec §5 T-M3.2): on the append-only-pure Optimism contracts, ponder-from-chain output over the overlap window must diff to 0 against the transformed rows. NOTE (from `t-m2-startblock-config.md` §3): the rollup-touching contracts have NO overlap window — their boundary-exactly start means the diff is a single-boundary check, not a window. T-M3 must account for this.
3. 8 no-handler entities (Appendix C open decision) frozen-import fine but ponder will NOT index them forward; T-M3's live-overlap cannot validate them. Their parity is count+checksum only. Operator decision (accept-frozen vs wire-handlers) is a T-M4 gate, not a T-M2/T-M3 blocker.

---

## Appendix — entity-level type-drift the operator should spot-check post-load

These 4 columns are the only non-pure-renames (scratch-validated). Spot-check a few rows after load:
- `ponder.badge_holder.holdings` — a JSON string (e.g. `{"1":"2"}`), parses via `JSON.parse`.
- `ponder.mibera_loan.token_ids`, `ponder.paddle_pawn.nft_ids`, `ponder.paddle_liquidation.nft_ids` — JSON array of STRINGS form `["1","2"]` (NOT pg `{1,2}`). Verify: `SELECT token_ids FROM ponder.mibera_loan LIMIT 5;` — values must start with `[` not `{`.
