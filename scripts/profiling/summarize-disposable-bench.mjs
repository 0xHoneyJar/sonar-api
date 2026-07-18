#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const output = process.argv[2];
if (!output) {
  throw new Error("usage: summarize-disposable-bench.mjs OUTPUT_JSON");
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function json(path) {
  return JSON.parse(read(path));
}

function sha256(path) {
  return createHash("sha256").update(read(path)).digest("hex");
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function time(path) {
  const contents = read(path);
  const value = (label) => {
    const match = contents.match(new RegExp(`^${label} ([0-9.]+)$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const rss = contents.match(/^\s*(\d+)\s+maximum resident set size$/m);
  const real = value("real");
  const user = value("user");
  const system = value("sys");
  return {
    real_seconds: real,
    user_seconds: user,
    sys_seconds: system,
    cpu_percent:
      real && user !== null && system !== null
        ? rounded(((user + system) / real) * 100)
        : null,
    max_rss_bytes: rss ? Number(rss[1]) : null,
  };
}

function run(prefix) {
  const timing = time(`${prefix}.time`);
  const progress = json(`${prefix}-progress.json`);
  const ethereum = progress.find((row) => Number(row.chain_id) === 1);
  const events = progress.reduce(
    (sum, row) => sum + Number(row.num_events_processed),
    0,
  );
  return {
    ...timing,
    ethereum_window_blocks:
      Number(ethereum.latest_processed_block) - Number(ethereum.start_block),
    ethereum_processed_bps: rounded(
      (Number(ethereum.latest_processed_block) -
        Number(ethereum.start_block)) /
        timing.real_seconds,
    ),
    ethereum_fetched_bps: rounded(
      (Number(ethereum.latest_fetched_block_number) -
        Number(ethereum.start_block)) /
        timing.real_seconds,
    ),
    total_events: events,
    events_per_second: rounded(events / timing.real_seconds),
    wal_bytes: Number(json(`${prefix}-wal-after.json`).bytes),
    ...json(`${prefix}-metrics.json`),
  };
}

function repeated(profile) {
  const prefixes = [
    `.run/evidence/mission-03-${profile}`,
    ...[2, 3, 4, 5].map(
      (runNumber) => `.run/evidence/mission-03-${profile}-r${runNumber}`,
    ),
  ];
  const runs = prefixes.map(run);
  const stat = (field, probability) =>
    rounded(quantile(runs.map((item) => Number(item[field])), probability));
  const rssRuns = runs.filter((item) => item.max_rss_bytes !== null);
  return {
    sample_count: runs.length,
    runs,
    wall_seconds_p50: stat("real_seconds", 0.5),
    wall_seconds_p95: stat("real_seconds", 0.95),
    processed_bps_p50: stat("ethereum_processed_bps", 0.5),
    processed_bps_p95: stat("ethereum_processed_bps", 0.95),
    fetched_bps_p50: stat("ethereum_fetched_bps", 0.5),
    fetched_bps_p95: stat("ethereum_fetched_bps", 0.95),
    events_per_second_p50: stat("events_per_second", 0.5),
    wal_bytes_p50: stat("wal_bytes", 0.5),
    wal_bytes_p95: stat("wal_bytes", 0.95),
    cpu_percent_p50: stat("cpu_percent", 0.5),
    rss_sample_count: rssRuns.length,
    max_rss_bytes_p50: rounded(
      quantile(rssRuns.map((item) => item.max_rss_bytes), 0.5),
    ),
    max_rss_bytes_p95: rounded(
      quantile(rssRuns.map((item) => item.max_rss_bytes), 0.95),
    ),
  };
}

const isolated = repeated("w1");
const multichain = repeated("multichain");
const w1Hashes = read(".run/evidence/mission-03-hashes-w1-v2.ndjson");
const multichainHashes = read(
  ".run/evidence/mission-03-hashes-multichain-v2.ndjson",
);
const isolatedSpeedup =
  isolated.processed_bps_p50 / multichain.processed_bps_p50;

const summary = {
  mission: "eth_isolation",
  generated_at: new Date().toISOString(),
  infrastructure: {
    railway_environment: "ops-idx-bench-20260718",
    railway_environment_id: "87e72a1f-947b-40ff-8625-16485e2ceec9",
    postgres_service_id: "0722bc35-66b1-419d-8b1b-dcdecb4159a1",
    production_database_used: false,
    writer_boundary: "one sequential writer per fresh bench_* schema",
  },
  block_window: { start: 25548950, end: 25558950, blocks: 10000 },
  contracts: {
    source: "config.yaml intersect floor-registry.w1.json non-blocked",
    ethereum_eligible_count: 13,
    isolated_config_sha256: sha256(".run/evidence/config.bench.w1.yaml"),
    multichain_config_sha256: sha256(
      ".run/evidence/config.bench.multichain.yaml",
    ),
  },
  measurement_method: {
    rate:
      "terminal fixed-window blocks divided by wall time across five fresh schemas; fetched and processed are equal because every run reached the fixed end block",
    p50_p95: "R-7 linear interpolation across five alternating runs",
    rss:
      "macOS /usr/bin/time -lp; four samples because the initial run predated RSS capture",
    wal: "pg_wal_lsn_diff before and after each sequential run",
  },
  matrix: {
    quiet_fixture: run(".run/evidence/mission-03-quiet-final"),
    w1_ethereum_only: isolated,
    w1_plus_high_volume_seaport: run(
      ".run/evidence/mission-03-control-final",
    ),
    multichain_equivalent_window: multichain,
  },
  parity: {
    ownership_hash_equal: w1Hashes === multichainHashes,
    contracts_compared: w1Hashes.trim().split("\n").length,
    isolated_hash_file_sha256: sha256(
      ".run/evidence/mission-03-hashes-w1-v2.ndjson",
    ),
    multichain_hash_file_sha256: sha256(
      ".run/evidence/mission-03-hashes-multichain-v2.ndjson",
    ),
  },
  decision: {
    required_isolated_speedup: 1.5,
    observed_isolated_speedup: rounded(isolatedSpeedup, 3),
    shard_pilot: false,
    verdict:
      "falsified: isolated Ethereum was not faster and did not meet the 1.5x bar",
    incremental_service_cost:
      "not incurred; a pilot would add one always-on writer service and a separate database/schema boundary",
    read_unification_work:
      "not incurred; a pilot would require gateway union of eth-ownership and noneth read models",
  },
};

writeFileSync(resolve(root, output), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`wrote ${output}`);
