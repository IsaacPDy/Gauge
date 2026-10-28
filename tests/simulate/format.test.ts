import { describe, expect, it } from "vitest";
import { formatAmount, formatPerUser, formatQps } from "@/lib/engine/simulate/format";

describe("formatPerUser", () => {
  it("keeps 3 significant digits below $1", () => {
    expect(formatPerUser(0.0012345)).toBe("$0.00123");
  });

  it("uses cents for $1 and above", () => {
    expect(formatPerUser(57)).toBe("$57.00");
    expect(formatPerUser(1234.5)).toBe("$1,234.50");
  });
});

describe("formatAmount", () => {
  it("keeps one decimal for amounts from 10 to 100", () => {
    expect(formatAmount(21.6, "GB")).toBe("21.6 GB");
  });

  it("omits the unit when there is none", () => {
    expect(formatAmount(5, "")).toBe("5");
  });
});

describe("formatQps", () => {
  it("shows one decimal below 10 and compact counts above", () => {
    expect(formatQps(2.5)).toBe("2.5");
    expect(formatQps(12_000)).toBe("12.0K");
  });
});
