#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function summarizeProgress(samples, options = {}) {
  const chainId = Number(options.chainId ?? 1);
  const expectedStartBlock =
    options.expectedStartBlock === undefined
      ? undefined
      : Number(options.expectedStartBlock);
  const tipLagBlocks = Number(options.tipLagBlocks ?? 500);
  const chainSamples = samples.map((sample, index) => {
    const chain = sample.chains?.find((row) => Number(row.chain_id) === chainId);
    if (!chain) {
      throw new Error(`sample ${index} has no chain_id ${chainId}`);
    }
    return { observedAt: sample.observed_at, ...chain };
  });

  if (chainSamples.length < 2) {
    throw new Error("at least two samples are required");
  }

  const first = chainSamples[0];
  const last = chainSamples.at(-1);
  const durationSeconds =
    (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("sample timestamps do not form a positive duration");
  }

  const rateRows = chainSamples.slice(1).map((row) => row.rates ?? {});
  const processedRates = rateRows.map((row) => Number(row.processed_bps));
  const fetchedRates = rateRows.map((row) => Number(row.fetched_bps));
  const eventRates = rateRows.map((row) => Number(row.events_per_sec));
  const headRates = rateRows.map((row) => Number(row.head_bps));
  const progressTimes = chainSamples
    .filter(
      (row, index) =>
        index === 0 || Number(row.processed) > Number(chainSamples[index - 1].processed),
    )
    .map((row) => Date.parse(row.observedAt) / 1000);
  const progressIntervals = progressTimes
    .slice(1)
    .map((value, index) => value - progressTimes[index]);

  const processedDelta = Number(last.processed) - Number(first.processed);
  const fetchedDelta = Number(last.fetched) - Number(first.fetched);
  const headDelta = Number(last.head) - Number(first.head);
  const processedAverage = processedDelta / durationSeconds;
  const headAverage = headDelta / durationSeconds;
  const netCatchupAverage = processedAverage - headAverage;

  const startBlockValues = [
    ...new Set(chainSamples.map((row) => Number(row.start_block))),
  ];
  const processedRegressions = chainSamples
    .slice(1)
    .filter(
      (row, index) =>
        Number(row.processed) < Number(chainSamples[index].processed),
    ).length;
  const fetchedRegressions = chainSamples
    .slice(1)
    .filter(
      (row, index) => Number(row.fetched) < Number(chainSamples[index].fetched),
    ).length;
  const sensorResets = rateRows.filter(
    (row) =>
      Number(row.processed_bps) < 0 ||
      Number(row.fetched_bps) < 0 ||
      Number(row.events_per_sec) < 0,
  ).length;

  const summary = {
    schema_version: 1,
    mission: "mission-01-progress-heartbeat",
    chain_id: chainId,
    sampled_at: {
      first: first.observedAt,
      last: last.observedAt,
      duration_seconds: durationSeconds,
    },
    samples: chainSamples.length,
    rate_samples: rateRows.length,
    start_block_values: startBlockValues,
    first: {
      processed: Number(first.processed),
      fetched: Number(first.fetched),
      head: Number(first.head),
      lag_blocks: Number(first.lag_blocks),
    },
    last: {
      processed: Number(last.processed),
      fetched: Number(last.fetched),
      head: Number(last.head),
      lag_blocks: Number(last.lag_blocks),
      fetch_ahead: Number(last.fetch_ahead),
      stall_class: last.stall_class,
    },
    deltas: {
      processed_blocks: processedDelta,
      fetched_blocks: fetchedDelta,
      head_blocks: headDelta,
      lag_reduction_blocks:
        Number(first.lag_blocks) - Number(last.lag_blocks),
    },
    processed_bps: {
      p50: quantile(processedRates, 0.5),
      p95: quantile(processedRates, 0.95),
      window_average: processedAverage,
    },
    fetched_bps: {
      p50: quantile(fetchedRates, 0.5),
      p95: quantile(fetchedRates, 0.95),
      window_average: fetchedDelta / durationSeconds,
    },
    events_per_sec: {
      p50: quantile(eventRates, 0.5),
      p95: quantile(eventRates, 0.95),
    },
    head_bps: {
      p50: quantile(headRates, 0.5),
      p95: quantile(headRates, 0.95),
      window_average: headAverage,
    },
    progress_interval_seconds: {
      p50: quantile(progressIntervals, 0.5),
      p95: quantile(progressIntervals, 0.95),
    },
    stall_class_counts: countBy(
      chainSamples.map((row) => row.stall_class ?? "UNKNOWN"),
    ),
    tip_follow_threshold_blocks: tipLagBlocks,
    tip_follow: Number(last.lag_blocks) <= tipLagBlocks,
    eta_seconds_at_window_average:
      netCatchupAverage > 0
        ? Number(last.lag_blocks) / netCatchupAverage
        : null,
    invariants: {
      expected_start_block: expectedStartBlock ?? null,
      start_block_ok:
        expectedStartBlock === undefined ||
        startBlockValues.every((value) => value === expectedStartBlock),
      processed_monotonic: processedRegressions === 0,
      fetched_monotonic: fetchedRegressions === 0,
      sensor_resets: sensorResets,
      sensor_ok: sensorResets === 0,
      state_mutation: "none",
    },
  };

  return summary;
}

function parseArgs(args) {
  const options = {};
  let input;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--chain-id") options.chainId = Number(args[++index]);
    else if (arg === "--expected-start-block") {
      options.expectedStartBlock = Number(args[++index]);
    } else if (arg === "--tip-lag-blocks") {
      options.tipLagBlocks = Number(args[++index]);
    } else if (!input) input = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!input) {
    throw new Error(
      "usage: summarize-progress.mjs <samples.ndjson> [--chain-id N] [--expected-start-block N] [--tip-lag-blocks N]",
    );
  }
  return { input, options };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { input, options } = parseArgs(process.argv.slice(2));
    const samples = readFileSync(input, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`invalid JSON at line ${index + 1}: ${error.message}`);
        }
      });
    const summary = summarizeProgress(samples, options);
    console.log(JSON.stringify(summary, null, 2));
    if (
      !summary.invariants.start_block_ok ||
      !summary.invariants.processed_monotonic ||
      !summary.invariants.fetched_monotonic ||
      !summary.invariants.sensor_ok
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`summarize-progress: ${error.message}`);
    process.exitCode = 1;
  }
}
