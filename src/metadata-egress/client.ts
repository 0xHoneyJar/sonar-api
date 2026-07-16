/**
 * Sole metadata network client for resolver and report workers (CR-004).
 *
 * Import this module instead of calling fetch/http against collection metadata
 * URIs. Ports are injected so hermetic tests never touch the network.
 */

import { assertServerOnlyMetadataEgress } from "./browser-boundary.js";
import { enrichCandidateFromRemoteMetadata } from "./enrich.js";
import {
  createNodeDnsPort,
  createNodePinnedTransport,
} from "./node-ports.js";
import type { MetadataEgressPorts } from "./ports.js";
import { retrieveMetadata, type RetrieveMetadataDeps } from "./retrieve.js";
import type {
  MetadataRetrievalPurpose,
  MetadataRetrievalRequest,
  MetadataRetrievalResult,
} from "./types.js";

export const createProductionMetadataEgressPorts = (): MetadataEgressPorts => ({
  dns: createNodeDnsPort(),
  transport: createNodePinnedTransport(),
});

export interface MetadataEgressClient {
  readonly retrieve: (
    request: MetadataRetrievalRequest,
  ) => Promise<MetadataRetrievalResult>;
  readonly enrich: (input: {
    readonly uri: string;
    readonly purpose?: MetadataRetrievalPurpose;
    readonly now?: () => Date;
  }) => ReturnType<typeof enrichCandidateFromRemoteMetadata>;
}

/**
 * Construct the only permitted metadata network client for workers.
 */
export const createMetadataEgressClient = (
  deps: RetrieveMetadataDeps,
): MetadataEgressClient => {
  assertServerOnlyMetadataEgress();
  return {
    retrieve: (request) => retrieveMetadata(request, deps),
    enrich: (input) =>
      enrichCandidateFromRemoteMetadata({
        uri: input.uri,
        purpose: input.purpose,
        now: input.now,
        deps,
      }),
  };
};
