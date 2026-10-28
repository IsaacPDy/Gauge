import { GB, MB } from "../../units";
import { DAY_MS, startOfUtcDay } from "../../engine/time";
import type { MetricDefinition, PricingRule } from "../../types";
import { requestJson } from "../http";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type Discovery,
  type MetricOutcome,
  type Observation,
  type PlanAllowance,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Verified against the Supabase Management API OpenAPI spec (api.supabase.com/api/v1-json)
// and the "Manage your usage" docs on 2026-10-09. Re-verify before changing.

export const SUPABASE_API_URL = process.env.SUPABASE_MANAGEMENT_API_URL ?? "https://api.supabase.com";

/** OAuth scopes needed for monitoring. All read-only. */
export const SUPABASE_SCOPES = ["organizations:read", "projects:read", "analytics:read", "database:read", "edge_functions:read"];

const VERIFIED = "2026-10-09";
const DOCS = "https://supabase.com/docs/guides/platform/manage-your-usage";

export const M = {
  databaseSize: "supabase.database_size",
  diskUsage: "supabase.disk_usage",
  storageSize: "supabase.storage_size",
  mau: "supabase.monthly_active_users",
  apiRequests: "supabase.api_requests",
  functionCount: "supabase.edge_function_count",
  egress: "supabase.egress",
  functionInvocations: "supabase.edge_function_invocations",
} as const;

const metrics: MetricDefinition[] = [
  {
    key: M.databaseSize,
    provider: "supabase",
    name: "Database size",
    description: "Size of the project's Postgres database (pg_database_size), read through the read-only SQL endpoint.",
    unit: "bytes",
    aggregation: "gauge",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: M.diskUsage,
    provider: "supabase",
    name: "Disk usage",
    description: "Used bytes on the project's database disk, as reported by the disk utilization endpoint.",
    unit: "bytes",
    aggregation: "gauge",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: M.storageSize,
    provider: "supabase",
    name: "Storage size",
    description:
      "Total size of objects in Supabase Storage, summed from storage.objects. Supabase bills the cycle's average (GB-hours), so this current size is an approximation of billed usage.",
    unit: "bytes",
    aggregation: "gauge",
    scopeLevel: "resource",
    derivation: "derived",
    supported: true,
  },
  {
    key: M.mau,
    provider: "supabase",
    name: "Monthly active users",
    description:
      "Users whose last sign-in falls in the current billing cycle. Supabase also counts token refreshes, so this undercounts billed MAU.",
    unit: "count",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "estimated",
    supported: true,
  },
  {
    key: M.apiRequests,
    provider: "supabase",
    name: "API requests",
    description: "Daily REST, Auth, Storage and Realtime requests from the project's usage analytics.",
    unit: "count",
    aggregation: "incremental",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: M.functionCount,
    provider: "supabase",
    name: "Edge Functions deployed",
    description: "Number of deployed Edge Functions, compared with the organization's function entitlement.",
    unit: "count",
    aggregation: "gauge",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: M.egress,
    provider: "supabase",
    name: "Egress",
    description: "Unified egress across services.",
    unit: "bytes",
    aggregation: "cumulative",
    scopeLevel: "account",
    derivation: "reported",
    supported: false,
    unsupportedReason:
      "The Supabase Management API does not expose egress usage. Check the organization's usage page in the Supabase dashboard.",
  },
  {
    key: M.functionInvocations,
    provider: "supabase",
    name: "Edge Function invocations",
    description: "Edge Function invocations per billing cycle.",
    unit: "count",
    aggregation: "incremental",
    scopeLevel: "account",
    derivation: "reported",
    supported: false,
    unsupportedReason:
      "The function statistics endpoint has no documented response schema, so Limit Gauge does not use it for quota alerts yet.",
  },
];

