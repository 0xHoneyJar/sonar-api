#!/usr/bin/env node
// =============================================================================
// belt-progress.mjs — agent mega-command for Belt sync progression (sense-only).
// =============================================================================
// Read-only observation of Envio chain_metadata (+ optional Kitchen jobs).
// NEVER sets ENVIO_RESTART. NEVER mutates Belt/Kitchen state.
//
// Usage:
//   node scripts/belt-progress.mjs                  # --robot-triage (default)
//   node scripts/belt-progress.mjs --json
//   node scripts/belt-progress.mjs --tile            # GECKO STATUS|SIGNAL|MISMATCH
//   node scripts/belt-progress.mjs capabilities --json
//   node scripts/belt-progress.mjs robot-docs guide
//   node scripts/belt-progress.mjs sample --samples 2 --interval 10 --json
//
// Env:
//   BELT_GRAPHQL_URL   default https://sonar.0xhoneyjar.xyz/v1/graphql
//   TIP_LAG_BLOCKS     tip-follow threshold (default 500)
//   KITCHEN_API_URL    optional; with SERVICE_TOKEN merges GET /v2/indexing-status jobs
//   SERVICE_TOKEN      Kitchen service auth
//   BELT_PROGRESS_NO_TIP_RPC=1  skip independent eth_blockNumber tip check
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const CONTRACT_VERSION = "1.0.0";
const DEFAULT_GRAPHQL = "https://sonar.0xhoneyjar.xyz/v1/graphql";
const TIP_LAG_DEFAULT = 500;

/** Public tip probes — read-only eth_blockNumber. Fail soft per chain. */
const TIP_RPC = {
  1: "https://1rpc.io/eth",
  10: "https://1rpc.io/op",
  8453: "https://1rpc.io/base",
  42161: "https://1rpc.io/arb",
  80094: "https://1rpc.io/bera",
};

const FORBIDDEN = [
  /^--?wipe$/i,
  /^--?envio[-_]?restart(=.*)?$/i,
  /^ENVIO_RESTART=/i,
  /^--restart$/i,
  /^--force-wipe$/i,
];

const TYPO_MAP = {
  "--jsno": "--json",
  "--josn": "--json",
  "--jon": "--json",
  "--capabilites": "capabilities",
  "--robot-trage": "--robot-triage",
  "--robto-triage": "--robot-triage",
  "--tiile": "--tile",
};

const EXIT = {
  OK: 0,
  USAGE: 1,
  SAFETY: 2,
  BLIND: 3,
};

function escapeTileField(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\|/g, " ")
    .trim();
}

function emitTile(status, signal, mismatch) {
  process.stdout.write(
    `${escapeTileField(status)}|${escapeTileField(signal)}|${escapeTileField(mismatch)}\n`,
  );
}

