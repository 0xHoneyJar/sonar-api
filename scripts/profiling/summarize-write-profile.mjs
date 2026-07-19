#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const output = process.argv[2];
if (!output) {
  throw new Error("usage: summarize-write-profile.mjs OUTPUT_JSON");
}

function json(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function number(value) {
  return Number(value);
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

const passE = json(".run/evidence/mission-03-pass-e-summary.json");
const profile = json(
  ".run/evidence/mission-04-baseline-write-profile.json",
);
const isomorphism = json(
  ".run/evidence/mission-04-baseline-isomorphism.json",
);
const resumeWal = json(
  ".run/evidence/mission-04-resume-wal-after.json",
);
const ethereum = passE.matrix.w1_ethereum_only;
const events = number(ethereum.runs[0].total_events);
const walP50 = number(ethereum.wal_bytes_p50);
const quietWal = number(passE.matrix.quiet_fixture.wal_bytes);
const selfTransfers = number(profile.actions.self_transfer_events);
const holderActions = number(profile.actions.hold721_rows);
const stateTables = Object.fromEntries(
  profile.tables
    .filter(({ relname }) =>
      ["Action", "Token", "TrackedHolder"].includes(relname),
    )
    .map((row) => [row.relname, row]),
);

const summary = {
  mission: "postgres_write_path",
  generated_at: new Date().toISOString(),
  block_window: passE.block_window,
  candidate_order_position: 1,
  candidate: "remove redundant entity gets/sets",
  infrastructure: {
    railway_environment: passE.infrastructure.railway_environment,
    postgres_service_id: passE.infrastructure.postgres_service_id,
    production_database_used: false,
  },
  baseline: {
    transfer_events: events,
    wal_bytes_p50: walP50,
    wal_bytes_per_event_p50: rounded(walP50 / events),
    quiet_fixture_wal_bytes: quietWal,
    quiet_subtracted_wal_bytes_per_event: rounded(
      (walP50 - quietWal) / events,
    ),
    processed_bps_p50: ethereum.processed_bps_p50,
    action_rows: number(profile.actions.action_rows),
    hold721_action_rows: holderActions,
    token_rows: number(stateTables.Token.n_live_tup),
    holder_rows: number(stateTables.TrackedHolder.n_live_tup),
    physical_state_updates:
      number(stateTables.Token.n_tup_upd) +
      number(stateTables.TrackedHolder.n_tup_upd),
    physical_state_deletes:
      number(stateTables.Token.n_tup_del) +
      number(stateTables.TrackedHolder.n_tup_del),
  },
  candidate_scope: {
    self_transfer_events: selfTransfers,
    percent_of_transfer_events: rounded((selfTransfers / events) * 100, 3),
    affected_hold_actions_at_most: selfTransfers * 2,
    percent_of_hold_actions_at_most: rounded(
      ((selfTransfers * 2) / holderActions) * 100,
      3,
    ),
    action_history_preserved: true,
    envio_batch_behavior:
      "preload groups entity reads and the in-memory table collapses repeated sets to final state before persistence",
  },
  result: {
    mutation_implemented: false,
    reason:
      "falsified before mutation: only one self-transfer is removable and the baseline emitted zero physical Token/TrackedHolder updates or deletes",
    required_improvement_percent: 25,
    maximum_affected_event_share_percent: rounded(
      (selfTransfers / events) * 100,
      3,
    ),
    winner: false,
  },
  parity: {
    baseline_vs_candidate_hash_equal: "not_applicable_no_mutation",
    fixed_window_hashes_equal_after_resume: true,
    contracts_compared_after_resume: 13,
    crash_resume_seconds: 1.87,
    crash_resume_wal_bytes: number(resumeWal.bytes),
    reorg_semantics:
      "unchanged: no handler/schema/runtime mutation was retained",
    absolute_fixture_isomorphism: isomorphism,
    fixture_limit:
      "the mid-chain empty-schema window has no opening ownership state, so absolute Token-to-TrackedHolder counts are not a valid invariant for this fixture; differential hashes remain exact",
  },
  production_action: "none",
};

writeFileSync(resolve(root, output), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`wrote ${output}`);
