\pset pager off
\if :{?chain_id}
\else
  \echo 'Pass -v chain_id=<int>'
  \quit
\endif
\if :{?contract}
\else
  \echo 'Pass -v contract=0x...'
  \quit
\endif

-- Inspect actual generated names before relying on quoted identifiers.
SELECT to_regclass('"Token"') AS token_table,
       to_regclass('"TrackedHolder"') AS holder_table;

-- Basic counts.
SELECT count(*) AS token_rows,
       count(*) FILTER (WHERE NOT "isBurned") AS unburned_tokens,
       count(DISTINCT lower("owner")) FILTER (WHERE NOT "isBurned") AS token_owners,
       min("mintedAt") AS min_minted_at,
       max("lastTransferTime") AS max_last_transfer
FROM "Token"
WHERE "chainId" = :chain_id
  AND lower("collection") = lower(:'contract');

SELECT count(*) AS holder_rows,
       coalesce(sum("tokenCount"), 0) AS holder_token_sum,
       count(*) FILTER (WHERE "tokenCount" <= 0) AS nonpositive_holder_rows
FROM "TrackedHolder"
WHERE "chainId" = :chain_id
  AND lower("contract") = lower(:'contract');

-- Every unburned token must have exactly one matching holder row with a positive count.
WITH token_counts AS (
  SELECT lower("owner") AS owner, count(*) AS token_count
  FROM "Token"
  WHERE "chainId" = :chain_id
    AND lower("collection") = lower(:'contract')
    AND NOT "isBurned"
  GROUP BY lower("owner")
),
holder_counts AS (
  SELECT lower("address") AS owner, sum("tokenCount") AS token_count
  FROM "TrackedHolder"
  WHERE "chainId" = :chain_id
    AND lower("contract") = lower(:'contract')
  GROUP BY lower("address")
)
SELECT coalesce(t.owner, h.owner) AS owner,
       t.token_count AS token_rows,
       h.token_count AS holder_count
FROM token_counts t
FULL OUTER JOIN holder_counts h USING (owner)
WHERE t.token_count IS DISTINCT FROM h.token_count
ORDER BY owner
LIMIT 100;

-- Deterministic database-local digest. For very large sets, prefer COPY ... | sha256sum.
SELECT md5(coalesce(string_agg(
  "tokenId"::text || ':' || lower("owner") || ':' || "isBurned"::text,
  ',' ORDER BY "tokenId"
), '')) AS token_state_md5
FROM "Token"
WHERE "chainId" = :chain_id
  AND lower("collection") = lower(:'contract');

SELECT md5(coalesce(string_agg(
  lower("address") || ':' || "tokenCount"::text,
  ',' ORDER BY lower("address")
), '')) AS holder_state_md5
FROM "TrackedHolder"
WHERE "chainId" = :chain_id
  AND lower("contract") = lower(:'contract');
