#!/usr/bin/env bash
# svm-meter-report.sh — aggregate [helius-meter] ledger lines from recent svm-event-backfill runs.
#
# The meter (src/svm/helius-meter.ts) emits one JSON line per process exit; GitHub Actions logs are
# the ledger for the reconcile cron. This sums credits by kind across the last N runs so the
# "credits/day by call type" number is one command away. Webhook lane: curl its /health instead
# (cumulative since boot, field `helius_meter`).
#
# Usage: scripts/svm-meter-report.sh [runs]   (default 28 ≈ 7 days at 6h cadence)
set -euo pipefail

REPO="${SVM_METER_REPO:-0xHoneyJar/thj-envio}"
RUNS="${1:-28}"

command -v gh >/dev/null || { echo "gh CLI required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

lines=0
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

while read -r id; do
  gh run view "$id" --repo "$REPO" --log 2>/dev/null | grep -o '\[helius-meter\] {.*}' | sed 's/^\[helius-meter\] //' >>"$tmp" || true
done < <(gh run list --repo "$REPO" --workflow svm-event-backfill.yml --limit "$RUNS" --json databaseId --jq '.[].databaseId')

lines="$(wc -l <"$tmp" | tr -d ' ')"
if [ "$lines" -eq 0 ]; then
  echo "no [helius-meter] lines found in the last $RUNS runs (meter not deployed yet, or runs died before any Helius call)" >&2
  exit 2
fi

echo "── helius credit burn · last $RUNS reconcile runs ($lines metered) ──"
jq -s '
  { runs: length,
    estimated_credits_total: (map(.estimated_credits) | add),
    by_kind: (
      [ .[] | .by_kind | to_entries[] ] | group_by(.key)
      | map({ (.[0].key): { calls: (map(.value.calls) | add), estimated_credits: (map(.value.estimated_credits) | add) } })
      | add ),
    top_methods: (
      [ .[] | .calls | to_entries[] ] | group_by(.key)
      | map({ method: .[0].key, calls: (map(.value) | add) })
      | sort_by(-.calls) | .[0:8] )
  }' "$tmp"
echo "note: estimated_credits = attempts × list price (rpc 1 · das 10 · enhanced 100) — an upper bound; reconcile against the Helius dashboard's billed number."
