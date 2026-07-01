import type { BeaconV2Document } from "../domain/beacon-v2.domain.js";
import type { SelfCheckOptions, SelfCheckResult } from "../domain/self-check.domain.js";

export interface SonarSelf {
  run(options: SelfCheckOptions): Promise<SelfCheckResult>;
  buildDraft(options: SelfCheckOptions): Promise<BeaconV2Document>;
}
