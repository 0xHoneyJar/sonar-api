import assert from "node:assert/strict";
import test from "node:test";

import { summarizeProgress } from "./summarize-progress.mjs";

function sample(index, values) {
  return {
    observed_at: new Date(1_700_000_000_000 + index * 10_000).toISOString(),
    chains: [
      {
        chain_id: 1,
        start_block: 100,
        processed: values.processed,
        fetched: values.fetched,
        head: values.head,
        lag_blocks: values.head - values.processed,
        fetch_ahead: values.fetched - values.processed,
        rates:
          index === 0
            ? {}
            : {
                processed_bps: values.processedBps,
                fetched_bps: values.fetchedBps,
                events_per_sec: values.eventsPerSec,
                head_bps: values.headBps,
              },
        stall_class: values.stallClass ?? "CATCHUP",
      },
    ],
  };
}

test("summarizes bursty progress without mistaking zero-rate samples for resets", () => {
  const summary = summarizeProgress(
    [
      sample(0, { processed: 100, fetched: 110, head: 1_000 }),
      sample(1, {
        processed: 100,
        fetched: 110,
        head: 1_001,
        processedBps: 0,
        fetchedBps: 0,
        eventsPerSec: 0,
        headBps: 0.1,
        stallClass: "FULL_STALL",
      }),
      sample(2, {
        processed: 300,
        fetched: 320,
        head: 1_002,
        processedBps: 20,
        fetchedBps: 21,
        eventsPerSec: 2,
        headBps: 0.1,
      }),
    ],
    { expectedStartBlock: 100, tipLagBlocks: 500 },
  );

  assert.equal(summary.samples, 3);
  assert.equal(summary.processed_bps.p50, 10);
  assert.equal(summary.processed_bps.window_average, 10);
  assert.equal(summary.progress_interval_seconds.p95, 20);
  assert.equal(summary.invariants.sensor_ok, true);
  assert.equal(summary.invariants.processed_monotonic, true);
  assert.equal(summary.tip_follow, false);
});

test("surfaces start-block drift and processed regression", () => {
  const samples = [
    sample(0, { processed: 300, fetched: 320, head: 1_000 }),
    sample(1, {
      processed: 200,
      fetched: 330,
      head: 1_001,
      processedBps: -10,
      fetchedBps: 1,
      eventsPerSec: 0,
      headBps: 0.1,
    }),
  ];
  samples[1].chains[0].start_block = 101;

  const summary = summarizeProgress(samples, { expectedStartBlock: 100 });
  assert.equal(summary.invariants.start_block_ok, false);
  assert.equal(summary.invariants.processed_monotonic, false);
  assert.equal(summary.invariants.sensor_ok, false);
});
