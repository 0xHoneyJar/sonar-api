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

describe("address-type — classifyCode", () => {
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

  it("EIP-7702 designator → delegated_eoa", () => {
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

  it("partial 0xef prefix → contract", () => {
    expect(classifyCode("0xef")).toBe("contract");
    expect(classifyCode("0xef01")).toBe("contract");
    expect(classifyCode("0xef00ff")).toBe("contract");
  });

  it("malformed 0xef0100 designator → contract", () => {
    expect(classifyCode("0xef0100")).toBe("contract");
  });

  it("overlong 0xef0100 blob → contract", () => {
    expect(
      classifyCode("0xef0100" + "1234567890123456789012345678901234567890ff"),
    ).toBe("contract");
  });

  it("non-hex delegate suffix → contract", () => {
    expect(classifyCode("0xef0100" + "g".repeat(40))).toBe("contract");
    expect(classifyCode("0xef0100" + "z".repeat(40))).toBe("contract");
  });
});

describe("address-type — needsRecheck", () => {
  it("eoa needs recheck", () => {
    expect(needsRecheck("eoa")).toBe(true);
  });

  it("contract is terminal", () => {
    expect(needsRecheck("contract")).toBe(false);
  });

  it("delegated_eoa is terminal", () => {
    expect(needsRecheck("delegated_eoa")).toBe(false);
  });
});
