/**
 * CR-011A — Public trust-stream producer adoption.
 *
 * Emits CR-009 signed capability/ownership evidence with transactional outbox
 * sequencing, range replay, and signed epoch baselines. Fixture keys only.
 */
export { TrustStreamProducerError } from "./errors.js";
export {
  SONAR_PUBLIC_CAPABILITY_STREAM_ID,
  SONAR_PUBLIC_OWNERSHIP_STREAM_ID,
  SONAR_PRODUCER_ID,
  CAPABILITY_EVIDENCE_CAPABILITY,
  OWNERSHIP_EVIDENCE_CAPABILITY,
  PUBLIC_TENANT_SCOPE_DIGEST,
} from "./constants.js";
export {
  CapabilityEvidenceBody,
  OwnershipEvidenceBody,
  type CapabilityEvidenceBody as CapabilityEvidenceBodyType,
  type OwnershipEvidenceBody as OwnershipEvidenceBodyType,
} from "./schemas.js";
export {
  createInMemoryTrustStreamOutboxStore,
  type TrustStreamOutboxEntry,
  type TrustStreamOutboxStore,
  type TrustStreamSnapshot,
} from "./outbox-store.js";
export {
  createPublicTrustStreamProducer,
  type PublicTrustStreamProducer,
  type PublicTrustStreamProducerConfig,
  type AppendEvidenceInput,
} from "./producer.js";
export {
  loadSharedProducerConsumerFixtures,
  fixtureCapabilityEvidenceBody,
  fixtureOwnershipEvidenceBody,
} from "./fixtures.js";