function classifyStall({ head, fetched, processed, rates = {}, tipLagBlocks = TIP_LAG_DEFAULT }) {
  const lag = head - processed;
  const procBps = rates.processed_bps;
  const fetchBps = rates.fetched_bps;
  const headBps = rates.head_bps;
  const eventsPerSec = rates.events_per_sec;

  if (lag <= tipLagBlocks) return "TIP_FOLLOW";
  if (procBps == null || fetchBps == null) return "UNKNOWN";
  if (procBps > 0 && (eventsPerSec || 0) === 0) return "SPARSE_NORMAL";
  if ((headBps || 0) > 0 && fetchBps <= 0 && procBps <= 0) return "FETCH_STALL";
  if (fetchBps > 0 && procBps <= 0) return "PROCESS_STALL";
  if (fetchBps <= 0 && procBps <= 0) return "FULL_STALL";
  return "CATCHUP";
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

async function graphqlChainMetadata(url) {
  const query = {
    query:
      "{ chain_metadata { chain_id start_block block_height latest_processed_block latest_fetched_block_number num_events_processed is_hyper_sync timestamp_caught_up_to_head_or_endblock } }",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`graphql HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data.chain_metadata ?? [];
}

async function tipRpc(chainId) {
  const url = TIP_RPC[chainId];
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.result) return null;
    return Number.parseInt(body.result, 16);
  } catch {
    return null;
  }
}

async function kitchenJobs(baseUrl, token) {
  if (!baseUrl || !token) return null;
  const url = `${baseUrl.replace(/\/$/, "")}/v2/indexing-status`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`kitchen indexing-status HTTP ${res.status}`);
  return res.json();
}

function enrichRow(row, prev, now, tipLagBlocks, tipHeight) {
  const head = Number(row.block_height);
  const processed = Number(row.latest_processed_block);
  const fetched = Number(row.latest_fetched_block_number);
  const events = Number(row.num_events_processed);
  const cid = Number(row.chain_id);
  let rates = {};
  if (prev?.by_id?.[cid]) {
    const dt = Math.max(now - prev.ts, 1e-6);
    const p = prev.by_id[cid];
    rates = {
      processed_bps: (processed - p.processed) / dt,
      fetched_bps: (fetched - p.fetched) / dt,
      events_per_sec: (events - p.events) / dt,
      head_bps: (head - p.head) / dt,
    };
  }
  const lag = head - processed;
  const etaSeconds =
    rates.processed_bps > 0 && lag > tipLagBlocks ? lag / rates.processed_bps : null;
  const stallClass = classifyStall({
    head,
    fetched,
    processed,
    rates: Object.keys(rates).length ? rates : undefined,
    tipLagBlocks,
  });
  return {
    chain_id: cid,
    start_block: row.start_block != null ? Number(row.start_block) : null,
    head,
    tip_rpc: tipHeight,
    tip_delta: tipHeight != null ? tipHeight - head : null,
    processed,
    fetched,
    events,
    hypersync: Boolean(row.is_hyper_sync),
    caught_up_at: row.timestamp_caught_up_to_head_or_endblock ?? null,
    lag_blocks: lag,
    fetch_ahead: fetched - processed,
    rates,
    eta_seconds: etaSeconds,
    eta_human: formatDuration(etaSeconds),
    stall_class: stallClass,
  };
}

async function sampleOnce(args) {
  const {
    graphqlUrl,
    tipLagBlocks,
    tipRpcEnabled,
    prev = null,
  } = args;
  const now = Date.now() / 1000;
  const raw = await graphqlChainMetadata(graphqlUrl);
  const tips = {};
  if (tipRpcEnabled) {
    await Promise.all(
      raw.map(async (r) => {
        const cid = Number(r.chain_id);
        tips[cid] = await tipRpc(cid);
      }),
    );
  }
  const chains = raw
    .map((r) => enrichRow(r, prev, now, tipLagBlocks, tips[Number(r.chain_id)] ?? null))
    .sort((a, b) => a.chain_id - b.chain_id);
  const by_id = Object.fromEntries(
    chains.map((c) => [
      c.chain_id,
      { head: c.head, processed: c.processed, fetched: c.fetched, events: c.events },
    ]),
  );
  return { observed_at: new Date(now * 1000).toISOString(), chains, prev: { ts: now, by_id } };
}

function stallSeverity(chains) {
  const stalls = chains.filter((c) =>
    ["FULL_STALL", "FETCH_STALL", "PROCESS_STALL"].includes(c.stall_class),
  );
  const unknown = chains.filter((c) => c.stall_class === "UNKNOWN");
  const catchup = chains.filter((c) => c.stall_class === "CATCHUP" || c.stall_class === "SPARSE_NORMAL");
  const tip = chains.filter((c) => c.stall_class === "TIP_FOLLOW");
  return { stalls, unknown, catchup, tip };
}

function recommendations(snapshot, jobs) {
  const recs = [];
  const { stalls, unknown } = stallSeverity(snapshot.chains);
  if (stalls.length) {
    recs.push({
      priority: "high",
      title: "Stall class on one or more chains",
      detail: stalls.map((c) => `${c.chain_id}:${c.stall_class}`).join(", "),
      next: [
        "node scripts/belt-progress.mjs sample --samples 6 --interval 10 --json",
        "railway logs -s belt-indexer-selfhost --lines 80",
      ],
      never: ["ENVIO_RESTART=1 (unless KF-013 wipe is explicitly authorized)"],
    });
  }
  if (unknown.length === snapshot.chains.length) {
    recs.push({
      priority: "medium",
      title: "Rates UNKNOWN — take a second sample",
      detail: "Single snapshot cannot classify fetch vs process stall.",
      next: ["node scripts/belt-progress.mjs sample --samples 2 --interval 15 --json"],
    });
  }
  const critical = [...snapshot.chains].sort((a, b) => b.lag_blocks - a.lag_blocks)[0];
  if (critical && critical.stall_class !== "TIP_FOLLOW") {
    recs.push({
      priority: "info",
      title: `Critical path chain ${critical.chain_id}`,
      detail: `lag=${critical.lag_blocks} eta=${critical.eta_human ?? "n/a"} class=${critical.stall_class}`,
      next: [`node scripts/belt-progress.mjs --json | jq '.chains[] | select(.chain_id==${critical.chain_id})'`],
    });
  }
  if (jobs?.jobs?.by_status) {
    const q = jobs.jobs.by_status.queued ?? 0;
    const ix = jobs.jobs.by_status.indexing ?? 0;
    if (q + ix > 0) {
      recs.push({
        priority: "info",
        title: "Kitchen preparation jobs active",
        detail: `queued=${q} indexing=${ix}`,
        next: ["GET /v2/indexing-status (service token)"],
      });
    }
  }
  if (!recs.length) {
    recs.push({
      priority: "info",
      title: "All observed chains tip-following",
      detail: "No stall signal from rates + tip lag.",
      next: ["node scripts/belt-progress.mjs --tile"],
    });
  }
  return recs;
}

function capabilitiesDoc() {
  return {
    schema_version: 1,
    name: "belt-progress",
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    sense_only: true,
    never_mutates: ["ENVIO_RESTART", "chain_metadata", "kitchen_ingest_jobs", "config.yaml"],
    features: [
      "robot-triage",
      "json",
      "tile",
      "sample-rates",
      "stall-classify",
      "eta",
      "optional-tip-rpc",
      "optional-kitchen-jobs",
    ],
    commands: [
      { name: "(default)", summary: "robot-triage snapshot", flags: ["--json", "--tile", "--robot-triage"] },
      { name: "sample", summary: "multi-sample NDJSON/JSON with rates", flags: ["--samples", "--interval", "--json"] },
      { name: "capabilities", summary: "machine self-doc", flags: ["--json"] },
      { name: "robot-docs", summary: "agent guide", flags: ["guide"] },
    ],
    exit_codes: {
      [EXIT.OK]: "success (tile/json emitted)",
      [EXIT.USAGE]: "usage / unknown flag",
      [EXIT.SAFETY]: "refused wipe/restart mutation request",
      [EXIT.BLIND]: "GraphQL unavailable / unreadable",
    },
    env_vars: [
      "BELT_GRAPHQL_URL",
      "TIP_LAG_BLOCKS",
      "KITCHEN_API_URL",
      "SERVICE_TOKEN",
      "BELT_PROGRESS_NO_TIP_RPC",
    ],
  };
}

function robotDocsGuide() {
  return `# belt-progress — agent guide (sense-only)

## First call
\`\`\`
node scripts/belt-progress.mjs --robot-triage --json
\`\`\`

## GECKO tile (SessionStart-cheap)
\`\`\`
node scripts/belt-progress.mjs --tile
# STATUS|SIGNAL|MISMATCH  STATUS ∈ {ok|drift|blind}
\`\`\`

## Rates + ETA (needs ≥2 samples)
\`\`\`
node scripts/belt-progress.mjs sample --samples 2 --interval 15 --json
\`\`\`

## Stall classes
TIP_FOLLOW · CATCHUP · SPARSE_NORMAL · FETCH_STALL · PROCESS_STALL · FULL_STALL · UNKNOWN

## Hard rules
- NEVER set ENVIO_RESTART from this tool or follow-ups unless operator cites KF-013 wipe authorization.
- Prefer GraphQL over direct Postgres for production observation.
- Kitchen jobs require KITCHEN_API_URL + SERVICE_TOKEN (optional merge).

## Related
- scripts/profiling/sample-progress-graphql.sh (NDJSON heartbeat)
- scripts/profiling/stall_classify.py (Python twin of JS classifier)
- GET /v2/indexing-status (Kitchen, service-auth)
`;
}

function printHelp() {
  process.stdout.write(`belt-progress — Belt sync progression sensor (sense-only)

Usage:
  node scripts/belt-progress.mjs [--robot-triage] [--json] [--tile]
  node scripts/belt-progress.mjs sample [--samples N] [--interval SEC] [--json]
  node scripts/belt-progress.mjs capabilities [--json]
  node scripts/belt-progress.mjs robot-docs [guide]

Never mutates. Never sets ENVIO_RESTART.
`);
}

function parseArgs(argv) {
  for (const a of argv) {
    if (FORBIDDEN.some((re) => re.test(a))) {
      return { error: "safety", arg: a };
    }
    if (TYPO_MAP[a]) {
      return { error: "typo", arg: a, suggest: TYPO_MAP[a] };
    }
  }

  const flags = new Set();
  const opts = { samples: 2, interval: 10 };
  let command = "triage";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { command: "help" };
    if (a === "--json") {
      flags.add("json");
      continue;
    }
    if (a === "--tile") {
      flags.add("tile");
      continue;
    }
    if (a === "--robot-triage") {
      flags.add("robot-triage");
      continue;
    }
    if (a === "--no-tip-rpc") {
      flags.add("no-tip-rpc");
      continue;
    }
    if (a === "--samples" || a === "--interval") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "usage", detail: `${a} needs positive number` };
      if (a === "--samples") opts.samples = Math.floor(v);
      else opts.interval = v;
      continue;
    }
    if (a.startsWith("-")) return { error: "usage", detail: `unknown flag ${a}` };
    if (["capabilities", "robot-docs", "sample", "help"].includes(a)) {
      command = a;
      continue;
    }
    if (command === "robot-docs" && a === "guide") {
      flags.add("guide");
      continue;
    }
    return { error: "usage", detail: `unknown arg ${a}` };
  }
  return { command, flags, opts };
}

