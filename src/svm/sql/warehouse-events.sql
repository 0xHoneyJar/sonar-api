-- Saved on Dune as the parameterized event-extraction query (query id in the rollout runbook).
-- Date bounds are MANDATORY: block_date pruning is the difference between 0.2 and 19 credits
-- per run (measured 2026-07-05). {{from_time}}/{{to_time}}: ISO timestamps; window driven by the loader.
with members as (
  select distinct account_mint
  from tokens_solana.nft
  where collection_mint = '{{collection_mint}}'
)
select
  t.action,
  t.block_slot,
  t.block_time,
  t.tx_id,
  t.outer_instruction_index,
  t.inner_instruction_index,
  t.token_mint_address,
  t.from_owner,
  t.to_owner,
  t.outer_executing_account
from tokens_solana.transfers t
join members m on m.account_mint = t.token_mint_address
where t.block_date >= date(timestamp '{{from_time}}')
  and t.block_time >= timestamp '{{from_time}}'
  and t.block_time <  timestamp '{{to_time}}'
order by t.block_slot, t.tx_id, t.outer_instruction_index, t.inner_instruction_index
