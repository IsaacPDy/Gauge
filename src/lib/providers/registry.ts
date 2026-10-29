import type { MetricDefinition, PricingRule, ProviderId } from "../types";
import { demoAdapter } from "./demo/adapter";
import { cloudflareAdapter } from "./cloudflare/adapter";
import { neonAdapter } from "./neon/adapter";
import { supabaseAdapter } from "./supabase/adapter";
import { vercelAdapter } from "./vercel/adapter";
import type { ProviderAdapter } from "./types";

export function demoEnabled(): boolean {
  return process.env.ENABLE_DEMO_PROVIDER === "true";
}

const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  supabase: supabaseAdapter,
  neon: neonAdapter,
  cloudflare: cloudflareAdapter,
  vercel: vercelAdapter,
  demo: demoAdapter,
};

export function getAdapter(id: string): ProviderAdapter | null {
  return ADAPTERS[id as ProviderId] ?? null;
}

export const PROVIDER_CATEGORIES = [
  { id: "database", name: "Databases & backend" },
  { id: "hosting", name: "Hosting & compute" },
  { id: "cloud", name: "Cloud platforms" },
  { id: "messaging", name: "Email & SMS" },
] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number]["id"];

export interface CatalogEntry {
  /**
   * Planned integrations are not stored anywhere, so their ids are plain strings. An id
   * joins ProviderId (and the connections.provider check constraint) once its adapter exists.
   */
  id: string;
  name: string;
  category: ProviderCategory;
  available: boolean;
  description: string;
}

/**
 * Catalog shown on the Providers page, including integrations that are not built yet.
 * Within a category, entries are listed in planned build order.
 */
export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    id: "supabase",
    name: "Supabase",
    category: "database",
    available: true,
    description: "Organizations, projects, database & storage size, MAU estimate, API requests.",
  },
  {
    id: "neon",
    name: "Neon",
    category: "database",
    available: true,
    description: "Compute hours, storage, data written and branches per project.",
  },
  {
    id: "firebase",
    name: "Firebase",
    category: "database",
    available: false,
    description: "Firestore reads, writes and storage, Auth MAU and Cloud Functions invocations.",
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "hosting",
    available: true,
    description: "Function invocations, edge requests, data transfer, build minutes and billing charges.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "hosting",
    available: true,
    description: "Workers requests and CPU time, R2 storage and operations, D1 rows, KV operations.",
  },
  {
    id: "railway",
    name: "Railway",
    category: "hosting",
    available: false,
    description: "CPU, memory, network and disk usage per project, plus the estimated bill.",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    category: "hosting",
    available: false,
    description: "Account balance, billing history, Droplet and App Platform usage.",
  },
  { id: "aws", name: "AWS", category: "cloud", available: false, description: "Cost Explorer spend, budgets and Limit Gauge metrics." },
  {
    id: "gcp",
    name: "Google Cloud",
    category: "cloud",
    available: false,
    description: "Cloud Billing budgets and Cloud Monitoring metrics.",
  },
  { id: "azure", name: "Azure", category: "cloud", available: false, description: "Cost Management spend and budgets." },
  {
    id: "twilio",
    name: "Twilio",
    category: "messaging",
    available: false,
    description: "SMS and voice usage and spend by category.",
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    category: "messaging",
    available: false,
    description: "Emails sent and delivered against the plan's monthly limit.",
  },
];

export const PROVIDER_NAMES: Record<string, string> = {
  ...Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p.name])),
  demo: "Demo Cloud",
};

/**
 * The adapter for a provider the user may connect with a pasted token: it must be
 * available in the catalog and accept token auth. Null otherwise (including demo).
 */
export function tokenProvider(id: string): ProviderAdapter | null {
  const adapter = getAdapter(id);
  const listed = PROVIDER_CATALOG.find((p) => p.id === id);
  if (!adapter || !listed?.available || !adapter.authMethods.includes("token")) return null;
  return adapter;
}

const allAdapters = () => Object.values(ADAPTERS) as ProviderAdapter[];

export function allMetricDefinitions(): MetricDefinition[] {
  return allAdapters().flatMap((a) => a.metrics);
}

export function allPricingRules(): PricingRule[] {
  return allAdapters().flatMap((a) => a.pricingRules);
}

const metricIndex = new Map(allMetricDefinitions().map((m) => [m.key, m]));
export function getMetric(key: string): MetricDefinition | undefined {
  return metricIndex.get(key);
}

const pricingIndex = new Map(allPricingRules().map((r) => [r.id, r]));
export function getPricingRule(id: string | null | undefined): PricingRule | null {
  return id ? (pricingIndex.get(id) ?? null) : null;
}

/** Latest pricing rule for a metric and plan, if one is known. */
export function findPricingRule(metricKey: string, plan: string | null | undefined): PricingRule | null {
  if (!plan) return null;
  const matches = allPricingRules().filter((r) => r.metricKey === metricKey && r.plan === plan);
  return matches.sort((a, b) => b.version.localeCompare(a.version))[0] ?? null;
}

export function recommendationFor(metricKey: string): string {
  const provider = metricKey.split(".")[0];
  return (
    getAdapter(provider)?.recommendations[metricKey] ??
    "Open the provider dashboard to inspect what is driving usage, then adjust the application or the plan."
  );
}
