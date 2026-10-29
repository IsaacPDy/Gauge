import { describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/simulate";
import { cheapestThatFits, comparePlans, type PlanVariant } from "@/lib/engine/simulate/compare";
import { DIRECT_REASON, NO_SUPABASE_REASON, resolveStack } from "@/lib/engine/simulate/stack";
import { inputsWith, TEST_CATALOG } from "./fixtures";

const NOW = new Date("2026-10-28T12:00:00Z");
const compare = (overrides = {}, month = 1) => comparePlans(inputsWith(overrides), month, { catalog: TEST_CATALOG, now: NOW });
const find = (variants: PlanVariant[], service: string, plan: string) => variants.find((v) => v.service === service && v.plan === plan)!;

describe("comparePlans", () => {
  it("prices every plan of every service in its role", () => {
    const { variants } = comparePlans(inputsWith(), 1, { now: NOW });
    expect(variants.map((v) => `${v.role}:${v.service}:${v.plan}`)).toEqual([
      "backend:supabase:free",
      "backend:supabase:pro",
      "backend:supabase:team",
      "backend:firebase:spark",
      "backend:firebase:blaze",
      "hosting:vercel:hobby",
      "hosting:vercel:pro",
      "hosting:cloudflare:free",
      "hosting:cloudflare:paid",
      "cache:upstash:payg",
    ]);
  });

  it("skips plans the catalog doesn't have", () => {
    expect(compare().variants.some((v) => v.service === "supabase" && v.plan === "team")).toBe(false);
  });

  it("reads only the compared service's costs and bars", () => {
    const v = find(compare().variants, "vercel", "pro");
    const direct = simulate(inputsWith({ host: "vercel" }), { catalog: TEST_CATALOG, now: NOW });
    expect(v.total).toBe(direct.months[0].totalsByService.vercel);
    expect(v.bars.length).toBeGreaterThan(0);
    expect(v.bars.every((b) => b.service === "vercel")).toBe(true);
  });

  it("moves files to the backend being compared, unless they live in R2", () => {
    const storage = (o = {}) => find(compare(o).variants, "firebase", "blaze").bars.find((b) => b.key === "storage_gib")!;
    expect(storage().used).toBeGreaterThan(0);
    expect(storage({ cloudflare: "paid", fileStore: "r2" }).used).toBe(0);
  });

  it("marks a plan over its limit when any bar is blocked", () => {
    const { variants } = compare({ mau: 60_000 });
    expect(find(variants, "supabase", "free").overLimit).toBe(true);
    expect(find(variants, "supabase", "pro").overLimit).toBe(false);
  });

  it("explains why the cache can't be priced", () => {
    expect(find(compare({ host: "direct" }).variants, "upstash", "payg")).toMatchObject({ unavailable: DIRECT_REASON, bars: [] });
    expect(find(compare({ supabase: "off" }).variants, "upstash", "payg").unavailable).toBe(NO_SUPABASE_REASON);
    expect(find(compare().variants, "upstash", "payg").unavailable).toBeNull();
  });

  it("returns the routing notices of your own stack only", () => {
    const inputs = inputsWith({ fileStore: "r2" });
    expect(comparePlans(inputs, 1, { catalog: TEST_CATALOG, now: NOW }).notices).toEqual(resolveStack(inputs).notices);
  });

  it("counts a plan whose compute can't carry the load as over its limit", () => {
    // ~77 q/s on average with no peak: past Nano at 70% headroom (35 q/s), within Small (140 q/s).
    const { variants } = compare({ dbQueriesOverride: 200_000_000, peakToAvg: 1, growthPct: 0 });
    expect(find(variants, "supabase", "free")).toMatchObject({ computeFits: false, overLimit: true });
    expect(find(variants, "supabase", "pro")).toMatchObject({ computeFits: true, overLimit: false });
    expect(cheapestThatFits(variants.filter((v) => v.role === "backend"))?.plan).not.toBe("free");
  });

  it("says compute fits for services without compute sizes and for plans it can't price", () => {
    const { variants } = compare({ host: "direct" });
    expect(find(variants, "vercel", "pro").computeFits).toBe(true);
    expect(find(variants, "upstash", "payg").computeFits).toBe(true);
  });

  it("leaves R2 file storage out of API hosting", () => {
    const o = { cloudflare: "paid", fileStore: "r2" } as const;
    const v = find(compare(o).variants, "cloudflare", "paid");
    const direct = simulate(inputsWith({ ...o, host: "cloudflare" }), { catalog: TEST_CATALOG, now: NOW }).months[0];
    const r2 = direct.items.filter((i) => i.service === "cloudflare" && i.key.startsWith("r2_"));
    expect(r2.length).toBeGreaterThan(0);
    expect(v.bars.some((b) => b.key.startsWith("r2_"))).toBe(false);
    expect(v.payFromFirst.some((p) => p.key.startsWith("r2_"))).toBe(false);
    expect(v.total).toBeCloseTo(direct.totalsByService.cloudflare! - r2.reduce((s, i) => s + i.cost, 0), 2);
  });

  it("shows the last month for a month past the projection", () => {
    const mau = (month: number) => find(compare({ growthPct: 50 }, month).variants, "supabase", "pro").bars.find((b) => b.key === "mau")!.used;
    expect(mau(13)).toBe(mau(12));
    expect(mau(13)).toBeGreaterThan(mau(1));
  });

  it("reads the requested month", () => {
    const m1 = find(compare({ growthPct: 50 }, 1).variants, "supabase", "pro");
    const m6 = find(compare({ growthPct: 50 }, 6).variants, "supabase", "pro");
    expect(m6.bars.find((b) => b.key === "mau")!.used).toBeGreaterThan(m1.bars.find((b) => b.key === "mau")!.used);
  });
});

describe("cheapestThatFits", () => {
  const v = (plan: string, total: number, extra: Partial<PlanVariant> = {}): PlanVariant => ({
    role: "backend", service: "supabase", plan, label: plan, total, bars: [], payFromFirst: [], computeFits: true, overLimit: false, unavailable: null, ...extra,
  });

  it("picks the lowest total among plans that fit, the first on a tie", () => {
    const plans = [v("free", 0, { overLimit: true }), v("pro", 25), v("team", 25)];
    expect(cheapestThatFits(plans)?.plan).toBe("pro");
  });

  it("returns null when nothing fits", () => {
    expect(cheapestThatFits([v("free", 0, { overLimit: true }), v("cache", 0, { unavailable: "no" })])).toBeNull();
  });
});
