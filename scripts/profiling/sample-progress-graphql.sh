#!/usr/bin/env bash
# Mission 1 — read-only chain_metadata sampler via Hasura GraphQL (no DB URL required).
# Emits one NDJSON object per sample with per-chain rates vs the previous sample.
#
#   BELT_GRAPHQL_URL=https://sonar.0xhoneyjar.xyz/v1/graphql \
#   INTERVAL_SECONDS=10 SAMPLES=18 \
#   bash scripts/profiling/sample-progress-graphql.sh > .run/evidence/mission-01-progress.ndjson
#
# Safety: GET/POST GraphQL read only. Never sets ENVIO_RESTART. Never mutates.

set -euo pipefail

GRAPHQL_URL="${BELT_GRAPHQL_URL:-https://sonar.0xhoneyjar.xyz/v1/graphql}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-10}"
SAMPLES="${SAMPLES:-18}"

QUERY='{"query":"{ chain_metadata { chain_id start_block block_height latest_processed_block latest_fetched_block_number num_events_processed is_hyper_sync timestamp_caught_up_to_head_or_endblock } }"}'

fetch_raw() {
  curl -sS -m 30 "$GRAPHQL_URL" \
    -H 'content-type: application/json' \
    -d "$QUERY"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}${PYTHONPATH:+:$PYTHONPATH}"

# Framework Python installs on macOS may not inherit the system keychain CA
# path. Prefer the installed certifi bundle when available; a missing bundle
# leaves Python's default verification unchanged. Never disable TLS checks.
if [[ -z "${SSL_CERT_FILE:-}" ]]; then
  CERTIFI_CA="$(python3 -c 'import certifi; print(certifi.where())' 2>/dev/null || true)"
  if [[ -n "$CERTIFI_CA" ]]; then
    export SSL_CERT_FILE="$CERTIFI_CA"
  fi
fi

python3 - "$INTERVAL_SECONDS" "$SAMPLES" <<'PY'
import json, os, sys, time, urllib.request
from stall_classify import classify_stall

interval = int(sys.argv[1])
samples = int(sys.argv[2])
url = os.environ.get("BELT_GRAPHQL_URL", "https://sonar.0xhoneyjar.xyz/v1/graphql")
tip_lag = int(os.environ.get("TIP_LAG_BLOCKS", "500"))
query = {
    "query": "{ chain_metadata { chain_id start_block block_height latest_processed_block latest_fetched_block_number num_events_processed is_hyper_sync timestamp_caught_up_to_head_or_endblock } }"
}

prev = None

def fetch():
    req = urllib.request.Request(
        url,
        data=json.dumps(query).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode())
    if "errors" in body:
        raise RuntimeError(body["errors"])
    return body["data"]["chain_metadata"]

def classify(row, rates):
    return classify_stall(
        head=row["block_height"],
        fetched=row["latest_fetched_block_number"],
        processed=row["latest_processed_block"],
        rates=rates,
        tip_lag_blocks=tip_lag,
    )

for i in range(samples):
    now = time.time()
    rows = fetch()
    by_id = {int(r["chain_id"]): r for r in rows}
    out_chains = []
    for cid, r in sorted(by_id.items()):
        rates = {}
        if prev and cid in prev["by_id"]:
            dt = max(now - prev["ts"], 1e-6)
            p = prev["by_id"][cid]
            rates = {
                "processed_bps": (r["latest_processed_block"] - p["latest_processed_block"]) / dt,
                "fetched_bps": (r["latest_fetched_block_number"] - p["latest_fetched_block_number"]) / dt,
                "events_per_sec": (r["num_events_processed"] - p["num_events_processed"]) / dt,
                "head_bps": (r["block_height"] - p["block_height"]) / dt,
            }
        lag = r["block_height"] - r["latest_processed_block"]
        ahead = r["latest_fetched_block_number"] - r["latest_processed_block"]
        eta = None
        if rates.get("processed_bps", 0) > 0 and lag > 0:
            eta = lag / rates["processed_bps"]
        out_chains.append({
            "chain_id": cid,
            "start_block": r.get("start_block"),
            "head": r["block_height"],
            "processed": r["latest_processed_block"],
            "fetched": r["latest_fetched_block_number"],
            "events": r["num_events_processed"],
            "hypersync": r.get("is_hyper_sync"),
            "caught_up_at": r.get("timestamp_caught_up_to_head_or_endblock"),
            "lag_blocks": lag,
            "fetch_ahead": ahead,
            "rates": rates,
            "eta_seconds": eta,
            "stall_class": classify(r, rates),
        })
    sample = {
        "schema_version": 1,
        "mission": "mission-01-progress-heartbeat",
        "sample_index": i,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "graphql_url": url,
        "chains": out_chains,
    }
    print(json.dumps(sample), flush=True)
    prev = {"ts": now, "by_id": by_id}
    if i + 1 < samples:
        time.sleep(interval)
PY
