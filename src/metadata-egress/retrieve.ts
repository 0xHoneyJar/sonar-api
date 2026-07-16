/**
 * Hardened metadata retrieval boundary (CR-004).
 *
 * Deny-by-default: scheme → host → port allowlist → DNS (every answer) → pin
 * public address → connect to pinned address → re-validate on every redirect.
 * Returns typed ok/partial results; never turns hostile/missing metadata into
 * an exception. Provenance is redacted and includes content digest + address
 * class (SDD §11.3).
 */

import { assertServerOnlyMetadataEgress } from "./browser-boundary.js";
import { classifyIpAddress } from "./address-policy.js";
import {
  evaluateContentType,
  evaluateRetrievedContent,
} from "./content-policy.js";
import { decompressBounded } from "./decompress.js";
import {
  assertNoSensitiveHeadersForwarded,
  buildEgressRequestHeaders,
  sanitizeCallerHeaders,
} from "./headers.js";
import {
  DEFAULT_METADATA_EGRESS_LIMITS,
  type MetadataEgressLimits,
} from "./limits.js";
import type {
  MetadataEgressClock,
  MetadataEgressDeadlineScheduler,
  MetadataEgressPorts,
} from "./ports.js";
import {
  buildRequestedProvenance,
  redactUri,
  sha256Hex,
} from "./provenance.js";
import type {
  AddressFamily,
  MetadataFailureReason,
  MetadataPartial,
  MetadataRetrievalProvenance,
  MetadataRetrievalRequest,
  MetadataRetrievalResult,
  TransportResponse,
  ValidatedTarget,
} from "./types.js";
import { isUrlPolicyError, parseMetadataUrl } from "./url-policy.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PROCESS_CLOCK: MetadataEgressClock = {
  nowMs: () => performance.now(),
};

const PROCESS_SCHEDULER: MetadataEgressDeadlineScheduler = {
  scheduleAt: (at_ms, callback) => {
    const handle = setTimeout(callback, Math.max(0, at_ms - performance.now()));
    return () => clearTimeout(handle);
  },
};

const partial = (
  reason: MetadataFailureReason,
  safe_message: string,
  provenance: MetadataPartial["provenance"],
): MetadataPartial => ({
  outcome: "partial",
  reason,
  safe_message,
  provenance: {
    ...provenance,
    failure_reason: reason,
  },
});

const nowIso = (request: MetadataRetrievalRequest): string =>
  (request.now?.() ?? new Date()).toISOString();

const selectPinnedPublicAddress = (
  answers: ReadonlyArray<{ address: string; family: AddressFamily }>,
):
  | {
      readonly ok: true;
      readonly address: string;
      readonly family: AddressFamily;
      readonly terminal_address_class: ValidatedTarget["terminal_address_class"];
    }
  | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string } => {
  if (answers.length === 0) {
    return {
      ok: false,
      reason: "dns_resolution_failed",
      safe_message: "DNS returned no addresses",
    };
  }

  let publicCandidate:
    | {
        address: string;
        family: AddressFamily;
        terminal_address_class: ValidatedTarget["terminal_address_class"];
      }
    | undefined;

  for (const answer of answers) {
    const classified = classifyIpAddress(answer.address);
    if (classified.denied) {
      // Fail closed on mixed public/private (or any denied) answer sets.
      return {
        ok: false,
        reason: "denied_address",
        safe_message: `DNS answer denied (${classified.reason ?? "policy"}): refusing mixed or hostile resolution`,
      };
    }
    if (publicCandidate === undefined) {
      publicCandidate = {
        address: classified.canonical,
        family: classified.family,
        terminal_address_class: classified.terminal_address_class,
      };
    }
  }

  if (publicCandidate === undefined) {
    return {
      ok: false,
      reason: "denied_address",
      safe_message: "no validated public address available after DNS policy",
    };
  }

  return {
    ok: true,
    address: publicCandidate.address,
    family: publicCandidate.family,
    terminal_address_class: publicCandidate.terminal_address_class,
  };
};

const resolveTarget = async (input: {
  readonly rawUrl: string;
  readonly ports: MetadataEgressPorts;
  readonly allowed_ports: ReadonlyArray<number>;
  readonly dns_timeout_ms: number;
  readonly clock: MetadataEgressClock;
  readonly scheduler: MetadataEgressDeadlineScheduler;
}): Promise<
  | { readonly ok: true; readonly target: ValidatedTarget }
  | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string }
