import type { Context, Next } from "hono";

/**
 * Bearer auth for kitchen upstream routes.
 * Mirrors ordering-service `advance-ingredient` gate:
 * `auth !== \`Bearer ${serviceToken}\`` → 401.
 *
 * Env: `SERVICE_TOKEN` — required in production unless
 * `SONAR_KITCHEN_ALLOW_OPEN_AUTH=true` (local dev only).
 */
export function serviceTokenFromEnv(): string | undefined {
  const token = process.env.SERVICE_TOKEN?.trim();
  return token || undefined;
}

export function kitchenAuthAllowOpen(): boolean {
  if (process.env.SONAR_KITCHEN_ALLOW_OPEN_AUTH === "true") return true;
  const nodeEnv = process.env.NODE_ENV?.trim();
  return nodeEnv !== "production" && nodeEnv !== "prod";
}

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || undefined;
}

export function isAuthorizedRequest(
  authorization: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return kitchenAuthAllowOpen();
  const presented = extractBearerToken(authorization);
  return presented === expectedToken;
}

export async function requireServiceToken(c: Context, next: Next) {
  const expected = serviceTokenFromEnv();
  if (!expected && !kitchenAuthAllowOpen()) {
    return c.json({ error: "service_token_not_configured" }, 503);
  }
  if (!isAuthorizedRequest(c.req.header("authorization"), expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
}
