export type CollectionIndexStatus = "missing" | "indexing" | "indexed" | "failed";

export type IngestJobStatus = "queued" | "indexing" | "completed" | "failed";

export interface CollectionStatusResponse {
  status: Exclude<CollectionIndexStatus, "missing">;
  indexed_at?: string;
  holder_count?: number;
}

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

export interface CollectionKey {
  chainId: number;
  contract: `0x${string}`;
}

export interface IngestJobRecord {
  jobId: string;
  key: CollectionKey;
  orderId: string;
  source: string;
  contactEmail?: string;
  communityName?: string;
  status: IngestJobStatus;
  errorMessage?: string;
  createdAtMs: number;
  updatedAtMs: number;
}