const pricingRules: PricingRule[] = ["pro", "team"].flatMap((plan) => [
  {
    id: `supabase.${plan}.monthly_active_users@2026-10`,
    provider: "supabase" as const,
    metricKey: M.mau,
    plan,
    version: "2026-10",
    currency: "USD",
    includedQuantity: 100_000,
    unitPrice: 0.00325,
    unitSize: 1,
    billingMode: "per_unit" as const,
    sourceUrl: `${DOCS}/monthly-active-users`,
    verifiedAt: VERIFIED,
    notes: "Charged only when Spend Cap is disabled (or on Team). MAU here is an estimate.",
  },
  {
    id: `supabase.${plan}.storage_size@2026-10`,
    provider: "supabase" as const,
    metricKey: M.storageSize,
    plan,
    version: "2026-10",
    currency: "USD",
    includedQuantity: 100 * GB,
    unitPrice: 0.0213,
    unitSize: GB,
    billingMode: "per_unit" as const,
    sourceUrl: `${DOCS}/storage-size`,
    verifiedAt: VERIFIED,
    notes: "Supabase bills the cycle average (GB-hours); this estimate uses the current size. Charged only when Spend Cap is disabled.",
  },
]);

const planAllowances: PlanAllowance[] = [
  {
    plan: "free",
    metricKey: M.databaseSize,
    scope: "resource",
    limit: 500 * MB,
    overageEffect: "restriction",
    note: "Free projects enter read-only mode when the database exceeds 500 MB.",
    sourceUrl: "https://supabase.com/docs/guides/platform/database-size",
    verifiedAt: VERIFIED,
  },
  {
    plan: "free",
    metricKey: M.storageSize,
    scope: "account",
    limit: 1 * GB,
    overageEffect: "restriction",
    note: "Free plan includes 1 GB of storage per organization.",
    sourceUrl: `${DOCS}/storage-size`,
    verifiedAt: VERIFIED,
  },
  {
    plan: "free",
    metricKey: M.mau,
    scope: "account",
    limit: 50_000,
    overageEffect: "restriction",
    note: "Free plan includes 50,000 MAU per organization; overages lead to a grace period and restrictions.",
    sourceUrl: `${DOCS}/monthly-active-users`,
    verifiedAt: VERIFIED,
  },
  ...["pro", "team"].flatMap((plan): PlanAllowance[] => [
    {
      plan,
      metricKey: M.storageSize,
      scope: "account",
      limit: 100 * GB,
      overageEffect: "both",
      note: "100 GB included per organization. Billed beyond that with Spend Cap off; restricted with Spend Cap on.",
      sourceUrl: `${DOCS}/storage-size`,
      verifiedAt: VERIFIED,
    },
    {
      plan,
      metricKey: M.mau,
      scope: "account",
      limit: 100_000,
      overageEffect: "both",
      note: "100,000 MAU included per organization. Billed beyond that with Spend Cap off; restricted with Spend Cap on.",
      sourceUrl: `${DOCS}/monthly-active-users`,
      verifiedAt: VERIFIED,
    },
  ]),
];

const recommendations: Record<string, string> = {
  [M.databaseSize]:
    "Review the largest tables and indexes, delete unused data and run VACUUM. On the Free plan, upgrade before the project becomes read-only.",
  [M.diskUsage]:
    "Check database growth and WAL/backup usage. Paid plans auto-expand the disk (billed beyond 8 GB per project); consider cleaning up data first.",
  [M.storageSize]: "Remove unused objects or move large files elsewhere; storage is billed on the cycle's average size.",
  [M.mau]:
    "Review sign-up sources for abuse and confirm whether the growth is expected. Consider upgrading or enabling Spend Cap to avoid surprise charges.",
  [M.apiRequests]: "Look for polling loops or bots in the project's API logs and add caching where possible.",
  [M.functionCount]: "Remove unused Edge Functions or consolidate them before reaching the plan's limit.",
};

// ---------------------------------------------------------------------------

interface Org {
  id: string;
  slug?: string;
  name: string;
}
interface Project {
  ref?: string;
  id?: string;
  organization_slug?: string;
  organization_id?: string;
  name: string;
  region?: string;
  status?: string;
}
interface Entitlements {
  entitlements?: { feature?: { key?: string }; hasAccess?: boolean; config?: { value?: number; unlimited?: boolean } }[];
}

