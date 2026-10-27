import { describe, expect, it } from "vitest";
import { priceMonth } from "@/lib/engine/simulate/price";
import { stackWith, TEST_CATALOG, zeroUsage } from "./fixtures";

const sum = (items: { cost: number }[]) => Math.round(items.reduce((s, i) => s + i.cost, 0) * 100) / 100;
const of = <T extends { service: string }>(items: T[], service: string) => items.filter((i) => i.service === service);

describe("priceMonth", () => {
  it("prices Supabase Pro overage, compute and the compute credit", () => {
    const items = priceMonth(zeroUsage({ mau: 120_000, supabaseEgressGB: 200, fileEgressGB: 100 }), stackWith(), "micro", TEST_CATALOG);
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
    const items = priceMonth(zeroUsage({ supabaseEgressGB: 200, fileEgressGB: 100 }), stack, "micro", TEST_CATALOG);
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

  it("prices Cloudflare Workers and R2 when they host the API and files", () => {
    const stack = stackWith({ cloudflare: "paid", host: "cloudflare", fileStore: "r2", supabase: "off", vercel: "off" });
    const items = priceMonth(zeroUsage({ serverRequests: 12_000_000, storageGB: 30 }), stack, null, TEST_CATALOG);
    expect(items.every((i) => i.service === "cloudflare")).toBe(true);
    expect(sum(items)).toBe(5.9);
  });

  it("produces no items for services that are off", () => {
    const items = priceMonth(zeroUsage(), stackWith({ supabase: "off", vercel: "off" }), null, TEST_CATALOG);
    expect(items).toEqual([]);
  });
});
