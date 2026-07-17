/** Test-only capability-registry fixtures. Never import this module from runtime code. */
export {
  createHermeticBaselineSignatureVerifier,
  hermeticBaselineSignatureHex,
  HERMETIC_BASELINE_SIGNATURE_ALGORITHM,
} from "./hermetic-signature.js";

export {
  defaultMainnetRegistryInput,
  defaultMainnetNetworkCapabilities,
  hermeticResolverRegistryInput,
  hermeticResolverNetworkCapabilities,
  ethereumMainnetCapability,
  baseMainnetCapability,
  optimismMainnetCapability,
  arbitrumMainnetCapability,
  berachainMainnetCapability,
  zoraMainnetCapability,
  solanaMainnetCapability,
  robinhoodDisabledCapability,
  robinhoodRecognizeOnlyCapability,
  DEFAULT_REGISTRY_EPOCH,
  DEFAULT_REGISTRY_SEQUENCE,
  availableOp,
  disabledOp,
  disabledPrepareOp,
  degradedRecognizeOp,
  degradedPrepareOp,
  integrityDisabledRecognizeOp,
  integrityDisabledPrepareOp,
  eip155,
  solanaMainnet,
  FIXTURE_EFFECTIVE_AT,
} from "./fixtures.js";
