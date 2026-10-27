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

  it("treats month-1 overages as the starting state", () => {
    const r = run(inputsWith());
    expect(r.events.filter((e) => e.kind === "overage_start" && e.month === 1)).toEqual([]);
  });

  it("does not replay a month-1 overage in month 2", () => {
    // Small SaaS egress (360 GB) is already over Pro's 250 GB in month 1.
    const r = run(inputsWith());
    expect(r.months[0].items.find((i) => i.key === "egress_gb")!.cost).toBeGreaterThan(0);
    expect(r.events.some((e) => e.key === "overage:supabase:egress_gb")).toBe(false);
  });

  it("reports when usage outgrows a plan credit instead of per-item overages", () => {
    const r = run(inputsWith({ mau: 30_000, growthPct: 20 }));
    expect(r.events.find((e) => e.key === "credit:vercel")).toMatchObject({ month: 5, kind: "credit_used_up", service: "vercel" });
    expect(r.events.some((e) => e.key === "overage:vercel:fn_invocations")).toBe(false);
  });

  it("writes plan limits and overages as sentences", () => {
    const limit = run(inputsWith({ supabase: "free", mau: 40_000, growthPct: 20 })).events.find((e) => e.key === "limit:supabase:mau")!;
    expect(limit.message).toMatch(/^Over the plan limit for mau \(.+ included\)\. A paid plan is required\.$/);
    const over = run(inputsWith({ mau: 90_000, growthPct: 10 })).events.find((e) => e.key === "overage:supabase:mau")!;
    expect(over.message).toMatch(/^Overage charges start for mau above the included .+\.$/);
  });

  it("prices a compute upgrade", () => {
    const e = run(atQps(60, { growthPct: 10 })).events.find((x) => x.kind === "compute_upgrade")!;
    expect(e.message).toBe("Database load needs Small compute (peak 73 queries/sec), $5.00 a month more than Micro.");
  });

  it("leaves a month-1 cache payoff to the verdict card", () => {
    const r = run(atQps(120), FREE_CACHE_CATALOG);
    expect(r.verdict.paysOffMonth).toBe(1);
    expect(r.events.some((e) => e.kind === "cache_pays_off")).toBe(false);
  });

  it("counts whole days for staleness and treats a bad date as stale", () => {
    const at = (iso: string) => simulate(inputsWith(), { catalog: TEST_CATALOG, now: new Date(iso) }).provenance[0].stale;
    expect(at("2026-12-30T23:59:00Z")).toBe(false); // 90 days after 2026-10-01
    expect(at("2026-12-31T00:01:00Z")).toBe(true); // 91 days
    const bad = { ...TEST_CATALOG, sheets: TEST_CATALOG.sheets.map((s) => ({ ...s, verifiedAt: "not-a-date" })) };
    expect(simulate(inputsWith(), { catalog: bad, now: NOW }).provenance.every((p) => p.stale)).toBe(true);
  });

  it("lists events in month order", () => {
    const r = run(inputsWith({ supabase: "free", mau: 40_000, growthPct: 20 }));
    const months = r.events.map((e) => e.month);
    expect(months).toEqual([...months].sort((a, b) => a - b));
  });
});
