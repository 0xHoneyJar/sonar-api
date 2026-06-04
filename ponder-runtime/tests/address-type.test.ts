// ponder-runtime/tests/address-type.test.ts
//
// Unit tests for the address-type classification helpers (sonar-api#63). The
// resolver block-handler + touchAddress glue need the ponder runtime to run
// end-to-end; these target the PURE core in src/lib/address-type.ts:
//
//   - addressTypeId   composite key {chainId}_{address}
//   - classifyCode    eth_getCode bytecode → eoa | contract | delegated_eoa
//   - needsRecheck    which types can still flip (counterfactual eoa→contract)
//
// classifyCode is the load-bearing one: the issue warns that a naive
// `code != 0x` ban wrongly bans EIP-7702 delegated EOAs (7 of 9 has-code
// wallets in their top-30 were these — real humans, not contracts).

import { describe, expect, it } from "vitest";
import { addressTypeId, classifyCode, needsRecheck } from "../src/lib/address-type";

describe("address-type — addressTypeId", () => {
  it("composes {chainId}_{address}", () => {
    expect(addressTypeId(8453, "0xAbC")).toBe("8453_0xabc");
  });
  it("lowercases the address", () => {
    expect(addressTypeId(1, "0xDEADBEEF")).toBe("1_0xdeadbeef");
  });
  it("separates the same address across chains", () => {
    expect(addressTypeId(8453, "0xa")).not.toBe(addressTypeId(1, "0xa"));
  });
});

describe("address-type — classifyCode (EOA / contract / EIP-7702)", () => {
  it("undefined bytecode → eoa", () => {
    expect(classifyCode(undefined)).toBe("eoa");
  });
  it("null bytecode → eoa", () => {
    expect(classifyCode(null)).toBe("eoa");
  });
  it("empty '0x' → eoa", () => {
    expect(classifyCode("0x")).toBe("eoa");
  });
  it("empty string → eoa", () => {
    expect(classifyCode("")).toBe("eoa");
  });
  it("EIP-7702 designator (0xef0100 || delegate) → delegated_eoa (still human)", () => {
    // 0xef0100 followed by a 20-byte delegate address.
    expect(
      classifyCode("0xef0100" + "1234567890123456789012345678901234567890"),
    ).toBe("delegated_eoa");
  });
  it("EIP-7702 prefix is matched case-insensitively", () => {
    expect(
      classifyCode("0xEF0100" + "ABCDEF1234567890123456789012345678901234"),
    ).toBe("delegated_eoa");
  });
  it("ordinary contract bytecode → contract", () => {
    expect(classifyCode("0x6080604052348015600f57600080fd")).toBe("contract");
  });
  it("'0xef' alone (not the full 0xef0100 designator) → contract", () => {
    // Defends the boundary: only the exact EIP-7702 designator is an EOA.
    expect(classifyCode("0xef")).toBe("contract");
    expect(classifyCode("0xef01")).toBe("contract");
    expect(classifyCode("0xef00ff")).toBe("contract");
  });
  it("bare '0xef0100' with no delegate (malformed designator) → contract", () => {
    // A valid 7702 designator is EXACTLY 0xef0100 + a 20-byte delegate address;
    // the bare prefix lacks the delegate, so it is not a human EOA.
    expect(classifyCode("0xef0100")).toBe("contract");
  });
  it("overlong 0xef0100-prefixed blob (not exactly 23 bytes) → contract", () => {
    // 0xef0100 + 21 bytes (42 hex) = malformed; conservatively a contract.
    expect(
      classifyCode("0xef0100" + "1234567890123456789012345678901234567890ff"),
    ).toBe("contract");
  });
  it("48-char 0xef0100 blob with NON-hex delegate → contract (not a valid designator)", () => {
    expect(classifyCode("0xef0100" + "g".repeat(40))).toBe("contract");
    expect(classifyCode("0xef0100" + "z".repeat(40))).toBe("contract");
  });
});

describe("address-type — needsRecheck (only eoa can flip: counterfactual deploy)", () => {
  it("eoa needs recheck (may be a counterfactual ERC-4337 wallet: empty→contract)", () => {
    expect(needsRecheck("eoa")).toBe(true);
  });
  it("contract is terminal", () => {
    expect(needsRecheck("contract")).toBe(false);
  });
  it("delegated_eoa is terminal (stays human even if re-delegated)", () => {
    expect(needsRecheck("delegated_eoa")).toBe(false);
  });
});
