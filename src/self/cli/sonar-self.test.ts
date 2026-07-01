import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const REQUIRED_AC2_TYPES = [
  "Action",
  "TrackedHolder",
  "TrackedTokenBalance",
  "MintActivity",
  "SFPosition",
  "chain_metadata",
];

describe("sources.probe", () => {
  it("parses six EVM chains from config.yaml", async () => {
    const { parseSourcesFromConfig } = await import("../probes/sources.probe.js");
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const result = parseSourcesFromConfig(repoRoot);
    expect(result.status).toBe("verified");
    expect(result.value?.chains).toHaveLength(6);
    expect(result.value?.transport).toBe("hypersync");
    expect(result.value?.svm?.lane).toBe("src/svm/*");
  });
});

describe("secret-scrub", () => {
  it("rejects postgres credentials", async () => {
    const { scrubSecrets } = await import("../scrub/secret-scrub.js");
    const result = scrubSecrets("db: postgres://user:pass@host/db\n");
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("allows bare 64-char transaction hashes", async () => {
    const { scrubSecrets } = await import("../scrub/secret-scrub.js");
    const tx = "0x" + "a".repeat(64);
    const result = scrubSecrets(`transactionHash: ${tx}\n`);
    expect(result.ok).toBe(true);
  });

  it("rejects signing seed in key context", async () => {
    const { scrubSecrets } = await import("../scrub/secret-scrub.js");
    const result = scrubSecrets(`signing_key: ${"b".repeat(64)}\n`);
    expect(result.ok).toBe(false);
  });
});

describe("beacon-merge", () => {
  it("preserves declared events and consumers on merge", async () => {
    const { buildBeaconDraft } = await import("../merge/beacon-merge.js");
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const draft = await buildBeaconDraft({ repoRoot, mode: "offline" });
    expect(draft.events.status).toBe("unverified");
    expect(draft.consumers.length).toBeGreaterThan(0);
    expect(draft._generated_sections).toContain("sources");
  });
});

describe("beacon-diff", () => {
  it("detects chain drift", async () => {
    const { diffBeacon } = await import("../merge/beacon-diff.js");
    const { buildBeaconDraft } = await import("../merge/beacon-merge.js");
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const live = await buildBeaconDraft({ repoRoot, mode: "offline" });
    const stale = structuredClone(live);
    if (stale.sources && typeof stale.sources === "object" && "chains" in stale.sources) {
      (stale.sources as { chains: Array<{ id: number }> }).chains.pop();
    }
    const drifts = diffBeacon(stale, live, repoRoot);
    expect(drifts.some((d) => d.includes("sources"))).toBe(true);
  });
});

describe("gateway fixture AC-2", () => {
  it("schema_hint superset includes required types", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../fixtures/gateway-introspection.json"), "utf8"),
    ) as { fields: string[] };
    for (const type of REQUIRED_AC2_TYPES) {
      expect(fixture.fields).toContain(type);
    }
  });
});

describe("committed beacon gateway contract", () => {
  it("root beacon.yaml satisfies gateway contract fields", () => {
    const path = resolve(import.meta.dirname, "../../../beacon.yaml");
    const doc = parseYaml(readFileSync(path, "utf8")) as {
      read_surface?: {
        graphql?: { endpoint?: string };
        auth?: { kind?: string };
        mcp?: { shape?: string; tools?: string[] };
      };
    };
    expect(doc.read_surface?.graphql?.endpoint).toMatch(/^https:\/\//);
    expect(doc.read_surface?.auth?.kind).toBeTruthy();
    expect(doc.read_surface?.mcp?.shape).toBeTruthy();
    expect(doc.read_surface?.mcp?.tools?.length).toBeGreaterThan(0);
  });
});
