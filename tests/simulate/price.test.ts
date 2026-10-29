import { describe, expect, it } from "vitest";
import { graduatedCost } from "@/lib/engine/cost";
import type { Catalog } from "@/lib/engine/simulate/catalog";
import { priceMonth } from "@/lib/engine/simulate/price";
import { ROUTING_CATALOG, stackWith, TEST_CATALOG, zeroUsage } from "./fixtures";

const sum = (items: { cost: number }[]) => Math.round(items.reduce((s, i) => s + i.cost, 0) * 100) / 100;
const of = <T extends { service: string }>(items: T[], service: string) => items.filter((i) => i.service === service);

describe("priceMonth", () => {
  it("prices Supabase Pro overage, compute and the compute credit", () => {
    const items = priceMonth(zeroUsage({ mau: 120_000, backendEgressGB: 200, fileEgressGB: 100 }), stackWith(), "micro", TEST_CATALOG);
    const sb = of(items, "supabase");
    expect(sb.find((i) => i.key === "base")?.cost).toBe(25);
    expect(sb.find((i) => i.key === "compute")?.cost).toBe(10);
    expect(sb.find((i) => i.key === "mau")).toMatchObject({ usage: 120_000, included: 100_000, billable: 20_000, cost: 65 });
    expect(sb.find((i) => i.key === "egress_gb")).toMatchObject({ usage: 300, billable: 50, cost: 4.5 });
    expect(sb.find((i) => i.key === "credit")?.cost).toBe(-10);
    expect(sum(sb)).toBe(94.5);
  });

  it("leaves file egress out of Supabase when files live in R2", () => {
    const stack = stackWith({ cloudflare: "paid", fileStore: "r2" });
    const items = priceMonth(zeroUsage({ backendEgressGB: 200, fileEgressGB: 100 }), stack, "micro", TEST_CATALOG);
    expect(items.find((i) => i.service === "supabase" && i.key === "egress_gb")?.usage).toBe(200);
  });

  it("flags usage above a free limit as restricted, never as a charge", () => {
    const items = priceMonth(zeroUsage({ mau: 60_000 }), stackWith({ supabase: "free" }), "nano", TEST_CATALOG);
    const mau = items.find((i) => i.service === "supabase" && i.key === "mau")!;
    expect(mau.restricted).toBe(true);
    expect(mau.cost).toBe(0);
    expect(sum(of(items, "supabase"))).toBe(0);
  });

  it("charges the base fee per seat and caps the usage credit", () => {
    const stack = stackWith({ supabase: "off", seats: 3 });
    const heavy = priceMonth(zeroUsage({ serverRequests: 3_000_000, hostEgressGB: 1_200 }), stack, null, TEST_CATALOG);
    expect(heavy.find((i) => i.key === "base")).toMatchObject({ cost: 60, label: "Vercel Pro plan (3 seats)" });
    expect(heavy.find((i) => i.key === "credit")?.cost).toBe(-20);
    expect(sum(heavy)).toBe(71.2);

    const light = priceMonth(zeroUsage({ serverRequests: 1_500_000, hostEgressGB: 1_000 }), stack, null, TEST_CATALOG);
    expect(light.find((i) => i.key === "credit")?.cost).toBe(-0.3);
    expect(sum(light)).toBe(60);
  });

  it("prices the cache and notes its key count", () => {
    const items = priceMonth(zeroUsage({ cacheCommands: 20_880_000, cacheStorageGB: 0.2, cacheKeys: 100_000 }), stackWith({ cache: "upstash_payg" }), "micro", TEST_CATALOG);
    const up = of(items, "upstash");
    expect(up.find((i) => i.key === "commands")?.cost).toBe(41.76);
    expect(up.find((i) => i.key === "storage_gb")).toMatchObject({ cost: 0.05, note: "About 100K keys." });
  });

  it("leaves the key count off the cache storage note when there are no keys", () => {
    const items = priceMonth(zeroUsage({ cacheStorageGB: 0.2, cacheKeys: 0 }), stackWith({ cache: "upstash_payg" }), "micro", TEST_CATALOG);
    expect(items.find((i) => i.service === "upstash" && i.key === "storage_gb")?.note).toBeUndefined();
  });

  it("prices Cloudflare Workers and R2 when they host the API and files", () => {
    const stack = stackWith({ cloudflare: "paid", host: "cloudflare", fileStore: "r2", supabase: "off", vercel: "off" });
    const items = priceMonth(zeroUsage({ serverRequests: 12_000_000, storageGB: 30 }), stack, null, TEST_CATALOG);
    expect(items.every((i) => i.service === "cloudflare")).toBe(true);
    expect(sum(items)).toBe(5.9);
  });

  it("converts Vercel requests and CPU milliseconds into billed units", () => {
    const items = priceMonth(zeroUsage({ serverRequests: 3_000_000, cpuMs: 7_200_000 }), stackWith({ supabase: "off" }), null, ROUTING_CATALOG);
    const vc = of(items, "vercel");
    expect(vc.find((i) => i.key === "edge_requests")).toMatchObject({ usage: 3_000_000, cost: 3 });
    expect(vc.find((i) => i.key === "cpu_hours")).toMatchObject({ usage: 2, cost: 2 });
  });

  it("converts Cloudflare CPU and R2 operations into billed units", () => {
    const stack = stackWith({ supabase: "off", vercel: "off", cloudflare: "paid", host: "cloudflare", fileStore: "r2" });
    const items = priceMonth(zeroUsage({ cpuMs: 5_000_000, storageGB: 7, fileWrites: 1_500_000, fileReads: 2_000_000 }), stack, null, ROUTING_CATALOG);
    const cf = of(items, "cloudflare");
    expect(cf.find((i) => i.key === "cpu_ms")?.cost).toBe(5);
    expect(cf.find((i) => i.key === "r2_storage_gb")).toMatchObject({ usage: 7, cost: 7 });
    expect(cf.find((i) => i.key === "r2_class_a")).toMatchObject({ billable: 500_000, cost: 4.5 });
    expect(cf.find((i) => i.key === "r2_class_b")?.cost).toBe(2);
  });

  it("does not bill a whole package for floating-point noise", () => {
    const stack = stackWith({ supabase: "off", vercel: "off", cloudflare: "paid", host: "cloudflare", fileStore: "r2" });
    const items = priceMonth(zeroUsage({ fileWrites: 1_000_000 + 1e-7 }), stack, null, ROUTING_CATALOG);
    expect(items.find((i) => i.key === "r2_class_a")?.cost).toBe(0);
  });

  it("routes file storage to R2 or Supabase by the file store", () => {
    const r2 = priceMonth(zeroUsage({ storageGB: 7 }), stackWith({ cloudflare: "paid", fileStore: "r2" }), "micro", ROUTING_CATALOG);
    expect(r2.some((i) => i.service === "supabase" && i.key === "storage_gb" && i.usage > 0)).toBe(false);
    expect(r2.find((i) => i.service === "cloudflare" && i.key === "r2_storage_gb")?.usage).toBe(7);

    const sb = priceMonth(zeroUsage({ storageGB: 7 }), stackWith({ cloudflare: "paid" }), "micro", ROUTING_CATALOG);
    expect(sb.find((i) => i.service === "cloudflare" && i.key === "r2_storage_gb")?.usage).toBe(0);
  });

  it("produces no items for services that are off", () => {
    const items = priceMonth(zeroUsage(), stackWith({ supabase: "off", vercel: "off" }), null, TEST_CATALOG);
    expect(items).toEqual([]);
  });
});