> => {
  const parsed = parseMetadataUrl(input.rawUrl, {
    allowed_ports: input.allowed_ports,
  });
  if (isUrlPolicyError(parsed)) {
    return { ok: false, reason: parsed.reason, safe_message: parsed.safe_message };
  }

  if (parsed.host_is_ip_literal) {
    const classified = classifyIpAddress(parsed.hostname);
    if (classified.denied) {
      return {
        ok: false,
        reason: "denied_address",
        safe_message: `IP literal denied (${classified.reason ?? "policy"})`,
      };
    }
    return {
      ok: true,
      target: {
        url: parsed.url,
        hostname: parsed.hostname,
        port: parsed.port,
        scheme: parsed.scheme,
        pinned_address: classified.canonical,
        address_family: classified.family,
        terminal_address_class: classified.terminal_address_class,
        host_authority: parsed.host_authority,
      },
    };
  }

  const controller = new AbortController();
  const deadlineAt = input.clock.nowMs() + Math.max(0, input.dns_timeout_ms);
  const answers = await new Promise<
    | { readonly ok: true; readonly answers: ReadonlyArray<{ address: string; family: AddressFamily }> }
    | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string }
  >((resolve) => {
    let settled = false;
    let cancelDeadline: () => void = () => undefined;
    const finish = (
      result:
        | { readonly ok: true; readonly answers: ReadonlyArray<{ address: string; family: AddressFamily }> }
        | { readonly ok: false; readonly reason: MetadataFailureReason; readonly safe_message: string },
    ) => {
      if (settled) return;
      settled = true;
      cancelDeadline();
      resolve(result);
    };

    let work: Promise<ReadonlyArray<{ address: string; family: AddressFamily }>>;
    try {
      work = input.ports.dns.lookup(parsed.hostname, {
        signal: controller.signal,
      });
    } catch {
      finish({
        ok: false,
        reason: "dns_resolution_failed",
        safe_message: "DNS resolution failed",
      });
      return;
    }
    cancelDeadline = input.scheduler.scheduleAt(deadlineAt, () => {
      controller.abort("dns_timeout");
      finish({
        ok: false,
        reason: "dns_timeout",
        safe_message: "DNS resolution deadline exceeded",
      });
    });
    void work.then(
      (resolved) => finish({ ok: true, answers: resolved }),
      () =>
        finish({
          ok: false,
          reason: controller.signal.aborted ? "dns_timeout" : "dns_resolution_failed",
          safe_message: controller.signal.aborted
            ? "DNS resolution deadline exceeded"
            : "DNS resolution failed",
        }),
    );
  });

  if (!answers.ok) return answers;

  const pinned = selectPinnedPublicAddress(answers.answers);
  if (!pinned.ok) {
    return { ok: false, reason: pinned.reason, safe_message: pinned.safe_message };
  }

  return {
    ok: true,
    target: {
      url: parsed.url,
      hostname: parsed.hostname,
      port: parsed.port,
      scheme: parsed.scheme,
      pinned_address: pinned.address,
      address_family: pinned.family,
      terminal_address_class: pinned.terminal_address_class,
      host_authority: parsed.host_authority,
    },
  };
};

const headerValue = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const mapTransportError = (
  cause: unknown,
): { reason: MetadataFailureReason; safe_message: string } => {
  const message = cause instanceof Error ? cause.message : "transport error";
  if (/connect.?timeout/i.test(message)) {
    return { reason: "connect_timeout", safe_message: "connect deadline exceeded" };
  }
  if (/header.?timeout/i.test(message)) {
    return { reason: "header_timeout", safe_message: "header deadline exceeded" };
  }
  if (/body.?timeout/i.test(message)) {
    return { reason: "body_timeout", safe_message: "body deadline exceeded" };
  }
  if (/compressed.?size/i.test(message)) {
    return {
      reason: "compressed_size_exceeded",
      safe_message: "compressed body exceeds byte limit",
    };
  }
  if (/certificate|tls|ssl/i.test(message)) {
    return { reason: "tls_error", safe_message: "TLS verification failed" };
  }
  return { reason: "http_error", safe_message: "metadata transport failed" };
};

const redactFinal = (href: string) => redactUri(href);

export interface RetrieveMetadataDeps {
  readonly ports: MetadataEgressPorts;
  readonly limits?: MetadataEgressLimits;
  /** Inject both against the same monotonic coordinate for hermetic deadlines. */
  readonly clock?: MetadataEgressClock;
  readonly scheduler?: MetadataEgressDeadlineScheduler;
  /**
   * Optional caller header map — always sanitized to empty; present so tests
   * can prove ambient/credential headers are never forwarded.
   */
  readonly ambient_headers?: Readonly<Record<string, string>>;
}

/**
 * Sole metadata network entrypoint for resolver and report workers.
 */
