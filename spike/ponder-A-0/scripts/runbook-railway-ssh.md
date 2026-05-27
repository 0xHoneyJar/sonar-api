# T-A0.8 Railway eRPC Transport Runbook (operator-run)

**Status**: pending_operator_run — the headless agent could NOT execute
this (railway CLI present but `RAILWAY_API_TOKEN` invalid). The operator
runs this as one shell session and pastes results into the COOKBOOK
§T-A0.8 evidence block.

## Goal

Verify that a minimal Ponder app running INSIDE the Railway private
network can index against `http://erpc.railway.internal:4000/main/evm/1`
and that the eRPC gateway returns well-formed `eth_getLogs` responses
(no int32 quirks, no malformed JSON, no truncation).

## Prerequisites

1. Operator is logged into Railway CLI: `railway whoami` returns the
   operator's email (NOT `Unauthorized`).
2. The same Railway project that owns the eRPC service has at least one
   service the operator can `railway ssh` into (a temporary "shell"
   service is fine; spinning a `belt-indexer-staging` instance works).
3. This spike's `/spike/ponder-A-0/` directory is present in that
   service's filesystem (e.g. via a temporary deploy or `railway run`
   from the local checkout).

## Steps (one shell session)

```bash
# 0. confirm we're in the railway network
railway ssh
$ curl -fsS http://erpc.railway.internal:4000/main/evm/1 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# expected: {"jsonrpc":"2.0","id":1,"result":"0x..."}  (hex head block)

# 1. eth_getLogs probe — the load-bearing call ponder makes during cold sync.
#    Use Milady (0x5af0d9827e0c53e4799bb226655a1de152a425a5) Transfer topic on
#    a tiny block range — same range as the local-spike verification.
$ curl -fsS http://erpc.railway.internal:4000/main/evm/1 \
    -H "Content-Type: application/json" \
    -d '{
      "jsonrpc":"2.0","method":"eth_getLogs","id":2,
      "params":[{
        "address":"0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        "topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
        "fromBlock":"0x10366a0","toBlock":"0x10366a0"
      }]
    }' | jq .

# expected: { "jsonrpc": "2.0", "id": 2, "result": [ ... 26 logs ... ] }
# verify shape:
#   - each log has hex `blockNumber`, `transactionIndex`, `logIndex` (uint256 hex)
#   - `topics[3]` (tokenId, indexed) is full 32-byte hex (NOT truncated to int32)
#   - `data` is "0x" (no non-indexed args on Transfer)
# the int32 quirk to watch for: any field appearing as a decimal integer
# (not hex string) would break ponder; eRPC should pass through hex.

# 2. spike Ponder against eRPC (uses the same spike code as local-laptop run)
$ cd /spike-ponder-A-0  # wherever you mounted/copied the spike
$ PONDER_RPC_URL_1=http://erpc.railway.internal:4000/main/evm/1 \
  DATABASE_SCHEMA=erpc_spike_a08 \
  DATABASE_URL=postgresql://<staging-db-url> \
  timeout 180 pnpm ponder start --log-level info

# expected: same "Completed backfill indexing across all chains" log line
# as the local run. RPC errors / malformed responses surface as
# "Failed to fetch logs" or panic — those are the failure modes to capture.

# 3. compare row counts to the local-laptop run
$ docker exec <pg> psql -c "SELECT COUNT(*) FROM erpc_spike_a08.token;"
# expected: 19 (same as local run, since the source data is identical)

# 4. compare block-tick counter
$ docker exec <pg> psql -c "SELECT * FROM erpc_spike_a08.block_tick_counter;"
# expected: 1001 ticks, last_block 17001000
```

## What to capture for the COOKBOOK

- `eth_blockNumber` response (hex head block)
- `eth_getLogs` response (full first log + count)
- Ponder run summary log (`Completed indexing across all chains (Xs)`)
- token + block_tick_counter row counts post-run
- Any deviation (different count, malformed response, RPC errors)

## Negative-path observations to log

Even if it works on first try, observe and log:

1. eRPC retry behavior — kill an upstream provider mid-run and see eRPC's
   failover (visible in eRPC service logs)
2. Rate-limit headers from eRPC's response
3. eRPC's caching — re-run the same `eth_getLogs` and verify the cache
   shortens latency
