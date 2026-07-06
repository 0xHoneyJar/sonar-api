/*
 * SF Vaults - Dedicated Event Handler Entry Point
 *
 * This file is used for testing SF vaults in isolation.
 * It only imports SF vault handlers to avoid type errors from other contracts.
 */

// Set & Forgetti vault handlers
import {
  handleSFVaultDeposit,
  handleSFVaultWithdraw,
  handleSFVaultStrategyUpdated,
  handleSFStrategyMultiRewardsUpdated,
} from "./handlers/sf-vaults";

// Export all SF vault handlers
export { handleSFVaultDeposit };
export { handleSFVaultWithdraw };
export { handleSFVaultStrategyUpdated };
export { handleSFStrategyMultiRewardsUpdated };
// handleSFMultiRewards{Staked,Withdrawn,RewardPaid} removed — sf-vaults.ts stopped
// exporting them in the 3.2.1 belt port (#75); the dead imports broke repo-wide tsc (bd-j0fj)
