#!/usr/bin/env bash
#
# lint-handler-determinism.sh — a sensor for the bug-class that took FAGAN five
# iterations to fully catch on sonar-api#63: persisted NONDETERMINISM in ponder
# handlers.
#
# Ponder re-executes handlers on reorg and during replay, so any value written
# into an onchainTable, AND any state read whose result decides what is written,
# MUST be deterministic across executions. Two failure modes we actually hit:
#
#   1. Wall-clock time (the JS Date now-call / argless new-Date) persisted into
#      indexed state. Replay produces a different value. Use event.block.timestamp
#      / event.block.number instead (a block's timestamp is fixed).
#
#   2. A block-dependent RPC state read (getCode / getBalance / getStorageAt /
#      getProof / readContract / call) inside a BLOCK handler that is NOT pinned to
#      a block. Unpinned reads return `latest`, which moves between executions.
#      (#63 fix: getCode pinned to blockNumber=currentBlock.) Event handlers are
#      exempt — there the default block IS the event's block (deterministic).
#
# A sensor only earns trust if it does not cry wolf, so both rules are scoped
# tightly. Exit 1 on any un-allowlisted violation.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLERS="$ROOT/ponder-runtime/src/handlers"
fail=0

if [ ! -d "$HANDLERS" ]; then
  echo "lint-handler-determinism: no ponder-runtime handlers dir, nothing to check."
  exit 0
fi

# ── Rule 1: no persisted wall-clock in a ponder handler ──────────────────────
# Allowlist: outbox-flush.ts records a NATS publish time (publishedAt) — a real
# side-effect timestamp, not consensus state, and pre-existing. Any other use is
# a violation: persist event.block.timestamp instead. Comment lines (// or *) are
# skipped so a comment that merely MENTIONS the pattern never trips the sensor.
wallclock=$(grep -rnE 'Date\.now\(\)|new Date\(\)' "$HANDLERS" 2>/dev/null \
  | grep -v '/outbox-flush\.ts:' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' || true)
if [ -n "$wallclock" ]; then
  echo "✗ DETERMINISM (Rule 1): wall-clock time in a ponder handler — replay writes a different value."
  echo "  Fix: persist event.block.timestamp / event.block.number. Offenders:"
  echo "$wallclock" | sed 's/^/    /'
  echo ""
  fail=1
fi

# ── Rule 2: block-handler RPC state reads must be block-pinned ────────────────
# Only BLOCK handlers (ponder.on("X:block")) are at risk — their default read
# block can be `latest`. For each such file that does a block-dependent read,
# require a blockNumber / blockTag somewhere in the file.
read_re='client\.(getCode|getBalance|getStorageAt|getProof|readContract|call)\('
while IFS= read -r file; do
  [ -n "$file" ] || continue
  # is it a block handler that does a block-dependent read?
  if grep -qE 'ponder\.on\("[^"]+:block"' "$file" && grep -qE "$read_re" "$file"; then
    if ! grep -qE 'blockNumber|blockTag' "$file"; then
      echo "✗ DETERMINISM (Rule 2): unpinned RPC state read in a BLOCK handler — reads 'latest' (replay-nondeterministic)."
      echo "  Fix: pass blockNumber (e.g. the tick's currentBlock) to the read. File: ${file#"$ROOT"/}"
      echo ""
      fail=1
    fi
  fi
done < <(grep -rlE "$read_re" "$HANDLERS" 2>/dev/null || true)

if [ "$fail" -eq 0 ]; then
  echo "✓ handler-determinism: no persisted wall-clock, no unpinned block-handler reads."
fi
exit "$fail"
