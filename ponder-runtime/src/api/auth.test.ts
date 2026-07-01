import { describe, expect, it } from "vitest";

import { extractBearerToken, isAuthorizedRequest } from "./auth";

describe("extractBearerToken", () => {
  it("parses Bearer tokens case-insensitively", () => {
    expect(extractBearerToken("Bearer secret-token")).toBe("secret-token");
    expect(extractBearerToken("bearer secret-token")).toBe("secret-token");
  });

  it("returns undefined for missing or malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
  });
});

describe("isAuthorizedRequest", () => {
  it("allows all requests when SERVICE_TOKEN is unset", () => {
    expect(isAuthorizedRequest(undefined, undefined)).toBe(true);
    expect(isAuthorizedRequest("Bearer anything", undefined)).toBe(true);
  });

  it("requires exact bearer match when token is configured", () => {
    expect(isAuthorizedRequest("Bearer expected", "expected")).toBe(true);
    expect(isAuthorizedRequest("Bearer wrong", "expected")).toBe(false);
  });
});
