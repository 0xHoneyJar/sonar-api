#!/usr/bin/env bats
#
# promote.bats — tests for scripts/promote.sh (bd-c09.4). The `node` (gate) and `railway`
# CLIs are stubbed via a temp PATH dir so we exercise the swap LOGIC without live calls:
# the gate's exit code is controlled by $GATE_EXIT; every railway invocation is recorded.
# The load-bearing invariant under test: NO railway write happens unless the gate PASSES
# (promote), and rollback flips to blue WITHOUT running the gate (safety exit).

setup() {
	STUBDIR="$(mktemp -d)"
	export NODE_LOG="$STUBDIR/node.log"
	export RAILWAY_LOG="$STUBDIR/railway.log"

	# gate stub: record the call, exit with $GATE_EXIT (default 0).
	cat > "$STUBDIR/node" <<'STUB'
#!/usr/bin/env bash
echo "node $*" >> "$NODE_LOG"
exit "${GATE_EXIT:-0}"
STUB

	# railway stub: record the call, succeed.
	cat > "$STUBDIR/railway" <<'STUB'
#!/usr/bin/env bash
echo "railway $*" >> "$RAILWAY_LOG"
exit 0
STUB

	chmod +x "$STUBDIR/node" "$STUBDIR/railway"
	export PATH="$STUBDIR:$PATH"

	# fake token file + dummy gate path (the node stub ignores its args)
	echo "faketoken" > "$STUBDIR/tok"
	export RAILWAY_TOKEN_FILE="$STUBDIR/tok"
	export PROMOTION_GATE="$STUBDIR/fake-gate.js"

	PROMOTE="$BATS_TEST_DIRNAME/../scripts/promote.sh"
}

teardown() { rm -rf "$STUBDIR"; }

@test "gate FAIL aborts the promote with NO railway writes (fail-closed, R-D)" {
	export GATE_EXIT=1
	run bash "$PROMOTE"
	[ "$status" -ne 0 ]
	[ -f "$NODE_LOG" ]          # the gate ran
	[ ! -f "$RAILWAY_LOG" ]     # nothing was flipped
}

@test "gate PASS + --dry-run runs the gate, prints the green flip, makes NO writes" {
	export GATE_EXIT=0
	run bash "$PROMOTE" --dry-run
	[ "$status" -eq 0 ]
	[ -f "$NODE_LOG" ]
	[ ! -f "$RAILWAY_LOG" ]
	echo "$output" | grep -q "would set BELT_UPSTREAM"
	echo "$output" | grep -q "belt-hasura-green.railway.internal:8080"
	echo "$output" | grep -q "would set CURRENT_BELT_DATABASE_URL"
}

@test "gate PASS performs the green flip + Score signal (real, stubbed railway)" {
	export GATE_EXIT=0
	run bash "$PROMOTE"
	[ "$status" -eq 0 ]
	grep -q "BELT_UPSTREAM=belt-hasura-green.railway.internal:8080" "$RAILWAY_LOG"
	grep -q "CURRENT_BELT_DATABASE_URL=" "$RAILWAY_LOG"
}

@test "rollback reverts to blue WITHOUT running the gate (safety exit, R-A)" {
	run bash "$PROMOTE" --rollback
	[ "$status" -eq 0 ]
	[ ! -f "$NODE_LOG" ]        # gate must NOT run on rollback
	grep -q "BELT_UPSTREAM=belt-hasura.railway.internal:8080" "$RAILWAY_LOG"
}

@test "rollback --dry-run prints the blue revert, no gate, no writes" {
	run bash "$PROMOTE" --rollback --dry-run
	[ "$status" -eq 0 ]
	[ ! -f "$NODE_LOG" ]
	[ ! -f "$RAILWAY_LOG" ]
	echo "$output" | grep -q "would set BELT_UPSTREAM"
	echo "$output" | grep -q "belt-hasura.railway.internal:8080"
}

@test "unknown argument exits non-zero" {
	run bash "$PROMOTE" --bogus
	[ "$status" -ne 0 ]
}
