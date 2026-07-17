/**
 * Resolver-worker metadata port — must use the CR-004 egress boundary only.
 */

import {
  createMetadataEgressClient,
  type MetadataEgressClient,
} from "./client.js";
import type { RetrieveMetadataDeps } from "./retrieve.js";

export type ResolverMetadataPort = MetadataEgressClient;

export const createResolverMetadataPort = (
  deps: RetrieveMetadataDeps,
): ResolverMetadataPort => createMetadataEgressClient(deps);
