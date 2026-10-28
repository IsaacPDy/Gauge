import { describe, expect, it, vi } from "vitest";
import { convertUsd, type Display, displayFor, formatCost, formatUsdAs, parseDisplayCurrency, USD_DISPLAY } from "@/lib/currency";
import { formatPerUser } from "@/lib/engine/simulate/format";
import { createRateSource, FALLBACK_PHP_PER_USD } from "@/lib/fx";

const PESO: Display = { currency: "PHP", rate: 60 };

describe("parseDisplayCurrency", () => {
  it("accepts the supported currencies", () => {
    expect(parseDisplayCurrency("PHP")).toBe("PHP");
    expect(parseDisplayCurrency("USD")).toBe("USD");
  });

  it("falls back to USD for anything else", () => {
    expect(parseDisplayCurrency(undefined)).toBe("USD");
    expect(parseDisplayCurrency("EUR")).toBe("USD");
    expect(parseDisplayCurrency("php")).toBe("USD");
  });
});

describe("displayFor", () => {
  it("uses the peso rate only for PHP", () => {
    const r = { rate: 63.5, date: "2026-10-27", live: true };
    expect(displayFor("PHP", r)).toEqual({ currency: "PHP", rate: 63.5 });
    expect(displayFor("USD", r)).toEqual(USD_DISPLAY);
  });
});

describe("convertUsd", () => {
  it("leaves USD unchanged", () => {
    expect(convertUsd(12.5, USD_DISPLAY)).toBe(12.5);
  });

  it("converts at the display rate", () => {
    expect(convertUsd(2, PESO)).toBe(120);
  });
});

describe("formatUsdAs", () => {
  it("formats dollars", () => {
    expect(formatUsdAs(1234.5, USD_DISPLAY)).toBe("$1,234.50");
  });

  it("formats converted pesos", () => {
    expect(formatUsdAs(10, PESO)).toBe("₱600.00");
  });
});

describe("formatCost", () => {
  it("converts USD amounts to the display currency", () => {
    expect(formatCost(1, "USD", PESO)).toBe("₱60.00");
  });

  it("shows other source currencies as stored, since there is no rate for them", () => {
    expect(formatCost(5, "EUR", PESO)).toBe("€5.00");
  });
});

describe("formatPerUser in pesos", () => {
  it("converts and keeps 3 significant digits for small amounts", () => {
    expect(formatPerUser(0.001, PESO)).toBe("₱0.06");
    expect(formatPerUser(0.0001234, PESO)).toBe("₱0.0074");
  });

  it("uses centavos for ₱1 and above", () => {
    expect(formatPerUser(1, PESO)).toBe("₱60.00");
  });
});

describe("createRateSource", () => {
  const ok = (rate: number, date = "2026-10-27") => Promise.resolve(new Response(JSON.stringify({ amount: 1, base: "USD", date, rates: { PHP: rate } })));
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("returns the live rate and reuses it for six hours", async () => {
    let now = 0;
    const fetchImpl = vi.fn(() => ok(63.994));
    const get = createRateSource(fetchImpl, () => now);
    expect(await get()).toEqual({ rate: 63.994, date: "2026-10-27", live: true });
    now = 5 * 60 * 60 * 1000;
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 7 * 60 * 60 * 1000;
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchImpl = vi.fn(() => ok(64));
    const get = createRateSource(fetchImpl, () => 0);
    await Promise.all([get(), get(), get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the fixed rate when the source is unreachable, and retries after ten minutes", async () => {
    quiet();
    let now = 0;
    const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
    const get = createRateSource(fetchImpl, () => now);
    expect(await get()).toEqual({ rate: FALLBACK_PHP_PER_USD, date: null, live: false });
    now = 9 * 60 * 1000;
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 11 * 60 * 1000;
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good rate when a later fetch fails", async () => {
    quiet();
    let now = 0;
    const fetchImpl = vi.fn<() => Promise<Response>>().mockImplementationOnce(() => ok(63.5)).mockImplementation(() => Promise.resolve(new Response("nope", { status: 503 })));
    const get = createRateSource(fetchImpl, () => now);
    await get();
    now = 7 * 60 * 60 * 1000;
    expect(await get()).toEqual({ rate: 63.5, date: "2026-10-27", live: true });
  });

  it("rejects a malformed response", async () => {
    quiet();
    const get = createRateSource(() => Promise.resolve(new Response(JSON.stringify({ rates: { PHP: -1 } }))), () => 0);
    expect((await get()).live).toBe(false);
  });
});
