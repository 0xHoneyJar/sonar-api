/**
 * Safe diagnostics / redaction helpers for CR-102.
 *
 * Never expose credentials, raw provider bodies, private metadata, user identity
 * in high-cardinality labels, or unchecked exception strings.
 */

const SECRET_PATTERN =
  /(api[_-]?key|secret|password|passwd|token|bearer|authorization|private[_-]?key|credential|cookie|session|SUPERSECRET)/i;

const QUERY_SECRET =
  /([?&](?:api_key|access_token|token|secret|key|password|auth)=)[^&\s]+/gi;

const HEX_LONG = /[0-9a-fA-F]{32,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export const redactSafeMessage = (raw: string, maxLen = 256): string => {
  let value = raw.replace(EMAIL, "[redacted-email]");
  value = value.replace(BEARER, "Bearer [redacted]");
  value = value.replace(QUERY_SECRET, "$1[redacted]");
  value = value.replace(HEX_LONG, "[redacted-hex]");
  if (SECRET_PATTERN.test(value)) {
    return "redacted: secret-like diagnostic suppressed";
  }
  if (value.length > maxLen) {
    return `${value.slice(0, maxLen - 1)}…`;
  }
  return value;
};

export const safeErrorLabel = (cause: unknown): string => {
  if (cause === null || cause === undefined) return "unknown";
  if (typeof cause === "string") return redactSafeMessage(cause, 128);
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = String((cause as { _tag: unknown })._tag);
    // Never serialize Effect ParseError / Schema issue trees into public errors.
    if (tag === "ParseError" || tag.includes("Parse")) {
      return "schema_decode_failed";
    }
    return redactSafeMessage(tag, 64);
  }
  if (cause instanceof Error) {
    const name = cause.name || "Error";
    if (/parse|schema|decode/i.test(name) || /parse|schema|decode/i.test(cause.message)) {
      return "schema_decode_failed";
    }
    return redactSafeMessage(name, 64);
  }
  return "non_error_throwable";
};

/**
 * Strict-decode a public diagnostic payload — excess properties and secret-like
 * fields fail closed.
 */
export const assertSafeDiagnosticPayload = (value: unknown): void => {
  assertNoSecretLeak(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const allowed = new Set(["code", "network", "safe_message"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new Error(`diagnostic excess property refused: ${key}`);
      }
    }
  }
};

export const assertNoSecretLeak = (value: unknown, path = "$"): void => {
  if (typeof value === "string") {
    if (SECRET_PATTERN.test(value) && !value.startsWith("redacted:")) {
      throw new Error(`secret-like string leaked at ${path}`);
    }
    if (/\bSUPERSECRET\b/.test(value)) {
      throw new Error(`secret-like string leaked at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecretLeak(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_PATTERN.test(key)) {
        throw new Error(`secret-like key leaked at ${path}.${key}`);
      }
      assertNoSecretLeak(child, `${path}.${key}`);
    }
  }
};
