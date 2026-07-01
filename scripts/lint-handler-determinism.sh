#!/usr/bin/env bash
#
# lint-handler-determinism.sh — wall-clock / unpinned-RPC sensor for Envio handlers.
#
# Envio replays handlers on reorg, so persisted state must be deterministic.
# (Originally scoped to ponder-runtime; retargeted to src/handlers after ponder removal.)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLERS="$ROOT/src/handlers"
fail=0

if [ ! -d "$HANDLERS" ]; then
  echo "lint-handler-determinism: no src/handlers dir, nothing to check."
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