const MAU_TIERS = [
  { upTo: 100_000, unitPrice: 0.0055 },
  { upTo: 1_000_000, unitPrice: 0.0046 },
  { upTo: 10_000_000, unitPrice: 0.0032 },
  { upTo: null, unitPrice: 0.0025 },
];

describe("graduatedCost", () => {
  it("charges nothing within the included quantity", () => {
    expect(graduatedCost(40_000, 50_000, MAU_TIERS)).toBe(0);
  });

  it("charges each tier's price for the units inside it", () => {
    expect(graduatedCost(80_000, 50_000, MAU_TIERS)).toBe(165);
    // Google's own worked examples on the Identity Platform pricing page.
    expect(graduatedCost(131_000, 50_000, MAU_TIERS)).toBe(417.6);
    expect(graduatedCost(225_000, 50_000, MAU_TIERS)).toBe(850);
  });

  it("uses the unbounded last tier", () => {
    expect(graduatedCost(12_000_000, 50_000, MAU_TIERS)).toBe(38_215);
  });

  it("starts billing at the included quantity when it sits above the first boundary", () => {
    expect(graduatedCost(200_000, 150_000, MAU_TIERS)).toBe(230);
  });

  it("prices per unit size", () => {
    expect(graduatedCost(5_000_000, 2_000_000, [{ upTo: null, unitPrice: 0.4 }], 1_000_000)).toBe(1.2);
  });
});

describe("priceMonth with tiers", () => {
  it("prices a tiered item with graduatedCost", () => {
    const catalog: Catalog = {
      ...TEST_CATALOG,
      sheets: TEST_CATALOG.sheets.map((s) =>
        s.service === "supabase" && s.plan === "pro"
          ? {
              ...s,
              items: s.items.map((i) =>
                i.key === "mau" ? { ...i, tiers: [{ upTo: 200_000, unitPrice: 0.00325 }, { upTo: null, unitPrice: 0.001 }] } : i,
              ),
            }
          : s,
      ),
    };
    const items = priceMonth(zeroUsage({ mau: 250_000 }), stackWith(), "micro", catalog);
    expect(items.find((i) => i.service === "supabase" && i.key === "mau")?.cost).toBe(375);
  });
});
