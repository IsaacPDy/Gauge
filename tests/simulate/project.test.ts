import { describe, expect, it } from "vitest";
import { cacheVerdict, chooseCompute } from "@/lib/engine/simulate/project";
import { resolveStack } from "@/lib/engine/simulate/stack";
import { workloadMonths } from "@/lib/engine/simulate/workload";
import { FREE_CACHE_CATALOG, inputsWith, TEST_CATALOG } from "./fixtures";
import type { SimInputs } from "@/lib/engine/simulate/inputs";

const MONTH = 2_592_000;
// No file downloads, so Supabase egress stays inside Pro's allowance and only compute decides the verdict (unless a test says otherwise).
const atQps = (qps: number, extra: Partial<SimInputs> = {}) => inputsWith({ dbQueriesOverride: qps * MONTH, peakToAvg: 1, growthPct: 0, fileDownloadMBPerUser: 0, ...extra });

function verdict(inputs: SimInputs, catalog = TEST_CATALOG) {
  return cacheVerdict(inputs, resolveStack(inputs).stack, catalog, 12);
}

function compute(inputs: SimInputs) {
  const { stack } = resolveStack(inputs);
  const [u] = workloadMonths(inputs, stack, stack.cache, 1);
  return chooseCompute(stack, u, inputs, TEST_CATALOG);
}

describe("chooseCompute", () => {
  it("picks the smallest paid size that fits", () => {
    expect(compute(atQps(50))).toEqual({ key: "micro", fits: true });
    expect(compute(atQps(120))).toEqual({ key: "small", fits: true });
  });

  it("returns the largest size, marked as not fitting, when nothing fits", () => {
    expect(compute(atQps(500))).toEqual({ key: "medium", fits: false });
  });

  it("keeps a fixed size and reports saturation", () => {
    expect(compute(atQps(120, { compute: "micro" }))).toEqual({ key: "micro", fits: false });
  });

  it("ignores the compute choice on Supabase Free", () => {
    expect(compute(atQps(10, { supabase: "free", compute: "small" }))).toEqual({ key: "nano", fits: true });
  });

  it("has no compute without Supabase", () => {
    expect(compute(inputsWith({ supabase: "off" }))).toEqual({ key: null, fits: true });
  });

  it("respects planning QPS overrides", () => {
    expect(compute(atQps(120, { planningQps: { micro: 200 } }))).toEqual({ key: "micro", fits: true });
  });
});

describe("cacheVerdict", () => {
  it("says no cache is needed when the smallest size fits anyway", () => {
    const v = verdict(atQps(50));
    expect(v.kind).toBe("no_cache_needed");
    expect(v.tierWithoutCache).toBe("micro");
  });

  it("recommends upgrading compute when the cache costs more", () => {
    const v = verdict(atQps(120));
    expect(v).toMatchObject({ kind: "upgrade_compute", tierWithoutCache: "small", tierWithCache: "micro" });
  });

  it("recommends a cache when it is cheaper than the larger size", () => {
    const v = verdict(atQps(120), FREE_CACHE_CATALOG);
    expect(v).toMatchObject({ kind: "add_cache", monthlySaving: 5, tierWithoutCache: "small", tierWithCache: "micro", paysOffMonth: 1 });
  });

  it("recommends a cache that pays for itself in egress alone", () => {
    const v = verdict(inputsWith({ responseKB: 100, fileDownloadMBPerUser: 0 }), FREE_CACHE_CATALOG);
    expect(v).toMatchObject({ kind: "add_cache", monthlySaving: 31.5, tierWithoutCache: "micro", tierWithCache: "micro" });
  });

  it("reports when no size fits, and whether a cache fixes it", () => {
    const v = verdict(atQps(500));
    expect(v).toMatchObject({ kind: "no_tier_fits", tierWithoutCache: null, tierWithCache: "medium", cacheFixesIt: true });
  });

  it("finds the month the cache starts paying off", () => {
    const v = verdict(atQps(60, { growthPct: 10 }), FREE_CACHE_CATALOG);
    expect(v.kind).toBe("no_cache_needed");
    expect(v.paysOffMonth).toBe(3);
  });

  it("does not apply without a server host or without Supabase", () => {
    expect(verdict(inputsWith({ host: "direct" })).kind).toBe("not_applicable");
    expect(verdict(inputsWith({ supabase: "off" })).kind).toBe("not_applicable");
  });
});