function buildTriagePayload(snapshot, jobs, graphqlUrl) {
  const { stalls, unknown, catchup, tip } = stallSeverity(snapshot.chains);
  const critical = [...snapshot.chains].sort((a, b) => b.lag_blocks - a.lag_blocks)[0] ?? null;
  return {
    schema_version: 1,
    tool: "belt-progress",
    contract_version: CONTRACT_VERSION,
    observed_at: snapshot.observed_at,
    graphql_url: graphqlUrl,
    sense_only: true,
    project_health: stalls.length
      ? "stall"
      : unknown.length === snapshot.chains.length
        ? "needs_sample"
        : tip.length === snapshot.chains.length
          ? "tip_follow"
          : "catchup",
    summary: {
      chains: snapshot.chains.length,
      tip_follow: tip.length,
      catchup: catchup.length,
      stalls: stalls.length,
      unknown: unknown.length,
      critical_chain_id: critical?.chain_id ?? null,
      critical_lag_blocks: critical?.lag_blocks ?? null,
      critical_eta_human: critical?.eta_human ?? null,
    },
    chains: snapshot.chains,
    jobs: jobs
      ? {
          by_status: jobs.jobs?.by_status ?? {},
          active_count: jobs.jobs?.active?.length ?? 0,
        }
      : null,
    recommendations: recommendations(snapshot, jobs),
    follow_ups: [
      "node scripts/belt-progress.mjs sample --samples 2 --interval 15 --json",
      "node scripts/belt-progress.mjs --tile",
      "node scripts/belt-progress.mjs capabilities --json",
    ],
  };
}

