import type { MetricDefinition, PricingRule, ProviderId } from "../types";
import { demoAdapter } from "./demo/adapter";
import { supabaseAdapter } from "./supabase/adapter";
import type { ProviderAdapter } from "./types";

export function demoEnabled(): boolean {
  return process.env.ENABLE_DEMO_PROVIDER === "true";
}

const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  supabase: supabaseAdapter,
  demo: demoAdapter,
};

export function getAdapter(id: string): ProviderAdapter | null {
  return ADAPTERS[id as ProviderId] ?? null;
}

/** Catalog shown on the Providers page, including integrations that are not built yet. */
export const PROVIDER_CATALOG: { id: ProviderId; name: string; available: boolean; description: string }[] = [
  {
    id: "supabase",
    name: "Supabase",
    available: true,
    description: "Organizations, projects, database & storage size, MAU estimate, API requests.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    available: false,
    description: "Workers, R2 and D1 billable usage. Planned for the next release.",
  },
  {
    id: "firebase",
    name: "Firebase / Google Cloud",
    available: false,
    description: "Cloud Monitoring metrics and Cloud Billing budgets. Planned.",
  },
  { id: "aws", name: "AWS", available: false, description: "Cost Explorer spend and budgets. Planned." },
];

export const PROVIDER_NAMES: Record<string, string> = {
  supabase: "Supabase",
  cloudflare: "Cloudflare",
  firebase: "Firebase",
  aws: "AWS",
  demo: "Demo Cloud",
};

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
