import type {
  CollectionDeploymentRef,
  NetworkRef,
} from "../collection-resolver/protocol.js";

export type CollectionIndexStatus = "missing" | "indexing" | "indexed" | "failed";
export type IngestJobStatus = "queued" | "indexing" | "completed" | "failed";
export type TokenStandard = "erc721" | "erc1155" | "metaplex_collection" | "programmable_nft" | "compressed_nft";
export type CapabilityHealth = "available" | "degraded" | "disabled";

export interface CollectionStatusResponse {
  status: Exclude<CollectionIndexStatus, "missing">;
  indexed_at?: string;
  holder_count?: number;
}

/** Exact legacy wire request. Subscriber fields never become physical-job ownership. */
export interface IngestRequestBody {
  order_id: string;
  source: string;
  contact_email?: string;
  community_name?: string;
}

export interface IngestQueuedResponse {
  job_id: string;
  status: "queued";
}

export interface IngestAlreadyIndexedResponse {
  status: "indexed";
  holder_count: number;
  indexed_at?: string;
}

/** Compatibility key for the historical EVM route and Hasura adapter. */
export interface CollectionKey {
  chainId: number;
  contract: `0x${string}`;
}

export interface PreparationCapability {
  capabilityId: "ownership_index.v1";
  capabilityVersion: string;
  health: CapabilityHealth;
  enabled: boolean;
  reasonClass: string;
  reason: string;
  sourceSequence: string;
  finalityPolicyVersion: string;
  prepareAdapterId: "belt.eth-erc721" | "belt.evm-erc721" | "unsupported";
  prepareAdapterVersion: string;
}

export interface PhysicalJobIdentity {
  deployment: CollectionDeploymentRef;
  capabilityId: "ownership_index.v1";
  capabilityVersion: string;
}

export interface IngestJobRecord extends PhysicalJobIdentity {
  physicalJobId: string;
  /** Legacy response alias. It is the same physical identifier. */
  jobId: string;
  /** Present only for EVM compatibility readers. */
  key?: CollectionKey;
  tokenStandard: TokenStandard;
  prepareAdapterId: PreparationCapability["prepareAdapterId"];
  prepareAdapterVersion: string;
  sourceSequence: string;
  finalityPolicyVersion: string;
  status: IngestJobStatus;
  attempt: number;
  errorCode?: string;
  errorMessage?: string;
  leaseOwner?: string;
  leaseUntilMs?: number;
  leaseEpoch: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface JobCorrelation {
  physicalJobId: string;
  source: string;
  correlationId: string;
  createdAtMs: number;
}

export interface AdmissionRequest {
  deployment: CollectionDeploymentRef;
  tokenStandard: TokenStandard;
  capability: PreparationCapability;
  correlation?: {
    source: string;
    correlationId: string;
  };
}

export type AdmissionFailureCode =
  | "unsupported_network"
  | "unsupported_standard"
  | "capability_disabled"
  | "capability_degraded"
  | "capability_version_mismatch"
  | "migration_divergence";

export interface AdmissionFailure {
  ok: false;
  code: AdmissionFailureCode;
  reasonClass: string;
  reason: string;
}

export interface AdmissionSuccess {
  ok: true;
  job: IngestJobRecord;
  created: boolean;
}

export type AdmissionResult = AdmissionSuccess | AdmissionFailure;

export interface CanonicalPreparationRequest {
  schema_version: 1;
  network: NetworkRef;
  address: string;
  token_standard: TokenStandard;
  correlation?: {
    source: string;
    correlation_id: string;
  };
}

export interface MigrationAuthorityState {
  phase: "legacy" | "dual_write" | "parity" | "canonical" | "constrained";
  divergence: boolean;
  reason?: string;
  updatedAtMs: number;
}

export interface PreparationRuntimeState {
  available: boolean;
  mode: "unavailable" | "local_config" | "injected" | "belt_config_batch";
  reason: string;
}

/** Derived from Effect Schema — do not hand-edit field shapes. */
export type {
  BatchPreparationItemRequest,
  BatchPreparationRequest,
} from "./protocol.js";

export interface WorkerLease {
  owner: string;
  epoch: number;
}
