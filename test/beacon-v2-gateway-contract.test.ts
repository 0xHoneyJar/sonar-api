import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

describe("beacon v2 gateway contract", () => {
  it("committed beacon exposes fields required for MCP gateway tenant stub", () => {
    const beaconPath = resolve(import.meta.dirname, "../beacon.yaml");
    const doc = parseYaml(readFileSync(beaconPath, "utf8")) as {
      read_surface: {
        graphql: { endpoint: string; alias: string };
        auth: { kind: string };
        mcp: { shape: string; tools: string[] };
      };
    };

    expect(doc.read_surface.graphql.endpoint).toMatch(/^https:\/\//);
    expect(doc.read_surface.auth.kind).toBe("none");
    expect(doc.read_surface.mcp.shape).toBe("proxy");
    expect(doc.read_surface.mcp.tools).toContain("graphql");
  });
});
