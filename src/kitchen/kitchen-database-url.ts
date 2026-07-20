/**
 * Kitchen durable-store URL resolution (sonar-api#236).
 *
 * Belt `ENVIO_RESTART=1` wipes the Envio schema on the indexer Postgres.
 * Kitchen job identity must never share that wipe target. Production therefore
 * requires `KITCHEN_DATABASE_URL` on a dedicated database (or wipe-exempt
 * service). The historical `ENVIO_PG_*` fallback is opt-in only.
 */

export type KitchenDatabaseEnv = {
  KITCHEN_DATABASE_URL?: string;
  KITCHEN_ALLOW_ENVIO_PG_FALLBACK?: string;
  NODE_ENV?: string;
  ENVIO_PG_HOST?: string;
  ENVIO_PG_PORT?: string;
  ENVIO_PG_USER?: string;
  ENVIO_PG_PASSWORD?: string;
  ENVIO_PG_DATABASE?: string;
};

export function envioPgUrlFromEnv(env: KitchenDatabaseEnv = process.env): string | undefined {
  const host = env.ENVIO_PG_HOST?.trim();
  const port = env.ENVIO_PG_PORT?.trim();
  const user = env.ENVIO_PG_USER?.trim();
  const password = env.ENVIO_PG_PASSWORD?.trim();
  const database = env.ENVIO_PG_DATABASE?.trim();
  if (!host || !user || !database) return undefined;
  const encodedPassword = password ? encodeURIComponent(password) : "";
  const auth = encodedPassword ? `${user}:${encodedPassword}` : user;
  return `postgresql://${auth}@${host}:${port ?? "5432"}/${database}`;
}

export function isProductionNodeEnv(env: KitchenDatabaseEnv = process.env): boolean {
  const nodeEnv = env.NODE_ENV?.trim();
  return nodeEnv === "production" || nodeEnv === "prod";
}

export function allowEnvioPgFallback(env: KitchenDatabaseEnv = process.env): boolean {
  return env.KITCHEN_ALLOW_ENVIO_PG_FALLBACK?.trim() === "1";
}

/**
 * Resolve Kitchen Postgres URL.
 * - Prefer `KITCHEN_DATABASE_URL` always.
 * - Production: refuse silent `ENVIO_PG_*` fallback (throws).
 * - Non-prod: allow `ENVIO_PG_*` only with `KITCHEN_ALLOW_ENVIO_PG_FALLBACK=1`.
 */
export function resolveKitchenDatabaseUrl(
  env: KitchenDatabaseEnv = process.env,
): string | undefined {
  const direct = env.KITCHEN_DATABASE_URL?.trim();
  if (direct) return direct;

  const fallback = envioPgUrlFromEnv(env);
  if (!fallback) return undefined;

  if (isProductionNodeEnv(env)) {
    throw new Error(
      "KITCHEN_DATABASE_URL is required in production. " +
        "ENVIO_PG_* fallback is refused so belt ENVIO_RESTART wipes cannot drop Kitchen tables (sonar-api#236). " +
        "Set KITCHEN_DATABASE_URL to a dedicated Postgres (not the belt wipe target).",
    );
  }

  if (!allowEnvioPgFallback(env)) {
    return undefined;
  }

  return fallback;
}

/** Normalize URLs for co-location compare (strip query / trailing slash). */
export function normalizePgUrlForCompare(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    let href = u.href;
    if (href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch {
    return url.trim().replace(/\/+$/, "").split("?")[0] ?? url;
  }
}

export function kitchenSharesBeltWipeTarget(args: {
  kitchenUrl: string;
  beltUrl?: string;
}): boolean {
  if (!args.beltUrl) return false;
  return (
    normalizePgUrlForCompare(args.kitchenUrl) ===
    normalizePgUrlForCompare(args.beltUrl)
  );
}
