/**
 * Resolver/report adapter over the metadata egress boundary.
 *
 * Missing or hostile remote metadata becomes typed partial diagnostics —
 * never a resolver exception. Nested metadata image URIs are never returned
 * as trusted/renderable; they become explicit untrusted refs that require a
 * subsequent fetch through this same egress boundary.
 */

import { classifyIpAddress } from "./address-policy.js";
import { redactUri } from "./provenance.js";
import { retrieveMetadata, type RetrieveMetadataDeps } from "./retrieve.js";
import type {
  MetadataFailureReason,
  MetadataRetrievalPurpose,
  MetadataRetrievalResult,
} from "./types.js";
import { isUrlPolicyError, parseMetadataUrl } from "./url-policy.js";

export type CandidateMetadataQuality =
  | "onchain"
  | "registry_enriched"
  | "external_pointer"
  | "partial"
  | "unavailable";

/**
 * Nested image pointer from metadata JSON. Never treat as Dashboard-safe or
 * renderable until fetched/validated through the egress boundary.
 */
export interface UntrustedImageRef {
  readonly kind: "untrusted_metadata_image_ref";
  readonly requires_egress_fetch: true;
  /**
   * Redacted authority/path only when the pointer is not an immediate
   * private/link-local/literal deny. Omitted entirely when publishing the
   * pointer would leak an internal address.
   */
  readonly safe_uri: string | undefined;
  readonly uri_sha256: string | undefined;
  readonly denied_inline: boolean;
  readonly denial_reason: MetadataFailureReason | undefined;
}

export interface RemoteMetadataEnrichment {
  readonly metadata_quality: CandidateMetadataQuality;
  /**
   * Trusted/renderable image URL — always undefined from remote metadata JSON.
   * Direct `collection_image` fetches also leave this undefined; validated
   * bytes live on `retrieval` and any pointer is `untrusted_image_ref`.
   */
  readonly image: undefined;
  readonly untrusted_image_ref: UntrustedImageRef | undefined;
  readonly name: string | undefined;
  readonly symbol: string | undefined;
  readonly diagnostics: {
    readonly reason: MetadataFailureReason | undefined;
    readonly safe_message: string | undefined;
    readonly requested_uri: string;
    readonly requested_uri_sha256: string;
    readonly final_url: string | undefined;
    readonly final_url_sha256: string | undefined;
    readonly pinned_address: string | undefined;
    readonly terminal_address_class: string | undefined;
    readonly retrieved_at: string;
    readonly content_type: string | undefined;
    readonly content_sha256: string | undefined;
    readonly byte_size: number | undefined;
  };
  readonly retrieval: MetadataRetrievalResult;
}

