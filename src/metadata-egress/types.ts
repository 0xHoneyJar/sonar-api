/**
 * CR-004 typed metadata retrieval results.
 *
 * Hostile or missing metadata is a typed `partial` outcome — never an untyped
 * exception that aborts resolver candidacy.
 */

import type { TerminalAddressClass } from "./address-policy.js";

export type MetadataRetrievalPurpose =
  | "collection_metadata"
  | "collection_image"
  | "report_enrichment";

export type MetadataFailureReason =
  | "unsupported_scheme"
  | "ambiguous_host"
  | "dns_resolution_failed"
  | "dns_timeout"
  | "denied_address"
  | "denied_port"
  | "invalid_redirect"
  | "redirect_limit"
  | "redirect_loop"
  | "connect_timeout"
  | "header_timeout"
  | "body_timeout"
  | "request_cancelled"
  | "compressed_size_exceeded"
  | "decompressed_size_exceeded"
  | "content_type_denied"
  | "hostile_content"
  | "http_error"
  | "tls_error"
  | "missing"
  | "internal_misconfiguration";

export type AddressFamily = "ipv4" | "ipv6";

/**
 * Provenance retained after a retrieval. URIs are redacted (no userinfo,
 * query, or fragment). Digests support correlation without secret retention.
 */
export interface MetadataRetrievalProvenance {
  readonly requested_uri: string;
  readonly requested_uri_sha256: string;
  readonly final_url: string;
  readonly final_url_sha256: string;
  readonly pinned_address: string;
  readonly address_family: AddressFamily;
  readonly terminal_address_class: TerminalAddressClass;
  readonly retrieved_at: string;
  readonly content_type: string | undefined;
  readonly content_sha256: string | undefined;
  readonly byte_size: number | undefined;
  readonly redirect_count: number;
  /** Safe, non-secret failure reason when outcome is partial. */
  readonly failure_reason: MetadataFailureReason | undefined;
}

export interface MetadataOk {
  readonly outcome: "ok";
  readonly body: Uint8Array;
  readonly content_type: string;
  readonly provenance: MetadataRetrievalProvenance;
}

export interface MetadataPartial {
  readonly outcome: "partial";
  readonly reason: MetadataFailureReason;
  /** Operator-safe message; never includes secrets, cookies, or auth material. */
  readonly safe_message: string;
  readonly provenance: {
    readonly requested_uri: string;
    readonly requested_uri_sha256: string;
    readonly retrieved_at: string;
    readonly redirect_count: number;
    readonly failure_reason: MetadataFailureReason;
    readonly final_url?: string;
    readonly final_url_sha256?: string;
    readonly pinned_address?: string;
    readonly address_family?: AddressFamily;
    readonly terminal_address_class?: TerminalAddressClass;
    readonly content_type?: string;
    readonly content_sha256?: string;
    readonly byte_size?: number;
  };
}

export type MetadataRetrievalResult = MetadataOk | MetadataPartial;

export interface MetadataRetrievalRequest {
  readonly uri: string;
  readonly purpose: MetadataRetrievalPurpose;
  /** Deterministic clock for hermetic fixtures. */
  readonly now?: () => Date;
  /** Optional caller cancellation propagated through the pinned transport. */
  readonly signal?: AbortSignal;
}

/** Headers the egress boundary is willing to send (deny-by-default). */
export interface EgressRequestHeaders {
  readonly accept: string;
  readonly "user-agent": string;
  readonly host: string;
  readonly "accept-encoding"?: string;
}

export interface ValidatedTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  readonly scheme: "http" | "https";
  readonly pinned_address: string;
  readonly address_family: AddressFamily;
  readonly terminal_address_class: TerminalAddressClass;
  /** Host authority for the HTTP Host header (brackets + non-default port). */
  readonly host_authority: string;
}

export interface TransportRequest {
  readonly target: ValidatedTarget;
  readonly method: "GET";
  readonly headers: EgressRequestHeaders;
  readonly connect_timeout_ms: number;
  readonly header_timeout_ms: number;
  readonly body_timeout_ms: number;
  readonly max_compressed_bytes: number;
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Raw (possibly compressed) body bytes as delivered on the wire. */
  readonly body: Uint8Array;
}
