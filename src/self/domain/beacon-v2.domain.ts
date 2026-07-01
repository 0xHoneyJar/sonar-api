import type { ProbeResult } from "./probe-result.domain.js";

export type GeneratedSection = "sources" | "read_surface" | "deploy_model";

export type AcvpStatus = "aspirational" | "grounded";

export interface ChainRef {
  id: number;
  name?: string;
}

export interface SourcesBlock {
  status: "verified" | "unknown";
  transport: "hypersync" | "rpc" | "mixed";
  chains: ChainRef[];
  contract_source_count: number;
  svm?: {
    lane: string;
    transport: string;
    status: "verified" | "unknown";
  };
  reason?: string;
}

export interface ReadSurfaceBlock {
  status: "verified" | "unknown";
  graphql: {
    alias: string;
    endpoint: string;
    schema_hint: string[];
  };
  auth: { kind: string };
  mcp: {
    shape: string;
    tools: string[];
  };
  reason?: string;
}

export interface DeployService {
  name: string;
  alias?: string;
  id?: string;
  deployment_status?: string;
}

export interface DeployModelBlock {
  status: "verified" | "unknown";
  pattern?: string;
  alias_is_contract?: boolean;
  immutable_deployments?: boolean;
  services?: DeployService[];
  reason?: string;
}

export interface EventsBlock {
  status: "verified" | "unverified" | "unknown";
  transport?: string;
  publishes?: Array<{ topic: string; schema: string }>;
}

export interface ConsumerBlock {
  name: string;
  reads: string[];
}

export interface AcvpInvariant {
  id: string;
  status: AcvpStatus;
  proof?: string;
  scope?: string;
}

export interface BeaconIdentity {
  name: string;
  aka?: string[];
  role?: string;
  runtime?: string;
  source_of_truth?: string;
}

export interface BeaconV2Document {
  schema_version: "2";
  _generated_sections: GeneratedSection[];
  identity: BeaconIdentity;
  sources: SourcesBlock | ProbeResult<SourcesBlock>;
  read_surface: ReadSurfaceBlock | ProbeResult<ReadSurfaceBlock>;
  deploy_model: DeployModelBlock | ProbeResult<DeployModelBlock>;
  events: EventsBlock;
  consumers: ConsumerBlock[];
  acvp_invariants: AcvpInvariant[];
}

export const DEFAULT_GENERATED_SECTIONS: GeneratedSection[] = [
  "sources",
  "read_surface",
  "deploy_model",
];

export const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  42161: "arbitrum",
  7777777: "zora",
  8453: "base",
  80094: "berachain",
};