function tileFromPayload(payload) {
  if (payload.blind) {
    return ["blind", "0 chains · graphql unavailable", "belt progress ↔ observable chain_metadata"];
  }
  const stalls = payload.summary.stalls;
  const status = stalls > 0 ? "drift" : "ok";
  const signal = `${payload.summary.chains} chains · ${stalls} stalls · crit ${payload.summary.critical_chain_id ?? "-"} lag ${payload.summary.critical_lag_blocks ?? 0}`;
  const mismatch = "belt sync progress ↔ tip/stall/eta (sense-only)";
  return [status, signal, mismatch];
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error === "safety") {
    process.stderr.write(
      `Refused: ${parsed.arg}\n` +
        "belt-progress is sense-only. Never set ENVIO_RESTART here.\n" +
        "KF-013 wipe/resume is an operator Railway procedure, not a CLI flag.\n",
    );
    process.exit(EXIT.SAFETY);
  }
  if (parsed.error === "typo") {
    process.stderr.write(`Unknown flag ${parsed.arg}. Did you mean ${parsed.suggest}?\n`);
    process.exit(EXIT.USAGE);
  }
  if (parsed.error === "usage") {
    process.stderr.write(`${parsed.detail}\n`);
    printHelp();
    process.exit(EXIT.USAGE);
  }
  if (parsed.command === "help") {
    printHelp();
    process.exit(EXIT.OK);
  }
  if (parsed.command === "capabilities") {
    const doc = capabilitiesDoc();
    process.stdout.write(
      JSON.stringify(doc, null, parsed.flags.has("json") ? 2 : 0) + "\n",
    );
    process.exit(EXIT.OK);
  }
  if (parsed.command === "robot-docs") {
    process.stdout.write(robotDocsGuide());
    process.exit(EXIT.OK);
  }

  const graphqlUrl = process.env.BELT_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL;
  const tipLagBlocks = Number(process.env.TIP_LAG_BLOCKS || TIP_LAG_DEFAULT);
  const tipRpcEnabled =
    !parsed.flags.has("no-tip-rpc") && process.env.BELT_PROGRESS_NO_TIP_RPC?.trim() !== "1";
  const wantJson = parsed.flags.has("json");
  const wantTile = parsed.flags.has("tile");

  try {
    if (parsed.command === "sample") {
      let prev = null;
      const samples = [];
      for (let i = 0; i < parsed.opts.samples; i++) {
        const snap = await sampleOnce({ graphqlUrl, tipLagBlocks, tipRpcEnabled, prev });
        const payload = {
          schema_version: 1,
          sample_index: i,
          observed_at: snap.observed_at,
          graphql_url: graphqlUrl,
          chains: snap.chains,
        };
        samples.push(payload);
        if (wantJson && parsed.opts.samples === 1) {
          process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        } else if (!wantJson || parsed.opts.samples > 1) {
          process.stdout.write(JSON.stringify(payload) + "\n");
        }
        prev = snap.prev;
        if (i + 1 < parsed.opts.samples) await sleep(parsed.opts.interval * 1000);
      }
      if (wantTile) {
        const last = buildTriagePayload(
          { observed_at: samples.at(-1).observed_at, chains: samples.at(-1).chains },
          null,
          graphqlUrl,
        );
        const [st, sig, mis] = tileFromPayload(last);
        // tile already may have been after NDJSON; for sample+tile emit tile to stderr? Contract: FIRST stdout line is tile.
        // Re-emit note: sample mode prioritizes NDJSON; tile alone use triage.
        if (samples.length === 0) emitTile("blind", "0 samples", "—");
        else {
          // Already wrote NDJSON; append tile as final line for agents that want both
          emitTile(st, sig, mis);
        }
      }
      process.exit(EXIT.OK);
    }

    // triage (default)
    let snap;
    try {
      snap = await sampleOnce({ graphqlUrl, tipLagBlocks, tipRpcEnabled, prev: null });
    } catch (err) {
      if (wantTile || !wantJson) {
        emitTile("blind", "0 chains · graphql unavailable", "belt progress ↔ observable chain_metadata");
      }
      if (wantJson) {
        process.stdout.write(
          JSON.stringify(
            {
              schema_version: 1,
              blind: true,
              error: String(err?.message || err),
              graphql_url: graphqlUrl,
            },
            null,
            2,
          ) + "\n",
        );
      } else if (!wantTile) {
        process.stderr.write(`blind: ${err?.message || err}\n`);
      }
      process.exit(EXIT.BLIND);
    }

    // Second sample for rates/ETA/stall. Default ON for triage/--json.
    // Skip for --tile-only (SessionStart-cheap) or BELT_PROGRESS_AUTO_SAMPLE=0.
    const tileOnly = wantTile && !wantJson;
    const skipAutoSample =
      tileOnly || process.env.BELT_PROGRESS_AUTO_SAMPLE?.trim() === "0";
    if (!skipAutoSample) {
      await sleep(Number(process.env.BELT_PROGRESS_AUTO_INTERVAL || 8) * 1000);
      snap = await sampleOnce({
        graphqlUrl,
        tipLagBlocks,
        tipRpcEnabled,
        prev: snap.prev,
      });
    }

    let jobs = null;
    try {
      jobs = await kitchenJobs(process.env.KITCHEN_API_URL?.trim(), process.env.SERVICE_TOKEN?.trim());
    } catch {
      jobs = null;
    }

    const payload = buildTriagePayload(snap, jobs, graphqlUrl);

    if (wantTile) {
      const [st, sig, mis] = tileFromPayload(payload);
      emitTile(st, sig, mis);
      if (!wantJson) process.exit(EXIT.OK);
    }

    if (wantJson || parsed.flags.has("robot-triage") || (!wantTile && !wantJson)) {
      if (wantJson) {
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      } else if (!wantTile) {
        // human triage
        process.stdout.write(
          `belt-progress  health=${payload.project_health}  chains=${payload.summary.chains}  stalls=${payload.summary.stalls}\n`,
        );
        process.stdout.write(
          `critical  chain=${payload.summary.critical_chain_id}  lag=${payload.summary.critical_lag_blocks}  eta=${payload.summary.critical_eta_human ?? "n/a"}\n`,
        );
        for (const c of payload.chains) {
          process.stdout.write(
            `  ${String(c.chain_id).padStart(7)}  ${c.stall_class.padEnd(14)}  lag=${String(c.lag_blocks).padStart(10)}  eta=${(c.eta_human ?? "-").padEnd(6)}  proc=${c.processed}\n`,
          );
        }
        process.stdout.write("\nrecommendations:\n");
        for (const r of payload.recommendations) {
          process.stdout.write(`  [${r.priority}] ${r.title} — ${r.detail}\n`);
          for (const n of r.next ?? []) process.stdout.write(`      → ${n}\n`);
        }
      }
    }
    process.exit(EXIT.OK);
  } catch (err) {
    process.stderr.write(`error: ${err?.message || err}\n`);
    process.exit(EXIT.BLIND);
  }
}

main();
