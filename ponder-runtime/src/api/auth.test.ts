import { describe, expect, it } from "vitest";

import { extractBearerToken, isAuthorizedRequest, kitchenAuthAllowOpen } from "./auth";

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
  it("allows open auth only when kitchenAuthAllowOpen is true", () => {
    const prevNode = process.env.NODE_ENV;
    const prevAllow = process.env.SONAR_KITCHEN_ALLOW_OPEN_AUTH;
    process.env.NODE_ENV = "development";
    delete process.env.SONAR_KITCHEN_ALLOW_OPEN_AUTH;
    expect(kitchenAuthAllowOpen()).toBe(true);
    expect(isAuthorizedRequest(undefined, undefined)).toBe(true);

    process.env.NODE_ENV = "production";
    expect(kitchenAuthAllowOpen()).toBe(false);
    expect(isAuthorizedRequest(undefined, undefined)).toBe(false);

    process.env.SONAR_KITCHEN_ALLOW_OPEN_AUTH = "true";
    expect(kitchenAuthAllowOpen()).toBe(true);
    expect(isAuthorizedRequest(undefined, undefined)).toBe(true);

    process.env.NODE_ENV = prevNode;
    if (prevAllow === undefined) delete process.env.SONAR_KITCHEN_ALLOW_OPEN_AUTH;
    else process.env.SONAR_KITCHEN_ALLOW_OPEN_AUTH = prevAllow;
  });

  it("requires exact bearer match when token is configured", () => {
    expect(isAuthorizedRequest("Bearer expected", "expected")).toBe(true);
    expect(isAuthorizedRequest("Bearer wrong", "expected")).toBe(false);
  });
});