export const retrieveMetadata = async (
  request: MetadataRetrievalRequest,
  deps: RetrieveMetadataDeps,
): Promise<MetadataRetrievalResult> => {
  const limits = deps.limits ?? DEFAULT_METADATA_EGRESS_LIMITS;
  const clock = deps.clock ?? PROCESS_CLOCK;
  const scheduler = deps.scheduler ?? PROCESS_SCHEDULER;
  assertServerOnlyMetadataEgress();
  const retrievedAt = nowIso(request);
  const baseProvenance = buildRequestedProvenance({
    raw_uri: request.uri,
    retrieved_at: retrievedAt,
  });

  if ((deps.clock === undefined) !== (deps.scheduler === undefined)) {
    return partial(
      "internal_misconfiguration",
      "metadata egress clock and scheduler must be injected together",
      {
        ...baseProvenance,
        redirect_count: 0,
      },
    );
  }

  // Caller ambient headers are accepted only to prove they are discarded.
  sanitizeCallerHeaders(deps.ambient_headers);

  let currentUrl = request.uri;
  // Keep only one-way loop keys in memory; URLs may contain bearer query data.
  const seen = new Set<string>();
  let redirectCount = 0;
  let lastTarget: ValidatedTarget | undefined;

  while (redirectCount <= limits.max_redirects) {
    const loopKey = sha256Hex(new TextEncoder().encode(currentUrl));
    if (seen.has(loopKey)) {
      const final = redactFinal(currentUrl);
      return partial("redirect_loop", "redirect loop detected", {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        redirect_count: redirectCount,
        pinned_address: lastTarget?.pinned_address,
        address_family: lastTarget?.address_family,
        terminal_address_class: lastTarget?.terminal_address_class,
      });
    }
    seen.add(loopKey);

    const resolved = await resolveTarget({
      rawUrl: currentUrl,
      ports: deps.ports,
      allowed_ports: limits.allowed_ports,
      dns_timeout_ms: limits.dns_timeout_ms,
      clock,
      scheduler,
    });
    if (!resolved.ok) {
      const final = redactFinal(currentUrl);
      return partial(resolved.reason, resolved.safe_message, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        redirect_count: redirectCount,
        pinned_address: lastTarget?.pinned_address,
        address_family: lastTarget?.address_family,
        terminal_address_class: lastTarget?.terminal_address_class,
      });
    }

    lastTarget = resolved.target;
    const headers = buildEgressRequestHeaders({
      purpose: request.purpose,
      host_authority: resolved.target.host_authority,
    });
    assertNoSensitiveHeadersForwarded(headers);

    let response: TransportResponse;
    try {
      response = await deps.ports.transport.exchange({
        target: resolved.target,
        method: "GET",
        headers,
        connect_timeout_ms: limits.connect_timeout_ms,
        header_timeout_ms: limits.header_timeout_ms,
        body_timeout_ms: limits.body_timeout_ms,
        max_compressed_bytes: limits.max_compressed_bytes,
      });
    } catch (cause) {
      const mapped = mapTransportError(cause);
      const final = redactFinal(resolved.target.url.href);
      return partial(mapped.reason, mapped.safe_message, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        pinned_address: resolved.target.pinned_address,
        address_family: resolved.target.address_family,
        terminal_address_class: resolved.target.terminal_address_class,
        redirect_count: redirectCount,
      });
    }

    if (response.body.byteLength > limits.max_compressed_bytes) {
      const final = redactFinal(resolved.target.url.href);
      return partial(
        "compressed_size_exceeded",
        "compressed body exceeds byte limit",
        {
          ...baseProvenance,
          final_url: final.safe_uri,
          final_url_sha256: final.uri_sha256,
          pinned_address: resolved.target.pinned_address,
          address_family: resolved.target.address_family,
          terminal_address_class: resolved.target.terminal_address_class,
          redirect_count: redirectCount,
          byte_size: response.body.byteLength,
        },
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = headerValue(response.headers, "location");
      if (location === undefined || location.trim() === "") {
        const final = redactFinal(resolved.target.url.href);
        return partial("http_error", "redirect missing Location header", {
          ...baseProvenance,
          final_url: final.safe_uri,
          final_url_sha256: final.uri_sha256,
          pinned_address: resolved.target.pinned_address,
          address_family: resolved.target.address_family,
          terminal_address_class: resolved.target.terminal_address_class,
          redirect_count: redirectCount,
        });
      }
      redirectCount += 1;
      if (redirectCount > limits.max_redirects) {
        const final = redactFinal(resolved.target.url.href);
        return partial("redirect_limit", "redirect count exceeded", {
          ...baseProvenance,
          final_url: final.safe_uri,
          final_url_sha256: final.uri_sha256,
          pinned_address: resolved.target.pinned_address,
          address_family: resolved.target.address_family,
          terminal_address_class: resolved.target.terminal_address_class,
          redirect_count: redirectCount,
        });
      }
      // Absolute or relative Location — resolve against current URL, then
      // re-run full scheme/DNS/address/port validation on the next loop.
      // Malformed Location must become typed partial, never throw.
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, resolved.target.url);
      } catch {
        const final = redactFinal(resolved.target.url.href);
        return partial("invalid_redirect", "redirect Location is not a valid URL", {
          ...baseProvenance,
          final_url: final.safe_uri,
          final_url_sha256: final.uri_sha256,
          pinned_address: resolved.target.pinned_address,
          address_family: resolved.target.address_family,
          terminal_address_class: resolved.target.terminal_address_class,
          redirect_count: redirectCount,
        });
      }
      currentUrl = nextUrl.href;
      continue;
    }

    const final = redactFinal(resolved.target.url.href);

    if (response.status === 404 || response.status === 410) {
      return partial("missing", `metadata resource HTTP ${response.status}`, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        pinned_address: resolved.target.pinned_address,
        address_family: resolved.target.address_family,
        terminal_address_class: resolved.target.terminal_address_class,
        redirect_count: redirectCount,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      return partial("http_error", `metadata HTTP ${response.status}`, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        pinned_address: resolved.target.pinned_address,
        address_family: resolved.target.address_family,
        terminal_address_class: resolved.target.terminal_address_class,
        redirect_count: redirectCount,
      });
    }

    const decompressed = decompressBounded({
      body: response.body,
      content_encoding: headerValue(response.headers, "content-encoding"),
      max_decompressed_bytes: limits.max_decompressed_bytes,
    });
    if (!decompressed.ok) {
      return partial(decompressed.reason, decompressed.safe_message, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        pinned_address: resolved.target.pinned_address,
        address_family: resolved.target.address_family,
        terminal_address_class: resolved.target.terminal_address_class,
        redirect_count: redirectCount,
        byte_size: response.body.byteLength,
        content_type: normalizeHeaderContentType(response.headers),
      });
    }

    const typeEval = evaluateContentType({
      purpose: request.purpose,
      content_type: headerValue(response.headers, "content-type"),
    });
    if (!typeEval.ok) {
      return partial(typeEval.reason, typeEval.safe_message, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        pinned_address: resolved.target.pinned_address,
        address_family: resolved.target.address_family,
        terminal_address_class: resolved.target.terminal_address_class,
        redirect_count: redirectCount,
        byte_size: decompressed.body.byteLength,
        content_type: normalizeHeaderContentType(response.headers),
      });
    }

    const contentEval = evaluateRetrievedContent({
      purpose: request.purpose,
      content_type: typeEval.content_type,
      body: decompressed.body,
    });
    if (!contentEval.ok) {
      return partial(contentEval.reason, contentEval.safe_message, {
        ...baseProvenance,
        final_url: final.safe_uri,
        final_url_sha256: final.uri_sha256,
        pinned_address: resolved.target.pinned_address,
        address_family: resolved.target.address_family,
        terminal_address_class: resolved.target.terminal_address_class,
        redirect_count: redirectCount,
        byte_size: decompressed.body.byteLength,
        content_type: typeEval.content_type,
        content_sha256: sha256Hex(decompressed.body),
      });
    }

    const contentDigest = sha256Hex(decompressed.body);
    const provenance: MetadataRetrievalProvenance = {
      requested_uri: baseProvenance.requested_uri,
      requested_uri_sha256: baseProvenance.requested_uri_sha256,
      final_url: final.safe_uri,
      final_url_sha256: final.uri_sha256,
      pinned_address: resolved.target.pinned_address,
      address_family: resolved.target.address_family,
      terminal_address_class: resolved.target.terminal_address_class,
      retrieved_at: retrievedAt,
      content_type: typeEval.content_type,
      content_sha256: contentDigest,
      byte_size: decompressed.body.byteLength,
      redirect_count: redirectCount,
      failure_reason: undefined,
    };

    return {
      outcome: "ok",
      body: decompressed.body,
      content_type: typeEval.content_type,
      provenance,
    };
  }

  const final = redactFinal(currentUrl);
  return partial("redirect_limit", "redirect count exceeded", {
    ...baseProvenance,
    final_url: final.safe_uri,
    final_url_sha256: final.uri_sha256,
    redirect_count: redirectCount,
    pinned_address: lastTarget?.pinned_address,
    address_family: lastTarget?.address_family,
    terminal_address_class: lastTarget?.terminal_address_class,
  });
};

const normalizeHeaderContentType = (
  headers: Readonly<Record<string, string>>,
): string | undefined => headerValue(headers, "content-type");
