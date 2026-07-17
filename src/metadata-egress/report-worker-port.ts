/**
 * Report-worker metadata port — must use the CR-004 egress boundary only.
 */

import {
  createMetadataEgressClient,
  type MetadataEgressClient,
} from "./client.js";
import type { RetrieveMetadataDeps } from "./retrieve.js";

export type ReportMetadataWorkerPort = MetadataEgressClient;

export const createReportMetadataWorkerPort = (
  deps: RetrieveMetadataDeps,
): ReportMetadataWorkerPort => createMetadataEgressClient(deps);
