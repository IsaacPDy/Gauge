import { describe, expect, it } from "vitest";
import { CATALOG, COMPUTE_KEYS, computeSize, sheetFor } from "@/lib/engine/simulate/catalog";

const PLANS: Record<string, string[]> = {
  supabase: ["free", "pro", "team"],
  upstash: ["payg"],
  vercel: ["hobby", "pro"],
  cloudflare: ["free", "paid"],
};

describe("CATALOG", () => {
  it("has exactly one sheet for every plan the simulator offers", () => {
    for (const [service, plans] of Object.entries(PLANS)) {
      for (const plan of plans) {
        expect(CATALOG.sheets.filter((s) => s.service === service && s.plan === plan)).toHaveLength(1);
      }
    }
    expect(CATALOG.sheets).toHaveLength(Object.values(PLANS).flat().length);
  });

  it("records provenance on every sheet", () => {
    for (const s of CATALOG.sheets) {
      expect(s.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.sourceUrl).toMatch(/^https:\/\//);
      expect(s.version).not.toBe("");
    }
  });

  it("only credits items that exist on the sheet (or compute)", () => {
    for (const s of CATALOG.sheets) {
      const keys = new Set(s.items.map((i) => i.key));
      for (const k of s.credit?.appliesTo ?? []) expect(k === "compute" || keys.has(k)).toBe(true);
    }
  });

  it("uses positive unit sizes and non-negative prices", () => {
    for (const s of CATALOG.sheets) {
      for (const i of s.items) {
        expect(i.unitSize).toBeGreaterThan(0);
        expect(i.includedQuantity).toBeGreaterThanOrEqual(0);
        if (i.unitPrice !== null) expect(i.unitPrice).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("lists compute sizes in COMPUTE_KEYS order, growing in price and capacity", () => {
    expect(CATALOG.compute.map((c) => c.key)).toEqual([...COMPUTE_KEYS]);
    for (let i = 1; i < CATALOG.compute.length; i++) {
      expect(CATALOG.compute[i].monthlyPrice).toBeGreaterThan(CATALOG.compute[i - 1].monthlyPrice);
      expect(CATALOG.compute[i].planningQps).toBeGreaterThanOrEqual(CATALOG.compute[i - 1].planningQps);
    }
    expect(CATALOG.freeCompute).toBe("nano");
  });

  it("looks up sheets and sizes", () => {
    expect(sheetFor(CATALOG, "supabase", "pro")?.label).toBe("Supabase Pro");
    expect(sheetFor(CATALOG, "supabase", "enterprise")).toBeUndefined();
    expect(computeSize(CATALOG, "small").label).toBe("Small");
  });
});
