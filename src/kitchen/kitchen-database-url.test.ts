import { describe, expect, it } from "vitest";

import {
  envioPgUrlFromEnv,
  kitchenSharesBeltWipeTarget,
  normalizePgUrlForCompare,
  resolveKitchenDatabaseUrl,
} from "./kitchen-database-url.js";

describe("resolveKitchenDatabaseUrl", () => {
  it("prefers KITCHEN_DATABASE_URL", () => {
    expect(
      resolveKitchenDatabaseUrl({
        KITCHEN_DATABASE_URL: "postgresql://kitchen/db",
        ENVIO_PG_HOST: "belt",
        ENVIO_PG_USER: "u",
        ENVIO_PG_DATABASE: "envio",
        NODE_ENV: "production",
      }),
    ).toBe("postgresql://kitchen/db");
  });

  it("refuses ENVIO_PG fallback in production", () => {
    expect(() =>
      resolveKitchenDatabaseUrl({
        ENVIO_PG_HOST: "belt.internal",
        ENVIO_PG_USER: "u",
        ENVIO_PG_PASSWORD: "p",
        ENVIO_PG_DATABASE: "envio",
        NODE_ENV: "production",
      }),
    ).toThrow(/KITCHEN_DATABASE_URL is required in production/);
  });

  it("ignores ENVIO_PG in non-prod without escape hatch", () => {
    expect(
      resolveKitchenDatabaseUrl({
        ENVIO_PG_HOST: "belt.internal",
        ENVIO_PG_USER: "u",
        ENVIO_PG_DATABASE: "envio",
        NODE_ENV: "development",
      }),
    ).toBeUndefined();
  });

  it("allows ENVIO_PG only with KITCHEN_ALLOW_ENVIO_PG_FALLBACK=1 in non-prod", () => {
    expect(
      resolveKitchenDatabaseUrl({
        ENVIO_PG_HOST: "belt.internal",
        ENVIO_PG_PORT: "5432",
        ENVIO_PG_USER: "u",
        ENVIO_PG_PASSWORD: "p@ss",
        ENVIO_PG_DATABASE: "envio",
        NODE_ENV: "development",
        KITCHEN_ALLOW_ENVIO_PG_FALLBACK: "1",
      }),
    ).toBe("postgresql://u:p%40ss@belt.internal:5432/envio");
  });
});

describe("kitchenSharesBeltWipeTarget", () => {
  it("detects co-located wipe target", () => {
    const url = "postgresql://u:p@host:5432/db?sslmode=require";
    expect(
      kitchenSharesBeltWipeTarget({
        kitchenUrl: url,
        beltUrl: "postgresql://u:p@host:5432/db",
      }),
    ).toBe(true);
    expect(normalizePgUrlForCompare(url)).toBe(
      normalizePgUrlForCompare("postgresql://u:p@host:5432/db"),
    );
  });

  it("envioPgUrlFromEnv builds belt URL", () => {
    expect(
      envioPgUrlFromEnv({
        ENVIO_PG_HOST: "h",
        ENVIO_PG_USER: "u",
        ENVIO_PG_DATABASE: "d",
      }),
    ).toBe("postgresql://u@h:5432/d");
  });
});
