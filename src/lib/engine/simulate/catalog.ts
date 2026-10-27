// Published prices for the cost simulator. They come from pricing pages, not APIs, so
// every sheet records its source and the day it was checked. All amounts are USD.

export type Service = "supabase" | "upstash" | "vercel" | "cloudflare";

export const SERVICES: Service[] = ["supabase", "upstash", "vercel", "cloudflare"];

export const SERVICE_LABELS: Record<Service, string> = {
  supabase: "Supabase",
  upstash: "Upstash Redis",
  vercel: "Vercel",
  cloudflare: "Cloudflare",
};

export const COMPUTE_KEYS = ["nano", "micro", "small", "medium", "large", "xl", "2xl", "4xl", "8xl", "12xl", "16xl"] as const;
export type ComputeKey = (typeof COMPUTE_KEYS)[number];

export interface ComputeSize {
  key: ComputeKey;
  label: string;
  monthlyPrice: number;
  cpu: string;
  ramGB: number;
  maxDirectConnections: number;
  maxPoolerConnections: number;
  /** Assumption, not a published figure: Supabase does not publish query throughput. */
  planningQps: number;
}

export interface PriceItem {
  key: string;
  label: string;
  unit: string;
  includedQuantity: number;
  /** null: going over the included quantity is a restriction on this plan, not a charge. */
  unitPrice: number | null;
  /** Price applies per this many units. */
  unitSize: number;
  billingMode: "per_unit" | "package";
  note?: string;
}

export interface PriceSheet {
  service: Service;
  plan: string;
  label: string;
  version: string;
  verifiedAt: string; // YYYY-MM-DD
  sourceUrl: string;
  /** Per month; per seat when `perSeat` is set. */
  baseFee: number;
  perSeat?: boolean;
  /** Monthly credit offsetting the listed items (never the base fee). */
  credit?: { amount: number; appliesTo: string[] };
  items: PriceItem[];
}

export interface Catalog {
  sheets: PriceSheet[];
  /** Ascending by price. */
  compute: ComputeSize[];
  /** The only size available on Supabase Free. */
  freeCompute: ComputeKey;
}

function item(key: string, label: string, unit: string, includedQuantity: number, unitPrice: number | null, unitSize = 1, note?: string): PriceItem {
  return { key, label, unit, includedQuantity, unitPrice, unitSize, billingMode: "per_unit", ...(note ? { note } : {}) };
}

const VERSION = "2026-10";
// Day each service's values were last checked against its source. "2000-01-01" means not yet checked, which the UI shows as possibly outdated.
const SUPABASE_VERIFIED = "2026-10-27";
const UPSTASH_VERIFIED = "2026-10-27";
const VERCEL_VERIFIED = "2026-10-27";
const CLOUDFLARE_VERIFIED = "2026-10-27";

const SUPABASE_PAID_ITEMS: PriceItem[] = [
  item("mau", "Monthly active users", "users", 100_000, 0.00325),
  item("db_disk_gb", "Database disk", "GB", 8, 0.125),
  item("storage_gb", "File storage", "GB", 100, 0.0213),
  item("egress_gb", "Egress", "GB", 250, 0.09, 1, "Uncached egress only. Cached egress has its own quota: 250 GB, then $0.03 per GB."),
  item("fn_invocations", "Edge Function invocations", "calls", 2_000_000, 2, 1_000_000),
  item("rt_peak", "Realtime peak connections", "connections", 500, 10, 1_000),
  item("rt_messages", "Realtime messages", "messages", 5_000_000, 2.5, 1_000_000),
];

// R2 rounds usage up to the next whole billing unit, so these bill in packages.
const R2_ITEMS: PriceItem[] = [
  { ...item("r2_storage_gb", "R2 storage", "GB", 10, 0.015), billingMode: "package" },
  { ...item("r2_class_a", "R2 Class A operations (writes)", "ops", 1_000_000, 4.5, 1_000_000), billingMode: "package" },
  { ...item("r2_class_b", "R2 Class B operations (reads)", "ops", 10_000_000, 0.36, 1_000_000, "R2 egress is free."), billingMode: "package" },
];

