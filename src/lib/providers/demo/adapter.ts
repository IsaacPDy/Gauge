import { GB, MB } from "../../units";
import { DAY_MS, type Cycle, startOfUtcDay } from "../../engine/time";
import type { MetricDefinition, PricingRule } from "../../types";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type Discovery,
  type ProviderQuota,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Development-only provider that generates deterministic sample data, so the whole
// pipeline (discovery → collection → quotas → forecasts → alerts) can be exercised
// without real credentials. Every value it produces is stored with source "demo"
// and badged as demo data in the UI.

const D = {
  databaseSize: "demo.database_size",
  apiRequests: "demo.api_requests",
  mau: "demo.monthly_active_users",
  egress: "demo.egress",
  invocations: "demo.function_invocations",
} as const;

const metrics: MetricDefinition[] = [
  { key: D.databaseSize, name: "Database size", unit: "bytes", aggregation: "gauge", description: "Simulated database size." },
  { key: D.apiRequests, name: "API requests", unit: "count", aggregation: "incremental", description: "Simulated daily API requests." },
  { key: D.mau, name: "Monthly active users", unit: "count", aggregation: "cumulative", description: "Simulated cycle-to-date MAU." },
  { key: D.egress, name: "Egress", unit: "bytes", aggregation: "cumulative", description: "Simulated cycle-to-date egress." },
  {
    key: D.invocations,
    name: "Function invocations",
    unit: "count",
    aggregation: "incremental",
    description: "Simulated daily function invocations.",
  },
].map((m) => ({ ...m, provider: "demo", scopeLevel: "resource", derivation: "reported", supported: true }) as MetricDefinition);

const pricingRules: PricingRule[] = [
  {
    id: "demo.pro.egress@demo",
    provider: "demo",
    metricKey: D.egress,
    plan: "pro",
    version: "demo",
    currency: "USD",
    includedQuantity: 250 * GB,
    unitPrice: 0.09,
    unitSize: GB,
    billingMode: "per_unit",
    verifiedAt: "2026-10-09",
    notes: "Demo pricing for illustration only.",
  },
  {
    id: "demo.pro.monthly_active_users@demo",
    provider: "demo",
    metricKey: D.mau,
    plan: "pro",
    version: "demo",
    currency: "USD",
    includedQuantity: 100_000,
    unitPrice: 0.00325,
    unitSize: 1,
    billingMode: "per_unit",
    verifiedAt: "2026-10-09",
    notes: "Demo pricing for illustration only.",
  },
  {
    id: "demo.pro.function_invocations@demo",
    provider: "demo",
    metricKey: D.invocations,
    plan: "pro",
    version: "demo",
    currency: "USD",
    includedQuantity: 2_000_000,
    unitPrice: 2,
    unitSize: 1_000_000,
    billingMode: "package",
    verifiedAt: "2026-10-09",
    notes: "Demo pricing for illustration only.",
  },
];

interface Profile {
  org: "demo-hobby" | "demo-startup";
  name: string;
  /** Database size 30 days ago and daily growth. */
  db: [number, number];
  apiPerDay: number;
  mauPerDay: number;
  egressPerDay: number;
  invocationsPerDay: number;
}

const PROJECTS: Record<string, Profile> = {
  "demo-portfolio": { org: "demo-hobby", name: "portfolio-site", db: [110 * MB, 0.4 * MB], apiPerDay: 2_400, mauPerDay: 40, egressPerDay: 0.05 * GB, invocationsPerDay: 900 },
  "demo-sideproject": { org: "demo-hobby", name: "side-project-api", db: [370 * MB, 3 * MB], apiPerDay: 41_000, mauPerDay: 700, egressPerDay: 0.16 * GB, invocationsPerDay: 9_000 },
  "demo-saas-prod": { org: "demo-startup", name: "saas-production", db: [1.6 * GB, 18 * MB], apiPerDay: 180_000, mauPerDay: 3_900, egressPerDay: 8.6 * GB, invocationsPerDay: 82_000 },
  "demo-saas-staging": { org: "demo-startup", name: "saas-staging", db: [240 * MB, 1 * MB], apiPerDay: 9_000, mauPerDay: 15, egressPerDay: 0.3 * GB, invocationsPerDay: 4_000 },
};

