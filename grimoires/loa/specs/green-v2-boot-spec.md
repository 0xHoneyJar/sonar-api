# green-v2 fresh-green-boot — runbook

**Goal:** unfreeze the 4 RLAI-confirmed silent gaps (`mint_event`/GeneralMints → Ruggy NATS · `bgt_boost_event` · `badge_holder`+`amount`+`balance` → cubquests · `candies_backing`+`inventory`+`order` → Score) by re-cutting the green ponder onto the branch code (which now has all 4 forward handlers + henlo + mirror). The four handlers exist + are FAGAN-approved (PR #49, commit `d2a45381`); they only go LIVE on a fresh boot (build_id rotates — ponder can't hot-add to the running green).

**Pattern:** blue-green-v2. Stand up a NEW indexer (`belt-indexer-green-v2`) on a NEW schema (`ponder_v2`) on the SAME Postgres-vRR1, ALONGSIDE the current green (which keeps serving `ponder.*` the whole time). Import + backfill + validate green-v2, then repoint belt-hasura-green's tracked schema `ponder` → `ponder_v2`. Current green (`ponder.*`) + blue stay HOT as failback; rollback = repoint belt-hasura-green back to `ponder`.

**Division of labor:** [OPERATOR] deploys green-v2 (Step 1 — you have the Railway access + secrets). [ME] drives import + backfill + validation (Steps 2-3). [OPERATOR+ME] the sacred repoint (Step 4).

---

## Step 1 — [OPERATOR] deploy `belt-indexer-green-v2`

Create a new Railway service `belt-indexer-green-v2` in the `freeside-sonar` project, building the **branch** `spike/b-1-green-belt-mapping` (commit `d2a45381`, PR #49) via `Dockerfile.belt-ponder`.

**Env — copy ALL of `belt-indexer-green`'s vars, then change exactly TWO:**
| var | value | note |
|---|---|---|
| `DATABASE_SCHEMA` | **`ponder_v2`** | was `ponder` — the fresh schema green-v2 owns (build_id) |
| `BELT_CONFIG` | **`ponder.config.ts`** | was `ponder.config.mibera.ts` — the green-belt full config (40 Mibera + 4 gap contracts + Mirror) |

**Keep identical (copy from belt-indexer-green):** `DATABASE_URL` (same vRR1 — isolated by the schema), `PONDER_RPC_URL_{1,10,8453,80094}`, `NATS_URL`, `SONAR_SIGNING_SEED_HEX`, `NATS_TLS_CA/CLIENT_CERT/CLIENT_KEY` (← same signing identity so Ruggy's JWKS-verify accepts green-v2's envelopes), `NODE_OPTIONS`, `TUI_OFF`, `ENVIO_*`. **Do NOT copy** the `RAILWAY_*` vars (Railway injects those per-service).

**Build args** (Dockerfile.belt-ponder): set `BELT_CONFIG=ponder.config.ts` (build arg too, not just env) and bump `CACHE_BUST` to force a fresh build. `PONDER_ROOT=ponder-runtime` (default — leave).

**What to expect on boot:** green-v2 empty-boots → creates the **54 tables in `ponder_v2`** + `_ponder_meta` + a fresh `build_id` → starts **cold-syncing forward from the per-chain boundaries** (eth 25,184,952 · base 46,537,425 · bera 21,424,739 · op 152,132,110). **This cold-sync IS the gap backfill** (the 4 gap contracts have startBlock=boundary → forward-indexing re-creates the boundary→head window). It will take **time + eRPC budget** (~105k bera blocks + the other chains) — not instant. It will NOT spam NATS during catch-up (`isLiveEvent` suppresses historical/cold-sync emits — the no-DDOS gate).

**Then ping me** with green-v2 up. I'll confirm `ponder_v2` has the 54 tables + take over.

---

## Step 2 — [ME] frozen-import below-boundary + monitor backfill
Run the proven transform (`scripts/migration/transform.ts`, `--dst-schema ponder_v2`) to frozen-import the below-boundary history (the 5.14M Mibera + henlo + mirror + the 4 gap entities' pre-boundary rows) into `ponder_v2` — triggers-off, idempotent, exactly the Sprint-M T-M2 path. Below-boundary = frozen; above-boundary = green-v2's live cold-sync (Step 1). Monitor the cold-sync until green-v2 reaches head on all 4 chains (`_ponder_meta.is_ready=1`).

## Step 3 — [ME] validate (the gate, RLAI-graded)
- **count + checksum parity** vs blue/source for the 40 Mibera + henlo + mirror.
- **gaps advanced**: `ponder_v2.{mint_event,bgt_boost_event,badge_holder,candies_backing}` have rows AT/AFTER the boundary block (proving the backfill worked) — vs the frozen `ponder.*`.
- **Ruggy live-mint test**: a live GeneralMints (shadow/gif) mint → `pending_emits` row → `OutboxFlushBera` → NATS envelope (byte-parity already verified). Await one or coordinate a test mint.
- **Score/cubquests resume**: confirm their belt reads of `candies_backing`/`badge_holder` return post-boundary data via green-v2.
- Each verdict appended to the RLAI ledger (`cohort: green-v2-boot`).

## Step 4 — [OPERATOR + ME, SACRED] repoint + cut over
- Re-track belt-hasura-green metadata: schema `ponder` → `ponder_v2` (`cutover-hasura-tracking.sh`).
- **RE-APPLY the field-name parity** (the camelCase consumer contract): the 223 `column_config` aliases for the 40 Mibera + the henlo (8) + mirror (2) aliases, on the `ponder_v2`-tracked tables (same bulk `pg_set_table_customization` as the Mibera cutover). Without this, consumers regress to snake_case again.
- The gateway already points at belt-hasura-green → repointing its tracked schema cuts all consumers over to green-v2. **Keep green-v1 (`ponder.*`) + blue HOT as failback.**
- **Auto-rollback**: any AC fail / 5xx / divergence → re-track belt-hasura-green back to `ponder` (green-v1), instant.
- After the repoint: **restart Ruggy's bot once** (in-mem prevHashStore, `initialPrevHashPolicy:any`) so it accepts green-v2's first envelope.

---

## ⚠️ Caveats (flagged, not blockers)
1. **Cold-sync cost/time** — green-v2 re-syncs boundary→head (hours + eRPC budget). The bridge means no time pressure (green-v1 keeps serving).
2. **NATS double-emit overlap** — once green-v2 reaches head, both green-v1 and green-v2 emit to NATS with the SAME signing seed (independent chain tips) until the repoint + bot restart. Keep the at-head→repoint window short; the bot restart (`initialPrevHashPolicy:any`) resolves the chain. (This is the §7 Redis-PrevHashStore concern — durability backlog.)
3. **Missed-mint announcements are NOT re-fired** — the backfill writes the missed shadow/gif mints (tokens ~3242-3245) to `mint_event` (queryable), but they're historical → `isLiveEvent` suppresses their NATS emit. Only FUTURE live mints announce. (Re-announcing the missed ones would need a manual backfill-emit — risky; recommend not.)
4. **Partial green-belt** — green-v2 brings `mirror` live (bonus) + `henlo` dormant (no Bera TrackedErc20 reg yet). The un-ported green-belt entities (validator/apdao/etc.) aren't served — but they have no correct serving today either, so no regression. The full green belt lands on a later boot (or fold into this one if we complete it first).
