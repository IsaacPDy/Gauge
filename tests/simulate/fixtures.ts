import type { Catalog } from "@/lib/engine/simulate/catalog";
import { presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";
import { resolveStack } from "@/lib/engine/simulate/stack";
import type { MonthUsage } from "@/lib/engine/simulate/workload";

/** Small SaaS preset with overrides. */
export function inputsWith(overrides: Partial<SimInputs> = {}): SimInputs {
  return { ...presetInputs("small_saas"), ...overrides };
}

export function stackWith(overrides: Partial<SimInputs> = {}) {
  return resolveStack(inputsWith(overrides)).stack;
}

const sheet = { version: "test", verifiedAt: "2026-10-01" } as const;
const per = (key: string, includedQuantity: number, unitPrice: number | null, unitSize = 1) => ({
  key,
  label: key,
  unit: "",
  includedQuantity,
  unitPrice,
  unitSize,
  billingMode: "per_unit" as const,
});

/** Round numbers, fixed forever, so expected values in tests are easy to check by hand. */
export const TEST_CATALOG: Catalog = {
  freeCompute: "nano",
  compute: [
    { key: "nano", label: "Nano", monthlyPrice: 0, cpu: "", ramGB: 0.5, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 50 },
    { key: "micro", label: "Micro", monthlyPrice: 10, cpu: "", ramGB: 1, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 100 },
    { key: "small", label: "Small", monthlyPrice: 15, cpu: "", ramGB: 2, maxDirectConnections: 90, maxPoolerConnections: 400, planningQps: 200 },
    { key: "medium", label: "Medium", monthlyPrice: 60, cpu: "", ramGB: 4, maxDirectConnections: 120, maxPoolerConnections: 600, planningQps: 400 },
  ],
  sheets: [
    { ...sheet, service: "supabase", plan: "free", label: "Supabase Free", sourceUrl: "https://example.test/sb", baseFee: 0, items: [per("mau", 50_000, null), per("egress_gb", 5, null)] },
    {
      ...sheet,
      service: "supabase",
      plan: "pro",
      label: "Supabase Pro",
      sourceUrl: "https://example.test/sb",
      baseFee: 25,
      credit: { amount: 10, appliesTo: ["compute"] },
      items: [per("mau", 100_000, 0.00325), per("egress_gb", 250, 0.09)],
    },
    { ...sheet, service: "upstash", plan: "payg", label: "Upstash", sourceUrl: "https://example.test/up", baseFee: 0, items: [per("commands", 0, 0.2, 100_000), per("storage_gb", 0, 0.25)] },
    {
      ...sheet,
      service: "vercel",
      plan: "pro",
      label: "Vercel Pro",
      sourceUrl: "https://example.test/vc",
      baseFee: 20,
      perSeat: true,
      credit: { amount: 20, appliesTo: ["fn_invocations", "transfer_gb"] },
      items: [per("fn_invocations", 1_000_000, 0.6, 1_000_000), per("transfer_gb", 1_000, 0.15)],
    },
    { ...sheet, service: "cloudflare", plan: "paid", label: "Cloudflare Paid", sourceUrl: "https://example.test/cf", baseFee: 5, items: [per("requests", 10_000_000, 0.3, 1_000_000), per("r2_storage_gb", 10, 0.015)] },
  ],
};

/** TEST_CATALOG with a cache that costs nothing, to isolate compute and egress effects. */
export const FREE_CACHE_CATALOG: Catalog = {
  ...TEST_CATALOG,
  sheets: TEST_CATALOG.sheets.map((s) => (s.service === "upstash" ? { ...s, items: s.items.map((i) => ({ ...i, unitPrice: 0 })) } : s)),
};

export function zeroUsage(overrides: Partial<MonthUsage> = {}): MonthUsage {
  return {
    month: 1, mau: 0, dau: 0, requests: 0, dbQueries: 0, reads: 0, writes: 0, cacheHits: 0, dbHits: 0,
    avgDbQps: 0, peakDbQps: 0, peakConnections: 0, apiEgressGB: 0, hostEgressGB: 0, supabaseEgressGB: 0,
    fileEgressGB: 0, dbSizeGB: 0, storageGB: 0, storageAddedGB: 0, fnInvocations: 0, rtPeakConnections: 0,
    rtMessages: 0, serverRequests: 0, cpuMs: 0, cacheCommands: 0, cacheStorageGB: 0, cacheKeys: 0,
    fileWrites: 0, fileReads: 0,
    ...overrides,
  };
}

/** Extra items for routing and unit-conversion tests in price.test.ts. Round numbers on purpose. */
export const ROUTING_CATALOG: Catalog = {
  ...TEST_CATALOG,
  sheets: [
    ...TEST_CATALOG.sheets.filter((s) => s.service !== "vercel" && s.service !== "cloudflare"),
    { ...sheet, service: "vercel", plan: "pro", label: "Vercel Pro", sourceUrl: "https://example.test/vc", baseFee: 0, items: [per("edge_requests", 0, 1, 1_000_000), per("cpu_hours", 0, 1)] },
    {
      ...sheet,
      service: "cloudflare",
      plan: "paid",
      label: "Cloudflare Paid",
      sourceUrl: "https://example.test/cf",
      baseFee: 0,
      items: [
        per("cpu_ms", 0, 1, 1_000_000),
        per("r2_storage_gb", 0, 1),
        { ...per("r2_class_a", 1_000_000, 4.5, 1_000_000), billingMode: "package" as const },
        { ...per("r2_class_b", 0, 1, 1_000_000) },
      ],
    },
  ],
};
