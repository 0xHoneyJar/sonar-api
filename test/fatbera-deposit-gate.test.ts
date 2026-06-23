/*
 * fatbera-deposit-gate.test.ts — H1 regression guard (Bridgebuilder review, PR #75).
 *
 * The 3.2.1 same-address merge of FatBeraDeposits + FatBeraAccounting lowered the
 * config start_block to 1066385 (FatBeraAccounting's) so Accounting events aren't
 * missed. But FatBeraDeposit *entities* + "deposit" activity actions must still
 * begin at FATBERA_DEPOSIT_TRACKING_START_BLOCK (1966971) — the pre-merge behavior.
 *
 * The regression: the start-block gate sat AFTER the entity write, so post-merge
 * the Deposit handler wrote FatBeraDeposit rows + deposit actions for the
 * [1066385, 1966971) window it never covered before. This test pins the gate
 * BEFORE the writes by exercising the registered Deposit callback directly.
 *
 * Uses the same module-load `vi.mock("envio")` spy pattern as
 * registration-coverage.test.ts (no envio codegen needed — types are erased).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

type Reg = { key: string; cb: (arg: any) => unknown };
const regs: Reg[] = [];

vi.mock("envio", () => ({
  indexer: {
    onEvent: (cfg: any, cb: (arg: any) => unknown) => {
      regs.push({ key: `${cfg.contract}:${cfg.event}`, cb });
    },
    contractRegister: () => {},
  },
}));

const recordActionMock = vi.fn();
vi.mock("../src/lib/actions", () => ({ recordAction: recordActionMock }));

import {
  VALIDATOR_DEPOSIT_ROUTER_ADDRESS,
  FATBERA_DEPOSIT_TRACKING_START_BLOCK,
} from "../src/handlers/fatbera-core";

let depositCb: (arg: any) => unknown;

beforeAll(async () => {
  await import("../src/handlers/fatbera");
  const reg = regs.find((r) => r.key === "FatBeraDeposits:Deposit");
  if (!reg) throw new Error("FatBeraDeposits:Deposit handler did not register at module load");
  depositCb = reg.cb;
});

function makeContext() {
  return {
    isPreload: false,
    FatBeraDeposit: { set: vi.fn() },
    LatestValidatorDeposit: { get: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

// `to` = the validator-deposit router so the handler early-returns right after the
// entity write (skips all validator logic) — isolates the gate under test.
function makeEvent(blockNumber: number) {
  return {
    params: { sender: "0x000000000000000000000000000000000000aaaa", owner: "0x000000000000000000000000000000000000bbbb", assets: 1000n, shares: 1000n },
    transaction: { from: "0x000000000000000000000000000000000000cccc", to: VALIDATOR_DEPOSIT_ROUTER_ADDRESS, hash: "0xhash" },
    logIndex: 0,
    block: { number: blockNumber, timestamp: 1_700_000_000 },
    chainId: 80094,
    srcAddress: "0x000000000000000000000000000000000000dddd",
  } as any;
}

describe("FatBera Deposit start-block gate (H1, PR #75)", () => {
  it("does NOT write FatBeraDeposit / deposit action below the tracking start block", async () => {
    const context = makeContext();
    recordActionMock.mockClear();
    await depositCb({ event: makeEvent(FATBERA_DEPOSIT_TRACKING_START_BLOCK - 1), context });
    expect(context.FatBeraDeposit.set).not.toHaveBeenCalled();
    expect(recordActionMock).not.toHaveBeenCalled();
  });

  it("writes FatBeraDeposit + deposit action at/above the tracking start block", async () => {
    const context = makeContext();
    recordActionMock.mockClear();
    await depositCb({ event: makeEvent(FATBERA_DEPOSIT_TRACKING_START_BLOCK), context });
    expect(context.FatBeraDeposit.set).toHaveBeenCalledTimes(1);
    expect(recordActionMock).toHaveBeenCalledTimes(1);
  });
});
