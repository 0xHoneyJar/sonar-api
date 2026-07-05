-- Saved on Dune as the parameterized member-set query (query id recorded in the rollout runbook).
-- {{collection_mint}}: Metaplex certified-collection mint (base58).
select distinct account_mint
from tokens_solana.nft
where collection_mint = '{{collection_mint}}'