const ORGS = {
  "demo-hobby": { name: "Hobby Org (Free plan)", plan: "free" },
  "demo-startup": { name: "Startup Inc (Pro plan)", plan: "pro" },
} as const;

/** Deterministic pseudo-random in [0, 1) for a given string. */
function rand(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h += 0x6d2b79f5;
  let t = Math.imul(h ^ (h >>> 15), h | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Daily amount with ±15% noise and a weekend dip; deterministic per (project, metric, day). */
function dailyAmount(ref: string, metric: string, day: Date, perDay: number): number {
  const weekend = [0, 6].includes(day.getUTCDay()) ? 0.75 : 1;
  const noise = 0.85 + rand(`${ref}:${metric}:${day.toISOString().slice(0, 10)}`) * 0.3;
  return perDay * weekend * noise;
}

/** Cycle-to-date total up to `at` (today counts proportionally to the time elapsed). */
function cycleToDate(ref: string, metric: string, perDay: number, cycleStart: Date, at: Date): number {
  let total = 0;
  for (let t = cycleStart.getTime(); t < at.getTime(); t += DAY_MS) {
    const day = new Date(t);
    const fraction = Math.min(1, (at.getTime() - t) / DAY_MS);
    total += dailyAmount(ref, metric, day, perDay) * fraction;
  }
  return Math.round(total);
}

function failIfSimulated(ctx: AdapterContext, stage: "validate" | "discover" | "collect") {
  if (ctx.credentials.kind !== "demo") throw new ProviderError("auth_invalid", "Demo connection has no demo credentials");
  switch (ctx.credentials.simulate) {
    case "auth_expired":
      throw new ProviderError("auth_invalid", "Simulated: the access token was revoked (401)", { status: 401 });
    case "permission":
      if (stage !== "validate") throw new ProviderError("permission_denied", "Simulated: missing read permission (403)", { status: 403 });
      break;
    case "rate_limited":
      if (stage === "collect") throw new ProviderError("rate_limited", "Simulated: rate limited (429)", { status: 429 });
      break;
    case "outage":
      if (stage !== "validate") throw new ProviderError("provider_unavailable", "Simulated: provider returned 503", { status: 503 });
      break;
  }
}

export const demoAdapter: ProviderAdapter = {
  id: "demo",
  name: "Demo Cloud",
  authMethods: ["demo"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Two sample organizations" },
    resourceDiscovery: { level: "supported", note: "Four sample projects" },
    usageMetrics: { level: "supported", note: "Generated daily history" },
    quotaRetrieval: { level: "supported", note: "Sample provider-reported quotas (API requests intentionally have none)" },
    actualCost: { level: "supported", note: "Sample reported spend for the Pro organization" },
    forecastingInputs: { level: "supported" },
    billingCycleMetadata: { level: "unsupported", note: "Uses each organization's configured cycle day" },
    accountControls: { level: "unsupported" },
  },
  metrics,
  pricingRules,
  planAllowances: [],
  recommendations: {
    [D.databaseSize]: "Archive or delete old rows and run VACUUM; upgrade before the Free plan's read-only limit.",
    [D.apiRequests]: "Look for polling loops and add caching.",
    [D.mau]: "Check sign-ups for abuse and plan an upgrade if growth is expected.",
    [D.egress]: "Add CDN caching for large responses and avoid re-downloading unchanged data.",
    [D.invocations]: "Batch work and remove unnecessary scheduled invocations.",
  },

  async validate(ctx) {
    failIfSimulated(ctx, "validate");
    return { identity: "Demo account", grantedScopes: ["demo:read"] };
  },

  async discover(ctx): Promise<Discovery> {
    failIfSimulated(ctx, "discover");
    return {
      accounts: Object.entries(ORGS).map(([id, o]) => ({
        externalId: id,
        name: o.name,
        accountType: "organization" as const,
        plan: o.plan,
        billingCurrency: "USD",
        dashboardUrl: null,
      })),
      resources: Object.entries(PROJECTS).map(([ref, p]) => ({
        externalId: ref,
        accountExternalId: p.org,
        name: p.name,
        resourceType: "project",
        region: "demo-region-1",
        plan: ORGS[p.org].plan,
        providerStatus: "ACTIVE_HEALTHY",
        status: "active" as const,
        dashboardUrl: null,
      })),
    };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    failIfSimulated(ctx, "collect");
    const now = ctx.now;
    const today = startOfUtcDay(now);
    const result: CollectResult = { observations: [], outcomes: [], quotas: [], costs: [] };
    // Backfill at most 35 days of history.
    const from = new Date(Math.max(startOfUtcDay(target.since).getTime(), today.getTime() - 35 * DAY_MS));

    for (const r of target.resources) {
      const p = PROJECTS[r.externalId];
      if (!p) continue;
      const scope = { resourceExternalId: r.externalId };
      for (let t = from.getTime(); t <= today.getTime(); t += DAY_MS) {
        const day = new Date(t);
        const isToday = t === today.getTime();
        const end = isToday ? now : new Date(t + DAY_MS);
        const fraction = isToday ? (now.getTime() - t) / DAY_MS : 1;
        const cycleStart = cycleStartFor(r.cycle, day);
        const quality = isToday ? ("partial" as const) : ("ok" as const);
        const common = { scope, bucketStart: day, bucketEnd: new Date(t + DAY_MS), observedAt: end, quality, source: "demo" as const };
        const daysAgo = (today.getTime() - t) / DAY_MS;

        result.observations.push(
          { ...common, metricKey: D.databaseSize, value: Math.round(p.db[0] + p.db[1] * (30 - daysAgo) * (0.9 + rand(`${r.externalId}:db:${t}`) * 0.2)) },
          { ...common, metricKey: D.apiRequests, value: Math.round(dailyAmount(r.externalId, D.apiRequests, day, p.apiPerDay) * fraction) },
          { ...common, metricKey: D.invocations, value: Math.round(dailyAmount(r.externalId, D.invocations, day, p.invocationsPerDay) * fraction) },
          { ...common, metricKey: D.mau, value: cycleToDate(r.externalId, D.mau, p.mauPerDay, cycleStart, end) },
          { ...common, metricKey: D.egress, value: cycleToDate(r.externalId, D.egress, p.egressPerDay, cycleStart, end) },
        );
      }
      for (const m of metrics) result.outcomes.push({ metricKey: m.key, scope, status: "ok" });

      if (p.org === "demo-hobby") {
        result.quotas.push({ metricKey: D.databaseSize, scope, limit: 500 * MB, unit: "bytes", overageEffect: "restriction", notes: "Demo: Free projects become read-only above 500 MB." });
      }
    }

    for (const a of target.accounts) {
      const scope = { accountExternalId: a.externalId };
      const free = a.plan === "free";
      const q = (metricKey: string, limit: number, unit: "bytes" | "count"): ProviderQuota => ({
        metricKey,
        scope,
        limit,
        unit,
        overageEffect: free ? "restriction" : "both",
        notes: free ? "Demo Free plan allowance" : "Demo Pro plan allowance; overage billed when spend cap is off",
      });
      result.quotas.push(
        q(D.mau, free ? 50_000 : 100_000, "count"),
        q(D.egress, free ? 5 * GB : 250 * GB, "bytes"),
        q(D.invocations, free ? 500_000 : 2_000_000, "count"),
      );

      if (!free) {
        // Reported spend: base subscription plus overages computed from the generated usage.
        const projects = Object.entries(PROJECTS).filter(([, p]) => p.org === a.externalId);
        const egress = projects.reduce((s, [ref, p]) => s + cycleToDate(ref, D.egress, p.egressPerDay, a.cycle.start, now), 0);
        const overage = Math.max(0, egress - 250 * GB) / GB * 0.09;
        result.costs.push({
          accountExternalId: a.externalId,
          periodStart: a.cycle.start,
          periodEnd: a.cycle.end,
          amount: Math.round((25 + overage) * 100) / 100,
          currency: "USD",
        });
      }
    }
    return result;
  },
};

/** Start of the billing cycle containing `day`, using the same anchor as `cycle`. */
function cycleStartFor(cycle: Cycle, day: Date): Date {
  const anchor = cycle.start.getUTCDate();
  let start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), anchor));
  if (start > day) start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, anchor));
  return start;
}
