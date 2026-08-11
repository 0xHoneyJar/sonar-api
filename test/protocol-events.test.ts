import { describe, it, expect } from "vitest";
import type { Action } from "envio";
import { recordProtocolEvent } from "../src/handlers/protocol-events";
import { PROTOCOLS, eventNameOf, protocolBindingPlan, findProtocol } from "../src/registry/protocols";

/*
 * The protocol-events recording path: registry-keyed dispatch into one Action
 * row per event, verbs and params exactly as declared in protocols.ts. The
 * fixtures use the real goldilocks registry entries — a registry edit that
 * breaks the dispatch shape fails here, without a belt.
 */

const GOLDILOCKED = "0xbf2e152f460090ace91a456e3dee5acf703f27ad";
const GOLDIGOV = "0x6c00d68dc6bcc3d47d698f4b566ccbe893d34fed";
const WALLET = "0xAbCd000000000000000000000000000000000001";

function capturingContext() {
  const rows: Action[] = [];
  return { rows, context: { Action: { set: (a: Action) => rows.push(a) } } };
}

function evmEvent(address: string, params: unknown, logIndex = 7) {
  return {
    params,
    srcAddress: address,
    chainId: 80094,
    logIndex,
    transaction: { hash: "0xhash", transactionIndex: 3 },
    block: { timestamp: 1754800000, number: 801950 },
  };
}

describe("protocol-events recording", () => {
  it("records a Stake as actionType 'stake' with actor lowercased and amount in numeric1", () => {
    const { rows, context } = capturingContext();
    recordProtocolEvent("Stake", evmEvent(GOLDILOCKED, { user: WALLET, amount: 500n }), context);
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a.actionType).toBe("stake");
    expect(a.actor).toBe(WALLET.toLowerCase());
    expect(a.primaryCollection).toBe("goldilocks");
    expect(a.numeric1).toBe(500n);
    expect(a.id).toBe("0xhash_7");
    expect(a.blockNumber).toBe(801950n);
    expect(a.transactionIndex).toBe(3);
  });

  it("records a VoteCast with weight as numeric1 and proposalId/support in context as strings", () => {
    const { rows, context } = capturingContext();
    recordProtocolEvent(
      "VoteCast",
      evmEvent(GOLDIGOV, { voter: WALLET, proposalId: 42n, support: 1, weight: 9000n, reason: "gm" }),
      context,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actionType).toBe("vote");
    expect(rows[0].numeric1).toBe(9000n);
    // bigints must be stringified BEFORE JSON.stringify — recordAction silently
    // drops a context that throws.
    expect(JSON.parse(rows[0].context ?? "{}")).toEqual({
      contract: GOLDIGOV,
      proposalId: "42",
      support: "1",
    });
  });

  it("drops events from unregistered addresses and unregistered event names", () => {
    const { rows, context } = capturingContext();
    recordProtocolEvent("Stake", evmEvent("0x0000000000000000000000000000000000000bad", { user: WALLET, amount: 1n }), context);
    recordProtocolEvent("Claim", evmEvent(GOLDILOCKED, { user: WALLET, amount: 1n }), context);
    expect(rows).toEqual([]);
  });

  it("drops a row whose actor param is missing rather than writing a poisoned wallet", () => {
    const { rows, context } = capturingContext();
    recordProtocolEvent("Stake", evmEvent(GOLDILOCKED, { amount: 1n }), context);
    expect(rows).toEqual([]);
  });

  it("keeps ids parseable as <txHash>_<logIndex> (score-api's logIndex contract)", () => {
    const { rows, context } = capturingContext();
    recordProtocolEvent("Stir", evmEvent(GOLDILOCKED, { user: WALLET, amount: 1n }, 11), context);
    const [txHash, logIndex] = rows[0].id.split("_");
    expect(txHash).toBe("0xhash");
    expect(Number(logIndex)).toBe(11);
  });
});

describe("protocol registry invariants", () => {
  it("registers every goldilocks core-ring verb exactly once", () => {
    const verbs = PROTOCOLS.filter((p) => p.community === "goldilocks")
      .flatMap((p) => p.events.map((e) => e.verb))
      .sort();
    expect(verbs).toEqual([
      "borrow", "delegate", "propose", "redeem", "repay", "stake", "stir", "unstake", "vote",
    ]);
  });

  it("names an actorParam that exists in each signature", () => {
    for (const p of PROTOCOLS) {
      for (const e of p.events) {
        const params = e.signature.slice(e.signature.indexOf("(") + 1, -1);
        expect(params, `${eventNameOf(e.signature)} actorParam ${e.actorParam}`).toContain(e.actorParam);
        if (e.amountParam) expect(params).toContain(e.amountParam);
      }
    }
  });

  it("splits bindings by token-tracking: staking/AMM merged, governance standalone", () => {
    const plan = protocolBindingPlan();
    const standalone = plan.standalone.map((p) => p.address).sort();
    // Goldilocks governance pair + the whole StonkBrokers ring (none of its
    // protocol addresses are token-tracked; the two custody vaults are
    // custodial entries, which TRACKED_CONTRACTS filters out).
    const goldilocksStandalone = [
      "0x6c00d68dc6bcc3d47d698f4b566ccbe893d34fed", // Goldigovernance
      "0xb9798e0e3ab8b2f2c80684c9d51056538e021dac", // GovLocks
    ];
    const stonkStandalone = PROTOCOLS.filter((p) => p.chain === 4663).map((p) => p.address);
    expect(stonkStandalone).toHaveLength(15); // 6 core contracts + 9 gacha machines
    expect(standalone).toEqual([...goldilocksStandalone, ...stonkStandalone].sort());
    const mergedErc20 = plan.merged.get("erc20") ?? [];
    expect(mergedErc20.map(eventNameOf).sort()).toEqual([
      "Borrow", "Redeem", "Repay", "Stake", "Stir", "Unstake",
    ]);
  });

  it("resolves dispatch case-insensitively on address", () => {
    expect(findProtocol(80094, GOLDILOCKED.toUpperCase().replace("0X", "0x"))).toBeDefined();
    expect(findProtocol(1, GOLDILOCKED)).toBeUndefined();
  });
});
