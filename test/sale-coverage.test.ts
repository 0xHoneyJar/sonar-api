/*
 * sale-coverage.test.ts — AC4: coverage is machine-readable and cannot go stale.
 *
 * The artifact only means anything if it is true. Two ways it could rot:
 *   1. someone edits config.yaml and forgets to regenerate  → the sync case
 *   2. someone lands a decoder and forgets to declare it     → caught by the
 *      structural cases (a covered venue must actually be bound in config.yaml)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildSaleCoverage } from "../src/sale-coverage";
import { deriveCollectionKeys } from "../src/handlers/marketplaces/tracked-nft-contracts";
import { extractChainContractRef } from "../scripts/verify-belt-config.js";

const configText = readFileSync("config.yaml", "utf8");
const doc = buildSaleCoverage(configText);

describe("sale-coverage.json stays in sync", () => {
  it("matches what the generator would write (run `pnpm coverage:sale` if this fails)", () => {
    const committed = readFileSync("sale-coverage.json", "utf8");
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});

describe("AC4 — absence is classifiable for every indexed collection", () => {
  it("lists every collection the belt indexes, and only those", () => {
    const derived: string[] = [];
    for (const [chainId, perChain] of deriveCollectionKeys(configText).keys) {
      for (const [contract] of perChain) derived.push(`${chainId}:${contract}`);
    }
    expect(
      doc.collections.map((c) => `${c.chainId}:${c.contract}`).sort(),
    ).toEqual(derived.sort());
  });

  it("gives every collection an absentSaleMeans verdict", () => {
    for (const c of doc.collections) {
      expect(["no_sale", "unknown", "not_applicable"]).toContain(
        c.absentSaleMeans,
      );
    }
  });

  it("declares every chain that config.yaml indexes collections on", () => {
    const declared = new Set(doc.chains.map((c) => c.chainId));
    for (const [chainId] of deriveCollectionKeys(configText).keys) {
      expect(declared, `chain ${chainId} indexes collections but is undeclared`).toContain(
        chainId,
      );
    }
  });
});

describe("the declaration cannot claim coverage it does not have", () => {
  it("only says no_sale on a chain with zero uncovered venues", () => {
    for (const chain of doc.chains) {
      if (chain.absentSaleMeans === "no_sale") {
        expect(
          chain.uncoveredVenues,
          `chain ${chain.chainId} promises absence means no sale while declaring ` +
            `undecoded venues — that promise would be a lie to every consumer.`,
        ).toEqual([]);
        expect(chain.coveredVenues.length).toBeGreaterThan(0);
      }
    }
  });

  it("binds every venue it claims to cover in config.yaml", () => {
    // The sprint-bug-190 lesson: a decoder with no config binding yields zero rows
    // while every handler test passes. A coverage claim has the same failure mode.
    //
    // The lookup MUST use the venue's own `configContract`, not a hardcoded "Seaport".
    // Hardcoding passes today because every covered venue is Seaport — and would keep
    // passing the day someone declares Element covered with no binding at all, which is
    // precisely the claim this test exists to refuse (review MEDIUM-2).
    let asserted = 0;
    for (const chain of doc.chains) {
      for (const venue of chain.coveredVenues) {
        expect(
          venue.configContract,
          `${chain.name} claims ${venue.name} coverage without naming the config ` +
            `contract it is bound under, so the binding cannot be verified`,
        ).toBeTruthy();

        const ref = extractChainContractRef(
          configText,
          chain.chainId,
          venue.configContract!,
        );
        expect(
          ref,
          `${chain.name} claims ${venue.name} coverage but binds no ` +
            `${venue.configContract} contract — no fill event is ever fetched there`,
        ).not.toBeNull();

        const bound = ref!.address.map((a: string) =>
          a.replace(/^["']|["']$/g, "").toLowerCase(),
        );
        for (const addr of venue.addresses ?? []) {
          expect(bound, `${chain.name}: ${addr} claimed but not bound`).toContain(
            addr,
          );
        }
        asserted++;
      }
    }
    // Guard the guard: a declaration that accidentally lost its covered venues would
    // otherwise vacuously pass every assertion above.
    expect(asserted).toBeGreaterThanOrEqual(3);
  });

  it("says unknown on any chain that indexes collections without a marketplace", () => {
    const withCollections = new Set(
      [...deriveCollectionKeys(configText).keys].map(([chainId]) => chainId),
    );
    for (const chain of doc.chains) {
      if (!withCollections.has(chain.chainId)) continue;
      if (chain.coveredVenues.length === 0) {
        expect(
          chain.absentSaleMeans,
          `chain ${chain.chainId} indexes collections and decodes no venue, so a ` +
            `missing sale row cannot mean "no sale"`,
        ).toBe("unknown");
      }
    }
  });
});

describe("the deferred gaps this sprint owes score-api are declared", () => {
  const chain = (id: number) => doc.chains.find((c) => c.chainId === id)!;

  it("declares Blur, Wyvern and X2Y2 uncovered on Ethereum", () => {
    const names = chain(1).uncoveredVenues.map((v) => v.name).join(" ");
    for (const venue of ["Blur v1", "Blur v2", "Wyvern", "X2Y2"]) {
      expect(names).toContain(venue);
    }
    expect(chain(1).absentSaleMeans).toBe("unknown");
  });

  it("declares Blend a lending event, not a sale", () => {
    expect(chain(1).notASale.map((v) => v.name)).toContain("Blur Blend");
  });

  it("declares Element uncovered on Base", () => {
    expect(chain(8453).uncoveredVenues.map((v) => v.name)).toContain("Element");
  });

  it("declares Solana uncovered except pythians", () => {
    const covered = doc.solana.collections
      .filter((c) => c.sales === "covered")
      .map((c) => c.collectionKey);
    expect(covered).toEqual(["pythians"]);
    expect(doc.solana.absentSaleMeans).toBe("unknown");
    expect(doc.solana.collections.length).toBeGreaterThanOrEqual(6);
  });
});
