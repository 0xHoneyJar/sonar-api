# Runbook — SVM / belt contract drift (the assumed-schema antibody)

Referenced by `.github/workflows/belt-contract-guard.yml` on the RED path. Sibling of the
EVM Transfer guard. Doctrine: the wire is the contract; verify it.

## What the guards are
- `scripts/verify-belt-contract.mjs` + `belt-contract.json` — EVM `Transfer` read seam.
- `scripts/verify-svm-contract.mjs` + `svm-contract.json` — SVM `svm_genesis_stone` (live) +
  `svm_collection_nft` (pending-exposure) read seam.
- Both introspect the **live read schema** of `belt-gateway-production` and assert the columns
  consumers depend on (and that the indexers' upserts must surface) still exist with the right type.

## RED (`exit 1` → CI fails): a consumer-depended column drifted/disappeared
Triage, in order:
1. **Confirm the drift is real**, not a transient: re-run `pnpm verify:svm-contract` (or `verify:belt-contract`).
   `exit 2` = endpoint unreachable (transient, not drift). `exit 1` = real drift.
2. **Identify which deploy introduced it.** A schema-affecting change shipped to the gateway/Hasura
   (table re-track, column rename/drop, scalar change). Check recent sonar/Hasura deploys.
3. **Rule out a Hasura scalar rename** (e.g. `bigint`→`numeric`): if the column still exists but the
   scalar name changed, update the `requiredFields` type in the manifest — that is a legitimate
   contract update, not a break.
4. **Decide the fix:**
   - drift is a mistake → fix the producer (restore the column/type) so the live wire matches the contract again.
   - drift is intended → update `scripts/*-contract.json` **and every consumer in lockstep**
     (the loa-freeside `adapters/sonar` consumer; any score/membership reader), then ship together.
5. The downstream that breaks is the loa-freeside shadow-audit's `adapters/sonar` Transfer-replay
   (EVM) and any SVM ownership reader.

## Pending-exposure warning (`exit 0`, loud): a merged pipe's table isn't on the read surface
Current standing case: `svm_collection_nft` (Pythians, PR #76). The merged indexer writes to
`svm.collection_nft`, but that table is absent from the belt-gateway AND the SVM Hasura public
surface — so its data is not consumer-readable. Remediation = the ops step in
`grimoires/loa/specs/2026-06-23-svm-pythians-collection-design.md`: `CREATE TABLE svm.collection_nft`
+ track it in Hasura (+ public select permission). Then promote the type to `status:"live"` in
`svm-contract.json` so future drift hard-fails.

## Scope + known limits (verified 2026-06-24; see `svm-contract.json` `_scope`)
These are **deliberate boundaries**, documented so a green guard is not over-read:
- **Read surface only.** The gateway exposes no `mutation_root`/`*_constraint`/`*_insert_input`.
  The guard catches column/type drift (the loa-freeside#300 class) but **NOT** the write-path
  `on_conflict` **constraint-name** class that bit PR #76 — that name lives in the admin-role
  mutation schema, invisible here.
- **`_invariants_doc` is documentation**, not machine-checked.
- **Null = "not on this read surface"** — cannot distinguish "table absent (upsert 400s)" from
  "table present but admin-only (consumers blind)".
- **Nullability is flattened** — a nullable↔non-null tightening is not detected.

## Follow-ups (from the 2026-06-24 rigorous-review compose pass — not yet built)
Ranked. Capture as beads/sprint work when prioritized:
1. **Offline DDL-bind verifier (per-PR, network-free)** — parse sonar's migration/upsert source and
   assert every contract column **and the declared `on_conflict` constraint name** exist in source.
   This is the real closure of the constraint-name gap (F1/F5/G5) — author-time, deterministic, no flake.
2. **Make the alarm actuate + self-monitor** (F4/G2/G3/K2/K3): escalate `exit 2` to hard-fail after
   K consecutive unreachable runs (battery-dead detection); a heartbeat/dead-man's-switch so a
   *stopped* cron is itself an alarm; an `if: failure()` actuator that opens a tracked issue
   (needs `issues:write`); a post-deploy `workflow_dispatch` trigger to cut the ~24h MTTD.
3. **Helius DAS response-shape canary** (F8/S1) — a SEPARATE example-based antibody (zod/JSON-schema
   over `getAssetsByGroup` for a known mint: owner/delegate/compressed/burnt). Different seam — do NOT
   bolt it onto this GraphQL-introspection guard.
4. **Admin-endpoint constraint check** (F1 option 2) — introspect `<type>_constraint.enumValues` on the
   admin Hasura (CI secret) to assert the expected `on_conflict` constraint names.
5. **Nullability opt-in** (`nonNull: true` per field) + **multi-endpoint matrix** if more consumer
   read-paths than belt-gateway are sanctioned (K4).
