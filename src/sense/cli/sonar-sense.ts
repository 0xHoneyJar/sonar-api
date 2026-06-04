/**
 * sonar-sense.ts — the agent surface (incur CLI + MCP).
 *
 * Wraps the SonarSense port in an incur CLI: zod arg/option/output schemas give
 * `--help` / `--llms` / `--schema` / `--format toon|json` + MCP (`--mcp`,
 * `mcp add`) for free. Every verb returns an `Observation` envelope; the
 * `grounding` drives a DETERMINISTIC exit code so agents can branch:
 *   0 grounded · 2 bad-input · 3 not-found · 4 upstream-outage · 5 stale/degraded.
 *
 * `buildSonarSenseCli(sense)` takes the port (live or mock) so tests inject the
 * mock; the module entry binds the live reader and serves.
 */

import { pathToFileURL } from "node:url";
import { Cli, z } from "incur";
import type { Grounding, Observation } from "../domain/observation.domain";
import { makeLiveSonarSense } from "../live/sonar-sense.live";
import type { Address, ChainId, SonarSense } from "../ports/sonar-sense.port";

/** grounding/source → deterministic exit code (the spec's contract). */
function exitFor(o: { grounding: Grounding; source: string }): number {
  if (o.grounding === "grounded") return 0; // ok
  if (o.source.startsWith("live:malformed")) return 2; // bad-input
  if (o.source.startsWith("live:unsupported-chain")) return 3; // not-found
  if (o.source.startsWith("live:rpc-error")) return 4; // upstream-outage
  return 5; // stale / degraded (unverifiable or refuted)
}

/** Recursively coerce bigint → string so the envelope is JSON/TOON-serialisable. */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

function toOutput<T>(o: Observation<T>) {
  return {
    value: jsonSafe(o.value),
    grounding: o.grounding,
    tier: o.tier,
    source: o.source,
    chain_id: o.chain_id,
    block_number: o.block_number,
    confidence: o.confidence,
    trace_id: o.trace_id,
    schema_version: o.schema_version,
  };
}

/** The Observation output envelope (value is verb-specific; kept `unknown` here). */
const OBS_OUTPUT = z.object({
  value: z.unknown(),
  grounding: z.enum(["grounded", "refuted", "unverifiable"]),
  tier: z.enum(["bronze", "silver", "gold"]),
  source: z.string(),
  chain_id: z.number(),
  block_number: z.number().optional(),
  confidence: z.number(),
  trace_id: z.string(),
  schema_version: z.string(),
});

/** Coerce a CLI string call-arg: a pure-decimal string → bigint (e.g. a tokenId), else as-is. */
function coerceArg(s: string): unknown {
  return /^-?\d+$/.test(s) ? BigInt(s) : s;
}

