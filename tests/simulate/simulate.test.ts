import { describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/simulate";
import { PRESETS, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";
import { FREE_CACHE_CATALOG, inputsWith, TEST_CATALOG } from "./fixtures";

const NOW = new Date("2026-10-27T12:00:00Z");
const run = (inputs: SimInputs, catalog = TEST_CATALOG) => simulate(inputs, { catalog, now: NOW });
// No file downloads, so Supabase egress stays inside Pro's allowance and only compute decides the verdict.
const atQps = (qps: number, extra: Partial<SimInputs> = {}) =>
  inputsWith({ dbQueriesOverride: qps * 2_592_000, peakToAvg: 1, growthPct: 0, fileDownloadMBPerUser: 0, ...extra });

describe("simulate", () => {
  it("produces 12 finite, non-negative months for every preset with the real catalog", () => {
    for (const p of PRESETS) {
      const r = simulate(presetInputs(p), { now: NOW });
      expect(r.months).toHaveLength(12);
      for (const m of r.months) {
        expect(Number.isFinite(m.total)).toBe(true);
        expect(m.total).toBeGreaterThanOrEqual(0);
        const byService = Object.values(m.totalsByService).reduce((s, v) => s + (v ?? 0), 0);
        expect(byService).toBeCloseTo(m.total, 2);
      }
      expect(r.provenance.length).toBeGreaterThan(0);
      expect(r.provenance.every((pr) => pr.sourceUrl.startsWith("https://"))).toBe(true);
    }
  });

  it("passes routing notices through", () => {
    const r = run(inputsWith({ vercel: "off", host: "vercel" }));
    expect(r.notices).toHaveLength(1);
  });

  it("marks restricted months", () => {
    const r = run(inputsWith({ supabase: "free", mau: 60_000 }));
    expect(r.months[0].restricted).toBe(true);
  });

  it("flags price sheets older than 90 days", () => {
    expect(run(inputsWith()).provenance.every((p) => !p.stale)).toBe(true);
    const later = simulate(inputsWith(), { catalog: TEST_CATALOG, now: new Date("2027-02-01T00:00:00Z") });
    expect(later.provenance.every((p) => p.stale)).toBe(true);
  });
});

describe("events", () => {
  it("fires a plan limit once, in the month it is first crossed", () => {
    const r = run(inputsWith({ supabase: "free", mau: 40_000, growthPct: 20 }));
    const mau = r.events.filter((e) => e.key === "limit:supabase:mau");
    expect(mau).toHaveLength(1);
    expect(mau[0]).toMatchObject({ month: 3, kind: "plan_limit", service: "supabase" });
  });

  it("fires when overage charges start on a paid plan", () => {
    const r = run(inputsWith({ mau: 90_000, growthPct: 10 }));
    expect(r.events.find((e) => e.key === "overage:supabase:mau")).toMatchObject({ month: 3, kind: "overage_start" });
  });

  it("fires when auto compute moves up a size", () => {
    const r = run(atQps(60, { growthPct: 10 }));
    expect(r.events.find((e) => e.kind === "compute_upgrade")).toMatchObject({ month: 3 });
    expect(r.months[2].computeSize).toBe("small");
  });

  it("fires once when a fixed size saturates", () => {
    const r = run(atQps(120, { compute: "micro" }));
    const sat = r.events.filter((e) => e.kind === "compute_saturated");
    expect(sat).toHaveLength(1);
    expect(sat[0].month).toBe(1);
  });

  it("fires when a cache starts paying off", () => {
    const r = run(atQps(60, { growthPct: 10 }), FREE_CACHE_CATALOG);
    expect(r.verdict.paysOffMonth).toBe(3);
    expect(r.events.find((e) => e.kind === "cache_pays_off")).toMatchObject({ month: 3 });
  });

  it("lists events in month order", () => {
    const r = run(inputsWith({ supabase: "free", mau: 40_000, growthPct: 20 }));
    const months = r.events.map((e) => e.month);
    expect(months).toEqual([...months].sort((a, b) => a - b));
  });
});
