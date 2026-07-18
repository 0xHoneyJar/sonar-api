#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 DATABASE_URL CHAIN_ID CONTRACT" >&2
  exit 2
fi

db="$1"
chain="$2"
contract="$3"

{
  psql "$db" -X -Atq -v ON_ERROR_STOP=1 \
    -v chain_id="$chain" -v contract="$contract" <<'SQL'
COPY (
  SELECT "tokenId"::text,
         lower("owner"),
         "isBurned"::text
  FROM "Token"
  WHERE "chainId" = :chain_id
    AND lower("collection") = lower(:'contract')
  ORDER BY "tokenId"
) TO STDOUT WITH (FORMAT csv);
SQL
} | sha256sum | awk '{print $1}'