/** Build a SonarSense CLI bound to `sense`. Returns the cli + an exit-code reader. */
export function buildSonarSenseCli(sense: SonarSense): {
  cli: ReturnType<typeof Cli.create>;
  getExit: () => number | undefined;
} {
  let exitCode: number | undefined;

  const cli = Cli.create("sonar-sense", {
    version: "0.1.0",
    description:
      "Sonar's chain-read sense-edge. Every read returns a grounded Observation (grounded|refuted|unverifiable). Set ERPC_URL to route through a cluster eRPC ingress; otherwise public Berachain RPCs.",
  });

  cli.command("doctor", {
    description: "Probe live endpoints (belt-gateway GraphQL + RPC + the dead-endpoint trap) BEFORE trusting any read.",
    output: OBS_OUTPUT,
    examples: [{ description: "Check sense health" }],
    hint: "Run this first; a non-grounded doctor (exit 5) means a read can't be trusted yet.",
    async run(c) {
      const o = await sense.doctor();
      exitCode = exitFor(o);
      return c.ok(toOutput(o), {
        cta: {
          description: o.value.ok ? "Healthy — try a read:" : "Degraded — inspect checks, then retry:",
          commands: ["native", "balance", "owns"],
        },
      });
    },
  });

  cli.command("native", {
    description: "Native (gas-token) balance of an account.",
    args: z.object({
      chain: z.coerce.number().describe("chain id (80094 = Berachain)"),
      account: z.string().describe("0x-hex account address"),
    }),
    options: z.object({
      block: z.coerce.bigint().optional().describe("read at a specific block (else latest)"),
      verify: z.boolean().optional().describe("cross-check across ≥2 upstreams (grounded|refuted|unverifiable)"),
    }),
    output: OBS_OUTPUT,
    examples: [{ args: { chain: 80094, account: "0x0000000000000000000000000000000000000000" }, description: "BERA balance" }],
    async run(c) {
      const o = await sense.native(c.args.chain as ChainId, c.args.account as Address, { blockNumber: c.options.block, verify: c.options.verify });
      exitCode = exitFor(o);
      return c.ok(toOutput(o), { cta: { description: "Chain it:", commands: ["balance", "owns"] } });
    },
  });

  cli.command("balance", {
    description: "ERC-20 token balance of an owner.",
    args: z.object({
      chain: z.coerce.number().describe("chain id"),
      owner: z.string().describe("0x-hex owner address"),
      token: z.string().describe("0x-hex ERC-20 contract"),
    }),
    options: z.object({
      block: z.coerce.bigint().optional().describe("read at a specific block"),
      verify: z.boolean().optional().describe("cross-check across ≥2 upstreams"),
    }),
    output: OBS_OUTPUT,
    examples: [{ args: { chain: 80094, owner: "0xabc...", token: "0xdef..." }, description: "ERC-20 balance" }],
    async run(c) {
      const o = await sense.balance(c.args.chain as ChainId, c.args.owner as Address, c.args.token as Address, { blockNumber: c.options.block, verify: c.options.verify });
      exitCode = exitFor(o);
      return c.ok(toOutput(o), { cta: { description: "Verify ownership:", commands: ["owns"] } });
    },
  });

  cli.command("owns", {
    description: "Does an owner hold a collection (optionally a specific tokenId)?",
    args: z.object({
      chain: z.coerce.number().describe("chain id"),
      owner: z.string().describe("0x-hex owner address"),
      collection: z.string().describe("0x-hex ERC-721 collection"),
    }),
    options: z.object({
      tokenId: z.coerce.bigint().optional().describe("a specific token id (else any-token via balanceOf)"),
      block: z.coerce.bigint().optional().describe("read at a specific block"),
      verify: z.boolean().optional().describe("cross-check across ≥2 upstreams"),
    }),
    output: OBS_OUTPUT,
    examples: [{ args: { chain: 80094, owner: "0xabc...", collection: "0xnft..." }, options: { tokenId: 7n }, description: "Owns token #7?" }],
    async run(c) {
      const o = await sense.owns(c.args.chain as ChainId, c.args.owner as Address, c.args.collection as Address, c.options.tokenId, { blockNumber: c.options.block, verify: c.options.verify });
      exitCode = exitFor(o);
      return c.ok(toOutput(o), { cta: { description: "Read raw state:", commands: ["read"] } });
    },
  });

  cli.command("read", {
    description: "First-party contract read. fnSig is a viem function signature; --arg supplies call args (decimal strings → bigint).",
    args: z.object({
      chain: z.coerce.number().describe("chain id"),
      address: z.string().describe("0x-hex contract address"),
      fnSig: z.string().describe('e.g. "function ownerOf(uint256) view returns (address)"'),
    }),
    options: z.object({
      arg: z.array(z.string()).optional().describe("a call argument (repeatable); pure-decimal → bigint"),
      block: z.coerce.bigint().optional().describe("read at a specific block"),
      verify: z.boolean().optional().describe("cross-check across ≥2 upstreams"),
    }),
    output: OBS_OUTPUT,
    examples: [{ args: { chain: 80094, address: "0xnft...", fnSig: "function ownerOf(uint256) view returns (address)" }, options: { arg: ["7"] }, description: "ownerOf(7)" }],
    hint: 'fnSig must be a valid viem signature with NO colons (they would collide internal keys).',
    async run(c) {
      const callArgs = (c.options.arg ?? []).map(coerceArg);
      const o = await sense.read(c.args.chain as ChainId, c.args.address as Address, c.args.fnSig, callArgs, { blockNumber: c.options.block, verify: c.options.verify });
      exitCode = exitFor(o);
      return c.ok(toOutput(o), { cta: { description: "Probe health:", commands: ["doctor"] } });
    },
  });

  return { cli, getExit: () => exitCode };
}

const { cli, getExit } = buildSonarSenseCli(makeLiveSonarSense());
export default cli;

// Run as a binary: serve, then exit with the verb's grounding-derived code (incur
// only calls `exit` on its own errors, so we read getExit() AFTER serve resolves).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let incurCode = 0;
  await cli.serve(process.argv.slice(2), { exit: (code) => { incurCode = code; } });
  // A non-zero framework error (validation/thrown) WINS — never let a verb's
  // grounding code (incl. 0) mask it; otherwise use the verb's exit code.
  process.exit(incurCode !== 0 ? incurCode : (getExit() ?? 0));
}
