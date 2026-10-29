import { GB } from "../../units";
import type { MetricDefinition } from "../../types";
import { dayObservation, emptyResult, recordFailure, recordOk, toNumber } from "../collect";
import { requestJson } from "../http";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type DiscoveredAccount,
  type DiscoveredResource,
  type Discovery,
  type PlanAllowance,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Verified against the Neon API reference (neon.com/docs/reference/api) and
// neon.com/pricing on 2026-10-29. Re-verify before changing.

export const NEON_API_URL = process.env.NEON_API_URL ?? "https://console.neon.tech/api/v2";

const VERIFIED = "2026-10-29";
const PRICING = "https://neon.com/pricing";
const PAGE = 100;

export const N = {
  computeHours: "neon.compute_hours",
  storage: "neon.storage",
  dataWritten: "neon.data_written",
  dataTransfer: "neon.data_transfer",
} as const;

const metrics: MetricDefinition[] = [
  {
    key: N.computeHours,
    provider: "neon",
    name: "Compute hours",
    description: "CU-hours used by the project's computes in the current consumption period (compute_time_seconds ÷ 3600).",
    unit: "count",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "derived",
    supported: true,
  },
  {
    key: N.storage,
    provider: "neon",
    name: "Storage",
    description:
      "Project storage including history (synthetic_storage_size). Neon bills the hourly average (GB-months), so the current size approximates billed storage.",
    unit: "bytes",
    aggregation: "gauge",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: N.dataWritten,
    provider: "neon",
    name: "Data written",
    description: "Data written to the project's storage in the current consumption period.",
    unit: "bytes",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: N.dataTransfer,
    provider: "neon",
    name: "Data transfer",
    description: "Public network transfer (egress) in the current consumption period.",
    unit: "bytes",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
];

const planAllowances: PlanAllowance[] = [
  {
    plan: "free",
    metricKey: N.computeHours,
    scope: "resource",
    limit: 100,
    overageEffect: "restriction",
    note: "Free plan includes 100 CU-hours per project each month; computes are suspended beyond that.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  {
    plan: "free",
    metricKey: N.storage,
    scope: "resource",
    limit: 1 * GB,
    overageEffect: "restriction",
    note: "Free plan includes 1 GB of storage per project (20 GB across the account).",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  {
    plan: "free",
    metricKey: N.dataTransfer,
    scope: "resource",
    limit: 5 * GB,
    overageEffect: "restriction",
    note: "Free plan includes 5 GB of public network transfer per project.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  ...["launch", "scale"].map(
    (plan): PlanAllowance => ({
      plan,
      metricKey: N.dataTransfer,
      scope: "resource",
      limit: 500 * GB,
      overageEffect: "charges",
      note: "500 GB of public network transfer included per project, then $0.10 per GB.",
      sourceUrl: PRICING,
      verifiedAt: VERIFIED,
    }),
  ),
];

const recommendations: Record<string, string> = {
  [N.computeHours]:
    "Check which branches keep computes awake (open connections, cron jobs, polling). Lower the autoscaling maximum or let computes scale to zero sooner.",
  [N.storage]: "Delete unused branches and data, and shorten the history (restore) window if you don't need it.",
  [N.dataWritten]: "Look for write-heavy jobs such as bulk imports, frequent upserts or logging tables.",
  [N.dataTransfer]: "Cache query results closer to users and avoid fetching large result sets you don't use.",
};

interface Org {
  id: string;
  name: string;
  plan?: string;
}
interface ProjectSummary {
  id: string;
  name: string;
  region_id?: string;
}
type ProjectDetail = Record<string, unknown> & { id: string; consumption_period_start?: string };

/** Neon subscription types carry version suffixes ("free_v3"); keep only the plan family. */
export function normalizeNeonPlan(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const p = plan.toLowerCase();
  for (const family of ["free", "launch", "scale", "business", "enterprise"]) if (p.startsWith(family)) return family;
  return p;
}

function client(ctx: AdapterContext) {
  if (ctx.credentials.kind !== "token") throw new ProviderError("auth_invalid", "Neon connections use an API key");
  const headers = { Authorization: `Bearer ${ctx.credentials.token}`, Accept: "application/json" };
  return { get: <T>(path: string) => requestJson<T>(`${NEON_API_URL}${path}`, { headers, fetch: ctx.fetch }) };
}

export const neonAdapter: ProviderAdapter = {
  id: "neon",
  name: "Neon",
  authMethods: ["token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Organizations and their plans" },
    resourceDiscovery: { level: "supported", note: "Projects and regions" },
    usageMetrics: { level: "supported", note: "Compute hours, storage, data written and data transfer per project." },
    quotaRetrieval: { level: "unsupported", note: "Plan allowances are suggested from Neon's pricing page and need your confirmation." },
    actualCost: { level: "unsupported", note: "The Neon API has no billing endpoint." },
    forecastingInputs: { level: "supported", note: "A snapshot is stored on every sync." },
    billingCycleMetadata: { level: "partial", note: "Each project reports its consumption period; set the organization's cycle day to match." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes plans or computes." },
  },
  metrics,
  pricingRules: [],
  planAllowances,
  recommendations,
  tokenConnect: {
    tokenLabel: "API key",
    placeholder: "napi_…",
    createUrl: "https://console.neon.tech/app/settings/api-keys",
    steps: [
      "Open Account settings → API keys in the Neon Console (or ask a teammate with the Viewer role to do it).",
      "Create a personal API key and copy it.",
      "Paste it below. Limit Gauge discovers every organization and project the key can see.",
    ],
    warning:
      "Neon API keys are not read-only. A personal key from a member with the Viewer role can only read. Limit Gauge only sends read requests and encrypts the key at rest.",
  },

  async validate(ctx) {
    const me = await client(ctx).get<{ email?: string; name?: string }>("/users/me");
    if (!me) throw new ProviderError("invalid_response", "Unexpected user response");
    return { identity: me.email ?? me.name ?? "Neon account", grantedScopes: ["API key (Neon keys are not read-only)"] };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const res = await api.get<{ organizations?: Org[] }>("/users/me/organizations");
    const orgs = res?.organizations;
    if (!Array.isArray(orgs)) throw new ProviderError("invalid_response", "Unexpected organizations response");

    const accounts: DiscoveredAccount[] = [];
    const resources: DiscoveredResource[] = [];
    for (const org of orgs) {
      accounts.push({
        externalId: org.id,
        name: org.name,
        accountType: "organization",
        plan: normalizeNeonPlan(org.plan),
        billingCurrency: "USD",
        dashboardUrl: `https://console.neon.tech/app/${org.id}/projects`,
      });
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ org_id: org.id, limit: String(PAGE) });
        if (cursor) qs.set("cursor", cursor);
        const r = await api.get<{ projects?: ProjectSummary[]; pagination?: { cursor?: string } }>(`/projects?${qs}`);
        const projects = r?.projects;
        if (!Array.isArray(projects)) throw new ProviderError("invalid_response", "Unexpected projects response");
        for (const p of projects) {
          resources.push({
            externalId: p.id,
            accountExternalId: org.id,
            name: p.name,
            resourceType: "project",
            region: p.region_id ?? null,
            plan: null,
            providerStatus: null,
            status: "active",
            dashboardUrl: `https://console.neon.tech/app/projects/${p.id}`,
          });
        }
        const next = r?.pagination?.cursor;
        if (projects.length < PAGE || !next || next === cursor) break;
        cursor = next;
      }
    }
    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const result = emptyResult();

    for (const r of target.resources) {
      const scope = { resourceExternalId: r.externalId };
      try {
        const res = await api.get<{ project?: ProjectDetail }>(`/projects/${encodeURIComponent(r.externalId)}`);
        const p = res?.project;
        if (!p) throw new ProviderError("invalid_response", "Unexpected project response");
        const periodStart = p.consumption_period_start ? Date.parse(p.consumption_period_start) : NaN;
        const dimensions = Number.isFinite(periodStart) ? { consumption_period_start: periodStart } : undefined;

        const read = (field: string, metricKey: string, toValue: (v: number) => number, source: "provider" | "derived" = "provider") => {
          const v = toNumber(p[field]);
          if (v === null || v < 0) {
            recordFailure(result, [metricKey], [scope], new ProviderError("invalid_response", `Project response is missing ${field}`));
            return;
          }
          result.observations.push(dayObservation(metricKey, scope, now, toValue(v), now, { quality: "ok", source, dimensions }));
          recordOk(result, [metricKey], [scope]);
        };
        read("compute_time_seconds", N.computeHours, (v) => Math.round((v / 3600) * 100) / 100, "derived");
        read("synthetic_storage_size", N.storage, (v) => v);
        read("written_data_bytes", N.dataWritten, (v) => v);
        read("data_transfer_bytes", N.dataTransfer, (v) => v);
      } catch (e) {
        recordFailure(result, metrics.map((m) => m.key), [scope], e);
      }
    }
    return result;
  },
};
