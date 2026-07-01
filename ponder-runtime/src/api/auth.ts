import type { Context, Next } from "hono";

/**
 * Bearer auth for kitchen upstream routes.
 * Mirrors ordering-service `advance-ingredient` gate:
 * `auth !== \`Bearer ${serviceToken}\`` → 401.
 *
 * Env: `SERVICE_TOKEN` — required in production; unset allows local dev without auth.
 */
export function serviceTokenFromEnv(): string | undefined {
  const token = process.env.SERVICE_TOKEN?.trim();
  return token || undefined;
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
  if (!expectedToken) return true;
  const presented = extractBearerToken(authorization);
  return presented === expectedToken;
}

export async function requireServiceToken(c: Context, next: Next) {
  const expected = serviceTokenFromEnv();
  if (!isAuthorizedRequest(c.req.header("authorization"), expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
}
