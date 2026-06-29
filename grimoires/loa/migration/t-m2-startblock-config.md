# T-M2 — Ponder `startBlock` config edits (documented patch)

**Cycle**: `sonar-ponder-migration-v1` · **Task**: T-M2 (config artifact) · **Status**: documented patch — apply in the operator-paired PROD session, NOT in this branch
**Authored**: 2026-05-28 · **Branch**: `spike/t-m2-transform`
**Target file**: `ponder.config.mibera.ts` (repo-root canonical; `ponder-runtime/ponder.config.mibera.ts` re-exports it — edit the root only)
**Grounded against**: `ponder.config.mibera.ts` (current per-contract startBlocks), `ponder-runtime/src/handlers/**` (which entity each contract's events write), `grimoires/loa/migration/t-m1-entity-column-map.yaml` (per-entity classification + start_block_policy), migration spec §4 + Appendix B/C.

---

## 0. Why this is a SEPARATE artifact (not a row-load concern)

The `startBlock` is a **ponder.config** concern — it tells the live-forward indexer where to *begin re-indexing from chain*. It is NOT part of the row transform (`transform.ts` only loads frozen history; it never edits config). Per the mission, this is delivered as a **documented diff the operator applies in the prod session**, because applying it here is non-trivial (it interacts with the empty-boot/`build_id` finality coupling — see §4) and must be done in lockstep with the empty-boot, in the same session as the live cutover prep.

---

## 1. The boundary → startBlock rule (the load-bearing decision)

Two facts collide:

- **Boundaries are per-CHAIN** (envio `chain_metadata.latest_processed_block`, verified this session):
  `eth = 25,184,952 · base = 46,537,425 · berachain = 21,424,739 · optimism = 152,132,710`
- **`startBlock` is per-CONTRACT** in `ponder.config.mibera.ts`.

A single contract's event stream feeds MULTIPLE entities (e.g. `MiberaCollection:Transfer` writes `mibera_transfer` append-only AND `tracked_holder` additive-rollup). The T-M0 Appendix B finding-3 double-count rule is per-ENTITY:

- **append-only** (`onConflictDoNothing`) → overlap-safe → `boundary − finalityOverlap`.
- **additive-rollup / rollup-lww** (`onConflictDoUpdate` / read-modify-write) → overlap re-applies increments already in envio's frozen totals → **`boundary` EXACTLY (no overlap)**.

**Therefore the per-contract `startBlock` must take the CONSERVATIVE value:**

> A contract's `startBlock` may be `boundary − finalityOverlap` **only if EVERY entity its events write is append-only**. If it writes **any** additive-rollup or rollup-lww entity, its `startBlock` MUST be `boundary` EXACTLY — otherwise the overlap re-index double-counts that rollup.

This is the safe reduction: a contract is "append-only-safe" iff the intersection of its written-entities with the rollup set is empty.

`finalityOverlap` is a small per-chain margin (the spec leaves the exact value to T-M2; recommended below). The OUTPUT of this artifact is concrete `startBlock` integers per contract — the operator substitutes the chosen overlap.

---

## 2. Recommended `finalityOverlap` per chain

`finalityOverlap` exists to (a) close the "envio captured an unfinalized block that later reorged" gap and (b) give T-M3 its overlap diff window. It only applies to append-only-safe contracts.

| Chain | Boundary | Recommended overlap (blocks) | Rationale |
|---|---|---|---|
| ethereum (1) | 25,184,952 | 64 | ~2 epochs (~13 min) — comfortably past finality |
| base (8453) | 46,537,425 | 600 | ~20 min at ~2s blocks |
| berachain (80094) | 21,424,739 | 600 | ~20 min at ~2s blocks |
| optimism (10) | 152,132,710 | 600 | ~20 min at ~2s blocks |

These are conservative defaults; the operator MAY tighten/loosen. The values below in §3 are computed with these.

---

## 3. Per-contract startBlock decisions (the patch)

Each registered contract, the entities its events write (from `ponder-runtime/src/handlers/**`), whether any is a rollup, and the resulting `startBlock`.

| Contract | Chain | Writes entities | Any rollup? | Policy | `startBlock` (with §2 overlap) | Current value |
|---|---|---|---|---|---|---|
| `MiberaLiquidBacking` | berachain | mibera_loan(lww), mibera_loan_stats(r), treasury_item(lww), treasury_stats(r), treasury_activity(a), daily_rfv_snapshot(lww) | **YES** | boundary EXACTLY | **21,424,739** | 3,971,122 |
| `MiberaCollection` | berachain | mibera_transfer(a), mint_activity(a), nft_burn(a), nft_burn_stats(r), tracked_holder(r), mibera_staker(r), mibera_staked_token(lww), action(a) | **YES** | boundary EXACTLY | **21,424,739** | 3,837,808 |
| `PaddleFi` | berachain | paddle_supply(a), paddle_supplier(r), paddle_pawn(a), paddle_borrower(r), paddle_liquidation(a), action(a) | **YES** | boundary EXACTLY | **21,424,739** | 5,604,652 |
| `MiberaPremint` | berachain | premint_participation(a), premint_refund(a), premint_phase_stats(r), premint_user(r), action(a) | **YES** | boundary EXACTLY | **21,424,739** | 2,731,326 |
| `AquaberaVaultDirect` | berachain | aquabera_deposit(a), aquabera_withdrawal(a), aquabera_builder(r), aquabera_stats(r) | **YES** | boundary EXACTLY | **21,424,739** | 1,871,321 |
| `FriendtechShares` | base | friendtech_trade(a), friendtech_holder(r), friendtech_subject_stats(r), action(a) | **YES** | boundary EXACTLY | **46,537,425** | 2,430,439 |
| `TrackedErc20` | base | tracked_token_balance(r) | **YES** | boundary EXACTLY | **46,537,425** | 33,657,372 |
| `PuruApiculture1155` | base | erc1155_mint_event(a), tracked_holder(r) | **YES** | boundary EXACTLY | **46,537,425** | 13,803,165 |
| `MiberaSets` | optimism | erc1155_mint_event(a), action(a) | no | boundary − overlap | **152,132,110** (=152,132,710 − 600) | 125,031,052 |
| `MiberaZora1155` | optimism | erc1155_mint_event(a), action(a) | no | boundary − overlap | **152,132,110** | 112,614,910 |
| `MiladyCollection` | ethereum | *(no registered `ponder.on` handler — declared, writes nothing forward)* | n/a | informational | **25,184,952** (set to boundary for consistency) | 13,090,020 |
| `Seaport` | berachain | *(no registered `ponder.on` handler — declared, writes nothing forward)* | n/a | informational | **21,424,739** | 3,837,808 |

`(a)`=append-only · `(r)`=additive-rollup · `(lww)`=rollup-lww-state.

**Observation worth flagging to the operator**: 8 of the 10 entity-writing contracts pin to `boundary` EXACTLY because each touches at least one rollup. Only the two Optimism ERC-1155 contracts (`MiberaSets`, `MiberaZora1155`) are append-only-pure and get the overlap. This means **the T-M3 live-overlap validation window only exists on Optimism** for forward-indexed entities — the boundary-exactly contracts produce ponder-from-chain output starting exactly at the boundary, so their overlap diff is a single-block-boundary check, not a window. (This is the correct tradeoff per Appendix B: a tiny boundary-reorg risk on rollups — already rated LOW in spec §6 — in exchange for avoiding a certain double-count.)

### Block-tick `blocks:` handlers

The 4 `OutboxFlush*` block handlers (`OutboxFlushEth/Base/Bera/Op`) currently anchor at the earliest-contract floor. The outbox flush is a **real-time** concern (drains `pending_emits`); it has no historical sweep need. Set each to its chain boundary so cold-start doesn't replay block ticks across migrated history:

- `OutboxFlushEth.startBlock = 25,184,952`
- `OutboxFlushBase.startBlock = 46,537,425`
- `OutboxFlushBera.startBlock = 21,424,739`
- `OutboxFlushOp.startBlock = 152,132,710 − 600 = 152,132,110` (matches its OP contracts; or boundary exactly — the outbox is idempotent so either is safe).

---

## 4. CRITICAL ordering constraint (Appendix B finding 1 — `build_id` coupling)

The schema must be **frozen final before ponder's first boot**, and a schema change after first boot rotates `build_id` → "different Ponder app" error. **The `startBlock` is config, not schema — it does NOT rotate `build_id`.** But the *sequence* still matters:

1. Apply this config patch to `ponder.config.mibera.ts` **before** the empty-boot.
2. Empty-boot ponder once on the empty `ponder.*` schema (it creates tables + `_ponder_meta` + `_ponder_checkpoint` + fixes `build_id`).
3. Load frozen rows (run `transform.ts` — triggers off).
4. Start ponder normally → it indexes forward from the `startBlock` values above.

Do NOT change `startBlock` between step 2 and step 4 against a populated checkpoint — set it once, here, before boot.

---

## 5. The diff (apply in prod session)

Replace the per-contract `startBlock` integers in `ponder.config.mibera.ts` with the §3 column "`startBlock` (with §2 overlap)" values, and the block-tick floors with §3 "Block-tick" values. Concretely, the constants block at the top is unused for these (they're inline per-contract), so the edits are inline on each `startBlock:` line. Example for the two append-only-pure OP contracts (substitute your chosen overlap):

```diff
   MiberaSets: {
     chain: "optimism",
     abi: Erc1155Abi,
     address: MIBERA_SETS_OP,
-    startBlock: 125031052,
+    startBlock: 152132110,   // boundary(152132710) − finalityOverlap(600); append-only-pure
   },
   MiberaZora1155: {
     chain: "optimism",
     abi: Erc1155Abi,
     address: MIBERA_ZORA_1155_OP,
-    startBlock: OP_START_BLOCK,
+    startBlock: 152132110,   // boundary − overlap; append-only-pure
   },
```

…and for every rollup-touching contract, set `startBlock` to its chain boundary EXACTLY (no overlap), e.g.:

```diff
   MiberaCollection: {
     chain: "berachain",
     abi: Erc721TransferAbi,
     address: MIBERA_COLLECTION,
-    startBlock: 3837808,
+    startBlock: 21424739,    // berachain boundary EXACTLY — writes rollups (tracked_holder, mibera_staker, nft_burn_stats); overlap would double-count
   },
```

(Repeat the boundary-exactly edit for `MiberaLiquidBacking`, `PaddleFi`, `MiberaPremint`, `AquaberaVaultDirect`, `FriendtechShares`, `TrackedErc20`, `PuruApiculture1155`, and the informational `MiladyCollection`/`Seaport`.)