const parseJsonObject = (
  body: Uint8Array,
): Record<string, unknown> | undefined => {
  try {
    const text = Buffer.from(body).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Classify a nested metadata image URI. Private/link-local/literal denials
 * must not escape as a safe image field — only a denied stub is returned.
 */
export const classifyUntrustedImageRef = (
  raw: string | undefined,
): UntrustedImageRef | undefined => {
  if (raw === undefined) return undefined;

  const parsed = parseMetadataUrl(raw);
  if (isUrlPolicyError(parsed)) {
    // Do not echo denied private literals or credentialed URLs.
    const leaksLiteral =
      parsed.reason === "denied_address" ||
      /:\d+|@|\?/.test(raw) ||
      /^\s*https?:\/\/(?:\d+\.){3}\d+/i.test(raw) ||
      /^\s*https?:\/\/\[/i.test(raw);
    if (leaksLiteral) {
      return {
        kind: "untrusted_metadata_image_ref",
        requires_egress_fetch: true,
        safe_uri: undefined,
        uri_sha256: redactUri(raw).uri_sha256,
        denied_inline: true,
        denial_reason: parsed.reason,
      };
    }
    const redacted = redactUri(raw);
    return {
      kind: "untrusted_metadata_image_ref",
      requires_egress_fetch: true,
      safe_uri: redacted.safe_uri === "invalid://" ? undefined : redacted.safe_uri,
      uri_sha256: redacted.uri_sha256,
      denied_inline: true,
      denial_reason: parsed.reason,
    };
  }

  if (parsed.host_is_ip_literal) {
    const classified = classifyIpAddress(parsed.hostname);
    if (classified.denied) {
      return {
        kind: "untrusted_metadata_image_ref",
        requires_egress_fetch: true,
        safe_uri: undefined,
        uri_sha256: redactUri(raw).uri_sha256,
        denied_inline: true,
        denial_reason: "denied_address",
      };
    }
  }

  const redacted = redactUri(parsed.url.href);
  return {
    kind: "untrusted_metadata_image_ref",
    requires_egress_fetch: true,
    safe_uri: redacted.safe_uri,
    uri_sha256: redacted.uri_sha256,
    denied_inline: false,
    denial_reason: undefined,
  };
};

const diagnosticsFromRetrieval = (
  retrieval: MetadataRetrievalResult,
): RemoteMetadataEnrichment["diagnostics"] => {
  if (retrieval.outcome === "partial") {
    return {
      reason: retrieval.reason,
      safe_message: retrieval.safe_message,
      requested_uri: retrieval.provenance.requested_uri,
      requested_uri_sha256: retrieval.provenance.requested_uri_sha256,
      final_url: retrieval.provenance.final_url,
      final_url_sha256: retrieval.provenance.final_url_sha256,
      pinned_address: retrieval.provenance.pinned_address,
      terminal_address_class: retrieval.provenance.terminal_address_class,
      retrieved_at: retrieval.provenance.retrieved_at,
      content_type: retrieval.provenance.content_type,
      content_sha256: retrieval.provenance.content_sha256,
      byte_size: retrieval.provenance.byte_size,
    };
  }
  return {
    reason: undefined,
    safe_message: undefined,
    requested_uri: retrieval.provenance.requested_uri,
    requested_uri_sha256: retrieval.provenance.requested_uri_sha256,
    final_url: retrieval.provenance.final_url,
    final_url_sha256: retrieval.provenance.final_url_sha256,
    pinned_address: retrieval.provenance.pinned_address,
    terminal_address_class: retrieval.provenance.terminal_address_class,
    retrieved_at: retrieval.provenance.retrieved_at,
    content_type: retrieval.content_type,
    content_sha256: retrieval.provenance.content_sha256,
    byte_size: retrieval.provenance.byte_size,
  };
};

/**
 * Fetch remote collection metadata through the sole egress boundary and map
 * failures to partial candidate diagnostics.
 */
export const enrichCandidateFromRemoteMetadata = async (input: {
  readonly uri: string;
  readonly purpose?: MetadataRetrievalPurpose;
  readonly deps: RetrieveMetadataDeps;
  readonly now?: () => Date;
}): Promise<RemoteMetadataEnrichment> => {
  const purpose = input.purpose ?? "collection_metadata";
  const retrieval = await retrieveMetadata(
    {
      uri: input.uri,
      purpose,
      now: input.now,
    },
    input.deps,
  );

  if (retrieval.outcome === "partial") {
    const quality: CandidateMetadataQuality =
      retrieval.reason === "missing" ? "unavailable" : "partial";
    return {
      metadata_quality: quality,
      image: undefined,
      untrusted_image_ref: undefined,
      name: undefined,
      symbol: undefined,
      diagnostics: diagnosticsFromRetrieval(retrieval),
      retrieval,
    };
  }

  if (purpose === "collection_image") {
    // Bytes were fetched and positively validated through the boundary.
    // Still do not expose a trusted renderable URL — Dashboard must use the
    // authenticated image proxy / a subsequent policy-bound path.
    return {
      metadata_quality: "external_pointer",
      image: undefined,
      untrusted_image_ref: {
        kind: "untrusted_metadata_image_ref",
        requires_egress_fetch: true,
        safe_uri: retrieval.provenance.final_url,
        uri_sha256: retrieval.provenance.final_url_sha256,
        denied_inline: false,
        denial_reason: undefined,
      },
      name: undefined,
      symbol: undefined,
      diagnostics: diagnosticsFromRetrieval(retrieval),
      retrieval,
    };
  }

  const json = parseJsonObject(retrieval.body);
  if (json === undefined) {
    return {
      metadata_quality: "partial",
      image: undefined,
      untrusted_image_ref: undefined,
      name: undefined,
      symbol: undefined,
      diagnostics: {
        ...diagnosticsFromRetrieval(retrieval),
        reason: "hostile_content",
        safe_message: "metadata JSON could not be parsed safely",
      },
      retrieval: {
        outcome: "partial",
        reason: "hostile_content",
        safe_message: "metadata JSON could not be parsed safely",
        provenance: {
          requested_uri: retrieval.provenance.requested_uri,
          requested_uri_sha256: retrieval.provenance.requested_uri_sha256,
          retrieved_at: retrieval.provenance.retrieved_at,
          final_url: retrieval.provenance.final_url,
          final_url_sha256: retrieval.provenance.final_url_sha256,
          pinned_address: retrieval.provenance.pinned_address,
          address_family: retrieval.provenance.address_family,
          terminal_address_class: retrieval.provenance.terminal_address_class,
          content_type: retrieval.content_type,
          content_sha256: retrieval.provenance.content_sha256,
          byte_size: retrieval.provenance.byte_size,
          redirect_count: retrieval.provenance.redirect_count,
          failure_reason: "hostile_content",
        },
      },
    };
  }

  return {
    metadata_quality: "external_pointer",
    image: undefined,
    untrusted_image_ref: classifyUntrustedImageRef(asOptionalString(json.image)),
    name: asOptionalString(json.name),
    symbol: asOptionalString(json.symbol),
    diagnostics: diagnosticsFromRetrieval(retrieval),
    retrieval,
  };
};
