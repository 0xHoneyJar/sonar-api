#!/usr/bin/env bash
# scripts/migration/scratch/run-scratch-validation.sh
#
# Reproducible SCRATCH validation driver for the T-M2 transform.
#   - stands up two throwaway Postgres containers (source :5544, target :5545)
#   - runs the in-process validation harness (scratch/validate.ts)
#   - tears the containers down (unless KEEP=1)
#
# SCRATCH-ONLY. Never connects to production. Uses dedicated ports so it does
# not collide with any existing local Postgres (e.g. the envio dev DB on :5433).
#
# Usage:
#   bash scripts/migration/scratch/run-scratch-validation.sh
#   KEEP=1 bash scripts/migration/scratch/run-scratch-validation.sh   # leave containers up
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

SRC_PORT=5544
DST_PORT=5545
SRC_NAME=tm2-scratch-src
DST_NAME=tm2-scratch-dst
PG_IMAGE="${PG_IMAGE:-postgres:18.1}"
TSX="$REPO_ROOT/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    docker rm -f "$SRC_NAME" "$DST_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[scratch] removing any stale containers"
docker rm -f "$SRC_NAME" "$DST_NAME" >/dev/null 2>&1 || true

echo "[scratch] starting source ($SRC_PORT) + target ($DST_PORT) Postgres ($PG_IMAGE)"
docker run -d --name "$SRC_NAME" -e POSTGRES_PASSWORD=scratch -e POSTGRES_USER=scratch -e POSTGRES_DB=envio_src  -p "$SRC_PORT:5432" "$PG_IMAGE" >/dev/null
docker run -d --name "$DST_NAME" -e POSTGRES_PASSWORD=scratch -e POSTGRES_USER=scratch -e POSTGRES_DB=ponder_dst -p "$DST_PORT:5432" "$PG_IMAGE" >/dev/null

echo "[scratch] waiting for readiness"
for c in "$SRC_NAME" "$DST_NAME"; do
  until docker exec "$c" pg_isready -U scratch >/dev/null 2>&1; do sleep 0.5; done
done

export SRC_DATABASE_URL="postgresql://scratch:scratch@localhost:$SRC_PORT/envio_src"
export DST_DATABASE_URL="postgresql://scratch:scratch@localhost:$DST_PORT/ponder_dst"

echo "[scratch] running validation harness"
node "$TSX" "$REPO_ROOT/scripts/migration/scratch/validate.ts"