const UNAVAILABLE_STATUSES = new Set(["INACTIVE", "PAUSING", "REMOVED", "INIT_FAILED", "RESTORE_FAILED", "GOING_DOWN", "PAUSE_FAILED"]);

function tokenOf(ctx: AdapterContext): string {
  const c = ctx.credentials;
  if (c.kind === "token") return c.token;
  if (c.kind === "oauth") return c.accessToken;
  throw new ProviderError("auth_invalid", "Supabase connection has no usable credentials");
}

function client(ctx: AdapterContext) {
  const headers = { Authorization: `Bearer ${tokenOf(ctx)}`, Accept: "application/json" };
  return {
    get: <T>(path: string) => requestJson<T>(`${SUPABASE_API_URL}${path}`, { headers, fetch: ctx.fetch }),
    post: <T>(path: string, body: unknown) =>
      requestJson<T>(`${SUPABASE_API_URL}${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        fetch: ctx.fetch,
      }),
  };
}

const slugOf = (o: Org) => o.slug ?? o.id;
const refOf = (p: Project) => p.ref ?? p.id ?? "";

/** Parse provider timestamps; strings without a zone are UTC. */
function parseTs(ts: unknown): Date | null {
  if (typeof ts === "number") return new Date(ts > 1e14 ? ts / 1000 : ts);
  if (typeof ts !== "string") return null;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstNumber(rows: unknown, field: string): number {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const v = row && typeof row === "object" ? (row as Record<string, unknown>)[field] : undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new ProviderError("invalid_response", `Query result is missing "${field}"`);
  }
  return n;
}

export const supabaseAdapter: ProviderAdapter = {
  id: "supabase",
  name: "Supabase",
  authMethods: ["oauth", "token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Organizations and their plans" },
    resourceDiscovery: { level: "supported", note: "Projects, region and status" },
    usageMetrics: {
      level: "partial",
      note: "Database size, disk usage, storage size, MAU estimate, API requests and Edge Function count. Egress and invocations are not exposed by the API.",
    },
    quotaRetrieval: {
      level: "partial",
      note: "Provisioned disk size and Edge Function entitlements are read from the API. Plan allowances are suggested from Supabase's docs and need your confirmation.",
    },
    actualCost: { level: "unsupported", note: "The Management API has no billing endpoint." },
    forecastingInputs: { level: "supported", note: "Daily history is stored on every sync." },
    billingCycleMetadata: { level: "unsupported", note: "Set each organization's billing cycle day manually." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes Spend Cap or plans." },
  },
  metrics,
  pricingRules,
  planAllowances,
  recommendations,

  async validate(ctx) {
    const orgs = await client(ctx).get<Org[]>("/v1/organizations");
    if (!Array.isArray(orgs)) throw new ProviderError("invalid_response", "Unexpected organizations response");
    const scopes = ctx.credentials.kind === "oauth" ? SUPABASE_SCOPES : ["personal access token (full account access)"];
    return { identity: `${orgs.length} organization${orgs.length === 1 ? "" : "s"}`, grantedScopes: scopes };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const orgs = await api.get<Org[]>("/v1/organizations");
    const projects = await api.get<Project[]>("/v1/projects");
    if (!Array.isArray(orgs) || !Array.isArray(projects)) {
      throw new ProviderError("invalid_response", "Unexpected discovery response");
    }

    const accounts = [];
    for (const o of orgs) {
      const slug = slugOf(o);
      let plan: string | null = null;
      try {
        plan = (await api.get<{ plan?: string }>(`/v1/organizations/${encodeURIComponent(slug)}`))?.plan ?? null;
      } catch (e) {
        if (e instanceof ProviderError && e.code === "auth_invalid") throw e;
        // Plan is optional metadata; missing permission must not block discovery.
      }
      accounts.push({
        externalId: slug,
        name: o.name,
        accountType: "organization" as const,
        plan,
        billingCurrency: "USD",
        dashboardUrl: `https://supabase.com/dashboard/org/${slug}/usage`,
      });
    }

    const resources = projects
      .filter((p) => refOf(p))
      .map((p) => ({
        externalId: refOf(p),
        accountExternalId: p.organization_slug ?? p.organization_id ?? null,
        name: p.name,
        resourceType: "project",
        region: p.region ?? null,
        plan: null,
        providerStatus: p.status ?? null,
        status: p.status === "REMOVED" ? ("deleted" as const) : ("active" as const),
        dashboardUrl: `https://supabase.com/dashboard/project/${refOf(p)}`,
      }));

    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const today = startOfUtcDay(now);
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const result: CollectResult = { observations: [], outcomes: [], quotas: [], costs: [] };

    // Run one metric; connection-level auth failures abort the whole run.
    const attempt = async (metricKey: string, ref: string, fn: () => Promise<void>) => {
      try {
        await fn();
        result.outcomes.push({ metricKey, scope: { resourceExternalId: ref }, status: "ok" });
      } catch (e) {
        if (e instanceof ProviderError && (e.code === "auth_invalid" || e.code === "auth_expired")) throw e;
        const err = e instanceof ProviderError ? e : new ProviderError("unknown", (e as Error).message);
        result.outcomes.push({
          metricKey,
          scope: { resourceExternalId: ref },
          status: "error",
          errorCode: err.code,
          detail: err.message,
        });
      }
    };

    const gauge = (metricKey: string, ref: string, value: number, observedAt: Date, source: Observation["source"] = "provider"): Observation => ({
      metricKey,
      scope: { resourceExternalId: ref },
      bucketStart: today,
      bucketEnd: tomorrow,
      value,
      observedAt,
      quality: source === "estimated" ? "estimated" : "ok",
      source,
    });

    for (const r of target.resources) {
      const ref = r.externalId;
      if (r.providerStatus && UNAVAILABLE_STATUSES.has(r.providerStatus)) {
        for (const m of metrics.filter((x) => x.supported)) {
          result.outcomes.push({
            metricKey: m.key,
            scope: { resourceExternalId: ref },
            status: "unavailable",
            detail: `Project status is ${r.providerStatus}; usage cannot be read.`,
          });
        }
        continue;
      }
      const sql = (query: string) => api.post<unknown>(`/v1/projects/${ref}/database/query/read-only`, { query });

      await attempt(M.databaseSize, ref, async () => {
        const rows = await sql("select pg_database_size(current_database())::bigint as database_size");
        result.observations.push(gauge(M.databaseSize, ref, firstNumber(rows, "database_size"), now));
      });

      await attempt(M.storageSize, ref, async () => {
        const rows = await sql(
          "select coalesce(sum((metadata->>'size')::bigint), 0)::bigint as storage_size from storage.objects",
        );
        result.observations.push(gauge(M.storageSize, ref, firstNumber(rows, "storage_size"), now, "derived"));
      });

      await attempt(M.mau, ref, async () => {
        // Cycle start comes from our own clock, not user input, so inlining is safe.
        const since = r.cycle.start.toISOString();
        const rows = await sql(
          `select count(*)::bigint as mau from auth.users where last_sign_in_at >= '${since}'::timestamptz`,
        );
        result.observations.push(gauge(M.mau, ref, firstNumber(rows, "mau"), now, "estimated"));
      });

      await attempt(M.diskUsage, ref, async () => {
        const util = await api.get<{ timestamp?: string; metrics?: { fs_used_bytes?: number; fs_size_bytes?: number } }>(
          `/v1/projects/${ref}/config/disk/util`,
        );
        const used = util?.metrics?.fs_used_bytes;
        if (typeof used !== "number") throw new ProviderError("invalid_response", "Disk utilization missing fs_used_bytes");
        result.observations.push(gauge(M.diskUsage, ref, used, parseTs(util?.timestamp) ?? now));
        const size = util?.metrics?.fs_size_bytes;
        if (typeof size === "number" && size > 0) {
          result.quotas.push({
            metricKey: M.diskUsage,
            scope: { resourceExternalId: ref },
            limit: size,
            unit: "bytes",
            overageEffect: "both",
            notes: "Provisioned disk size reported by Supabase. Paid plans auto-expand (billed beyond 8 GB); Free projects can become read-only.",
          });
        }
      });

      await attempt(M.apiRequests, ref, async () => {
        const res = await api.get<{ result?: Record<string, unknown>[]; error?: unknown }>(
          `/v1/projects/${ref}/analytics/endpoints/usage.api-counts?interval=7day`,
        );
        if (res?.error) throw new ProviderError("provider_unavailable", "Usage analytics returned an error");
        const rows = Array.isArray(res?.result) ? res.result : [];
        const days = new Map<string, { rest: number; auth: number; storage: number; realtime: number }>();
        for (const row of rows) {
          const ts = parseTs(row.timestamp);
          if (!ts) continue;
          const key = startOfUtcDay(ts).toISOString();
          const d = days.get(key) ?? { rest: 0, auth: 0, storage: 0, realtime: 0 };
          d.rest += Number(row.total_rest_requests) || 0;
          d.auth += Number(row.total_auth_requests) || 0;
          d.storage += Number(row.total_storage_requests) || 0;
          d.realtime += Number(row.total_realtime_requests) || 0;
          days.set(key, d);
        }
        // The oldest day may be cut off by the 7-day window; skip it so a complete value
        // collected earlier is never overwritten by a partial one.
        const keys = [...days.keys()].sort().slice(1);
        for (const key of keys) {
          const start = new Date(key);
          if (start < target.since) continue;
          const d = days.get(key)!;
          result.observations.push({
            metricKey: M.apiRequests,
            scope: { resourceExternalId: ref },
            bucketStart: start,
            bucketEnd: new Date(start.getTime() + DAY_MS),
            value: d.rest + d.auth + d.storage + d.realtime,
            observedAt: now,
            quality: start.getTime() === today.getTime() ? "partial" : "ok",
            source: "provider",
            dimensions: d,
          });
        }
      });

      await attempt(M.functionCount, ref, async () => {
        const fns = await api.get<unknown[]>(`/v1/projects/${ref}/functions`);
        if (!Array.isArray(fns)) throw new ProviderError("invalid_response", "Unexpected functions response");
        result.observations.push(gauge(M.functionCount, ref, fns.length, now));
      });

      for (const m of metrics.filter((x) => !x.supported)) {
        result.outcomes.push({ metricKey: m.key, scope: { resourceExternalId: ref }, status: "unsupported", detail: m.unsupportedReason });
      }
    }

    // Edge Function entitlement per organization, applied to each monitored project in it.
    const readable = target.resources.filter((r) => !(r.providerStatus && UNAVAILABLE_STATUSES.has(r.providerStatus)));
    const orgsWithResources = new Set(readable.map((r) => r.accountExternalId).filter(Boolean) as string[]);
    for (const slug of orgsWithResources) {
      try {
        const ent = await api.get<Entitlements>(`/v1/organizations/${encodeURIComponent(slug)}/entitlements`);
        const fn = ent?.entitlements?.find((e) => e.feature?.key === "function.max_count");
        const value = fn?.config?.value;
        if (fn?.hasAccess && typeof value === "number" && !fn.config?.unlimited) {
          for (const r of readable.filter((x) => x.accountExternalId === slug)) {
            result.quotas.push({
              metricKey: M.functionCount,
              scope: { resourceExternalId: r.externalId },
              limit: value,
              unit: "count",
              overageEffect: "restriction",
              notes: "Edge Function limit from the organization's entitlements.",
            });
          }
        }
      } catch (e) {
        if (e instanceof ProviderError && (e.code === "auth_invalid" || e.code === "auth_expired")) throw e;
        const outcome: MetricOutcome = {
          metricKey: M.functionCount,
          scope: { accountExternalId: slug },
          status: "error",
          errorCode: e instanceof ProviderError ? e.code : "unknown",
          detail: `Could not read entitlements: ${(e as Error).message}`,
        };
        result.outcomes.push(outcome);
      }
    }

    return result;
  },
};