export const CATALOG: Catalog = {
  freeCompute: "nano",
  compute: [
    { key: "nano", label: "Nano", monthlyPrice: 0, cpu: "Shared", ramGB: 0.5, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 50 },
    { key: "micro", label: "Micro", monthlyPrice: 10, cpu: "Shared", ramGB: 1, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 100 },
    { key: "small", label: "Small", monthlyPrice: 15, cpu: "Shared", ramGB: 2, maxDirectConnections: 90, maxPoolerConnections: 400, planningQps: 200 },
    { key: "medium", label: "Medium", monthlyPrice: 60, cpu: "Shared", ramGB: 4, maxDirectConnections: 120, maxPoolerConnections: 600, planningQps: 400 },
    { key: "large", label: "Large", monthlyPrice: 110, cpu: "2 dedicated vCPUs", ramGB: 8, maxDirectConnections: 160, maxPoolerConnections: 800, planningQps: 800 },
    { key: "xl", label: "XL", monthlyPrice: 210, cpu: "4 dedicated vCPUs", ramGB: 16, maxDirectConnections: 240, maxPoolerConnections: 1_000, planningQps: 1_500 },
    { key: "2xl", label: "2XL", monthlyPrice: 410, cpu: "8 dedicated vCPUs", ramGB: 32, maxDirectConnections: 380, maxPoolerConnections: 1_500, planningQps: 3_000 },
    { key: "4xl", label: "4XL", monthlyPrice: 960, cpu: "16 dedicated vCPUs", ramGB: 64, maxDirectConnections: 480, maxPoolerConnections: 3_000, planningQps: 6_000 },
    { key: "8xl", label: "8XL", monthlyPrice: 1_870, cpu: "32 dedicated vCPUs", ramGB: 128, maxDirectConnections: 490, maxPoolerConnections: 6_000, planningQps: 12_000 },
    { key: "12xl", label: "12XL", monthlyPrice: 2_800, cpu: "48 dedicated vCPUs", ramGB: 192, maxDirectConnections: 500, maxPoolerConnections: 9_000, planningQps: 18_000 },
    { key: "16xl", label: "16XL", monthlyPrice: 3_730, cpu: "64 dedicated vCPUs", ramGB: 256, maxDirectConnections: 500, maxPoolerConnections: 12_000, planningQps: 24_000 },
  ],
  sheets: [
    {
      service: "supabase",
      plan: "free",
      label: "Supabase Free",
      version: VERSION,
      verifiedAt: SUPABASE_VERIFIED,
      sourceUrl: "https://supabase.com/pricing",
      baseFee: 0,
      items: [
        item("mau", "Monthly active users", "users", 50_000, null),
        item(
          "db_disk_gb",
          "Database size",
          "GB",
          0.5,
          null,
          1,
          "Quota summed across the organization's projects, averaged daily over the billing cycle. Going over can restrict the organization (requests return 402).",
        ),
        item("storage_gb", "File storage", "GB", 1, null),
        item("egress_gb", "Egress", "GB", 5, null, 1, "Uncached egress only. Cached egress has its own 5 GB quota."),
        item("fn_invocations", "Edge Function invocations", "calls", 500_000, null),
        item("rt_peak", "Realtime peak connections", "connections", 200, null),
        item("rt_messages", "Realtime messages", "messages", 2_000_000, null),
      ],
    },
    {
      service: "supabase",
      plan: "pro",
      label: "Supabase Pro",
      version: VERSION,
      verifiedAt: SUPABASE_VERIFIED,
      sourceUrl: "https://supabase.com/pricing",
      baseFee: 25,
      credit: { amount: 10, appliesTo: ["compute"] },
      items: SUPABASE_PAID_ITEMS,
    },
    {
      service: "supabase",
      plan: "team",
      label: "Supabase Team",
      version: VERSION,
      verifiedAt: SUPABASE_VERIFIED,
      sourceUrl: "https://supabase.com/pricing",
      baseFee: 599,
      credit: { amount: 10, appliesTo: ["compute"] },
      items: SUPABASE_PAID_ITEMS,
    },
    {
      service: "upstash",
      plan: "payg",
      label: "Upstash Redis pay as you go",
      version: VERSION,
      verifiedAt: UPSTASH_VERIFIED,
      sourceUrl: "https://upstash.com/pricing/redis",
      baseFee: 0,
      items: [
        item("commands", "Commands", "commands", 0, 0.2, 100_000, "No free commands once on pay as you go. Writes to a global database also count once per read region."),
        item("storage_gb", "Storage", "GB", 1, 0.25, 1, "First 1 GB free per database, summed across replicas and regions."),
      ],
    },
    {
      service: "vercel",
      plan: "hobby",
      label: "Vercel Hobby",
      version: VERSION,
      verifiedAt: VERCEL_VERIFIED,
      sourceUrl: "https://vercel.com/pricing",
      baseFee: 0,
      items: [
        item("edge_requests", "CDN requests", "requests", 1_000_000, null, 1, "Hobby is for non-commercial use."),
        item("fn_invocations", "Function invocations", "calls", 1_000_000, null),
        item("cpu_hours", "Active CPU", "hours", 4, null),
        item("transfer_gb", "Fast data transfer", "GB", 100, null),
      ],
    },
    {
      service: "vercel",
      plan: "pro",
      label: "Vercel Pro",
      version: VERSION,
      verifiedAt: VERCEL_VERIFIED,
      sourceUrl: "https://vercel.com/pricing",
      baseFee: 20,
      perSeat: true,
      credit: { amount: 20, appliesTo: ["edge_requests", "fn_invocations", "cpu_hours", "transfer_gb"] },
      items: [
        item(
          "edge_requests",
          "CDN requests",
          "requests",
          1_000_000,
          2,
          1_000_000,
          "Pro's free Flat Rate CDN tier covers 1M requests and 1 TB transfer. Above it Vercel moves you to a paid tier the next cycle ($20/mo for 10M, $100/mo for 50M, $300/mo for 150M). Each tier works out to $2 per million, so this estimate charges $2 per million above 1M rather than stepping between tiers.",
        ),
        item("fn_invocations", "Function invocations", "calls", 0, 0.6, 1_000_000, "Pro has no included invocations; the usage credit offsets them."),
        item("cpu_hours", "Active CPU", "hours", 0, 0.128, 1, "Rate in iad1 (also cle1, pdx1). Other regions cost up to $0.221 per hour."),
        item(
          "transfer_gb",
          "Fast data transfer",
          "GB",
          1_000,
          0.15,
          1,
          "Included by Pro's free Flat Rate CDN tier; paid tiers raise it to 50 TB. The price shown is the on-demand rate in iad1, charged from the first GB if Flat Rate CDN is off.",
        ),
      ],
    },
    {
      service: "cloudflare",
      plan: "free",
      label: "Cloudflare Workers Free",
      version: VERSION,
      verifiedAt: CLOUDFLARE_VERIFIED,
      sourceUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
      baseFee: 0,
      items: [
        item("requests", "Workers requests", "requests", 3_000_000, null, 1, "100,000 a day, shown per month. Each request is limited to 10 ms CPU."),
        ...R2_ITEMS,
      ],
    },
    {
      service: "cloudflare",
      plan: "paid",
      label: "Cloudflare Workers Paid",
      version: VERSION,
      verifiedAt: CLOUDFLARE_VERIFIED,
      sourceUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
      baseFee: 5,
      items: [
        item("requests", "Workers requests", "requests", 10_000_000, 0.3, 1_000_000),
        item("cpu_ms", "Workers CPU time", "ms", 30_000_000, 0.02, 1_000_000),
        ...R2_ITEMS,
      ],
    },
  ],
};

export function sheetFor(catalog: Catalog, service: Service, plan: string): PriceSheet | undefined {
  return catalog.sheets.find((s) => s.service === service && s.plan === plan);
}

export function computeSize(catalog: Catalog, key: ComputeKey): ComputeSize {
  const size = catalog.compute.find((c) => c.key === key);
  if (!size) throw new Error(`Unknown compute size ${key}`);
  return size;
}
