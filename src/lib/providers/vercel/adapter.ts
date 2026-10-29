import { GB, MB } from "../../units";
import { startOfUtcDay } from "../../engine/time";
import type { MetricDefinition } from "../../types";
import { dayObservation, emptyResult, isAuthFailure, recordFailure, recordOk, toNumber, utcDays } from "../collect";
import { requestJson, requestText } from "../http";
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

// Verified against vercel.com/docs/rest-api (user, teams, projects, deployments, FOCUS
// billing charges) and vercel.com/pricing on 2026-10-29. The billing service-name mapping
// is confirmed against a live Pro response in the batch 1 live check. Re-verify before changing.

export const VERCEL_API_URL = process.env.VERCEL_API_URL ?? "https://api.vercel.com";

const VERIFIED = "2026-10-29";
const PRICING = "https://vercel.com/pricing";
const HOBBY_DETAIL = "Vercel reports usage through its billing API on Pro and Enterprise teams only.";

export const V = {
  deployments: "vercel.deployments",
  functionInvocations: "vercel.function_invocations",
  dataTransfer: "vercel.data_transfer",
  edgeRequests: "vercel.edge_requests",
  buildMinutes: "vercel.build_minutes",
} as const;

const BILLING_METRICS: string[] = [V.functionInvocations, V.dataTransfer, V.edgeRequests, V.buildMinutes];

const metric = (key: string, name: string, description: string, unit: "count" | "bytes", derivation: "reported" | "derived"): MetricDefinition => ({
  key,
  provider: "vercel",
  name,
  description,
  unit,
  aggregation: "incremental",
  scopeLevel: "resource",
  derivation,
  supported: true,
});

const metrics: MetricDefinition[] = [
  metric(V.deployments, "Deployments", "Deployments created per day, counted from the project's deployment list. Hobby allows 100 a day.", "count", "derived"),
  metric(V.functionInvocations, "Function invocations", "Daily function invocations from Vercel's billing data (Pro and Enterprise).", "count", "reported"),
  metric(V.dataTransfer, "Data transfer", "Daily Fast Data Transfer from Vercel's billing data (Pro and Enterprise).", "bytes", "reported"),
  metric(V.edgeRequests, "Edge requests", "Daily edge (CDN) requests from Vercel's billing data (Pro and Enterprise).", "count", "reported"),
  metric(V.buildMinutes, "Build minutes", "Daily build minutes from Vercel's billing data (Pro and Enterprise).", "count", "reported"),
];

const planAllowances: PlanAllowance[] = [
  {
    plan: "pro",
    metricKey: V.edgeRequests,
    scope: "account",
    limit: 1_000_000,
    overageEffect: "charges",
    note: "Pro's free Flat Rate CDN tier covers 1M edge requests a month; above it Vercel moves you to a paid tier.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  {
    plan: "pro",
    metricKey: V.dataTransfer,
    scope: "account",
    limit: 1024 * GB,
    overageEffect: "charges",
    note: "Pro's free Flat Rate CDN tier includes 1 TB of Fast Data Transfer a month.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
];

const recommendations: Record<string, string> = {
  [V.deployments]: "Batch commits or limit preview deployments to the branches you review (Ignored Build Step).",
  [V.functionInvocations]: "Cache responses (ISR, CDN headers) so repeat requests don't invoke functions, and look for bots or polling clients.",
  [V.dataTransfer]: "Compress and resize assets, and move large downloads to object storage.",
  [V.edgeRequests]: "Bundle small assets and check for bots or aggressive prefetching.",
  [V.buildMinutes]: "Skip builds for unchanged projects in monorepos and cache dependencies between builds.",
};

/** FOCUS ServiceName → metric, matched case-insensitively. Unmatched services count toward cost only. */
const SERVICE_METRICS: { match: RegExp; metricKey: string }[] = [
  { match: /function invocation/i, metricKey: V.functionInvocations },
  { match: /data transfer/i, metricKey: V.dataTransfer },
  { match: /edge request|cdn request/i, metricKey: V.edgeRequests },
  { match: /build minute|build time/i, metricKey: V.buildMinutes },
];

/** Converts a consumed quantity to the metric's unit; null when the unit is not understood. */
function toMetricUnits(metricKey: string, quantity: number, unit: string | null | undefined): number | null {
  const u = (unit ?? "").trim().toLowerCase();
  if (metricKey === V.dataTransfer) {
    if (u === "gb") return quantity * GB;
    if (u === "tb") return quantity * 1024 * GB;
    if (u === "mb") return quantity * MB;
    if (u === "b" || u === "bytes") return quantity;
    return null;
  }
  if (metricKey === V.buildMinutes && (u === "hours" || u === "hour" || u === "h")) return quantity * 60;
  return quantity;
}

interface FocusRow {
  BilledCost?: number | string;
  BillingCurrency?: string;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ConsumedQuantity?: number | string | null;
  ConsumedUnit?: string | null;
  ServiceName?: string;
  Tags?: Record<string, unknown> | string | null;
}

export function parseFocusJsonl(text: string): FocusRow[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as FocusRow;
      } catch {
        throw new ProviderError("invalid_response", "Billing charges are not valid JSONL");
      }
    });
}

function projectIdOf(tags: FocusRow["Tags"]): string | null {
  let t: unknown = tags;
  if (typeof t === "string") {
    try {
      t = JSON.parse(t);
    } catch {
      return null;
    }
  }
  const id = t && typeof t === "object" ? ((t as Record<string, unknown>).ProjectId ?? (t as Record<string, unknown>).projectId) : null;
  return typeof id === "string" ? id : null;
}

const isTeam = (accountExternalId: string | null) => !!accountExternalId && !accountExternalId.startsWith("user:");
const teamQuery = (accountExternalId: string | null): Record<string, string> => (isTeam(accountExternalId) ? { teamId: accountExternalId! } : {});

function client(ctx: AdapterContext) {
  if (ctx.credentials.kind !== "token") throw new ProviderError("auth_invalid", "Vercel connections use an access token");
  const headers = { Authorization: `Bearer ${ctx.credentials.token}` };
  const url = (path: string, query: Record<string, string>) => {
    const qs = new URLSearchParams(query).toString();
    return `${VERCEL_API_URL}${path}${qs ? `?${qs}` : ""}`;
  };
  return {
    get: <T>(path: string, query: Record<string, string> = {}) =>
      requestJson<T>(url(path, query), { headers: { ...headers, Accept: "application/json" }, fetch: ctx.fetch }),
    text: (path: string, query: Record<string, string> = {}) => requestText(url(path, query), { headers, fetch: ctx.fetch, timeoutMs: 60_000 }),
  };
}
type Api = ReturnType<typeof client>;

interface User {
  id: string;
  username: string;
  name?: string | null;
  billing?: { plan?: string } | null;
}
interface Team {
  id: string;
  slug: string;
  name: string;
  billing?: { plan?: string } | null;
}

async function listDeploymentTimes(api: Api, accountExternalId: string | null, projectId: string, sinceMs: number): Promise<number[]> {
  const times: number[] = [];
  let until: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { ...teamQuery(accountExternalId), projectId, since: String(sinceMs), limit: "100" };
    if (until) query.until = until;
    const res = await api.get<{ deployments?: { created?: number }[]; pagination?: { next?: number | null } }>("/v6/deployments", query);
    if (!Array.isArray(res?.deployments)) throw new ProviderError("invalid_response", "Unexpected deployments response");
    for (const d of res.deployments) if (typeof d.created === "number" && d.created >= sinceMs) times.push(d.created);
    const next = res.pagination?.next;
    if (!next) break;
    until = String(next);
  }
  return times;
}

export const vercelAdapter: ProviderAdapter = {
  id: "vercel",
  name: "Vercel",
  authMethods: ["token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Teams and their plans" },
    resourceDiscovery: { level: "supported", note: "Projects" },
    usageMetrics: { level: "partial", note: "Deployments on every plan; invocations, data transfer, edge requests and build minutes on Pro and Enterprise." },
    quotaRetrieval: { level: "unsupported", note: "Plan allowances are suggested from Vercel's pricing page and need your confirmation." },
    actualCost: { level: "partial", note: "Cycle-to-date billed cost on Pro and Enterprise teams." },
    forecastingInputs: { level: "partial", note: "Daily history on Pro and Enterprise; deployments only on Hobby." },
    billingCycleMetadata: { level: "unsupported", note: "Set each team's billing cycle day manually." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes projects, plans or spend management." },
  },
  metrics,
  pricingRules: [],
  planAllowances,
  recommendations,
  tokenConnect: {
    tokenLabel: "Access token",
    createUrl: "https://vercel.com/account/settings/tokens",
    steps: [
      "Open Account Settings → Tokens in the Vercel dashboard and create a token.",
      "Set its scope to the team you want to monitor and choose an expiry.",
      "Copy the token and paste it below.",
    ],
    warning:
      "Vercel tokens can do more than read. Limit Gauge only sends read requests and encrypts the token at rest. Scope it to one team and set an expiry.",
  },

  async validate(ctx) {
    const res = await client(ctx).get<{ user?: User }>("/v2/user");
    if (!res?.user) throw new ProviderError("invalid_response", "Unexpected user response");
    return { identity: res.user.username, grantedScopes: ["access token (can do more than read)"] };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const me = (await api.get<{ user?: User }>("/v2/user"))?.user;
    if (!me) throw new ProviderError("invalid_response", "Unexpected user response");

    const teams: Team[] = [];
    let until: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await api.get<{ teams?: Team[]; pagination?: { next?: number | null } }>("/v2/teams", { limit: "100", ...(until ? { until } : {}) });
      if (!Array.isArray(res?.teams)) throw new ProviderError("invalid_response", "Unexpected teams response");
      teams.push(...res.teams);
      if (!res.pagination?.next) break;
      until = String(res.pagination.next);
    }

    const accounts: DiscoveredAccount[] = [];
    for (const t of teams) {
      let plan = t.billing?.plan ?? null;
      if (!plan) {
        try {
          plan = (await api.get<Team>(`/v2/teams/${encodeURIComponent(t.id)}`))?.billing?.plan ?? null;
        } catch (e) {
          if (isAuthFailure(e)) throw e;
          // The plan is optional metadata; a missing permission must not block discovery.
        }
      }
      accounts.push({
        externalId: t.id,
        name: t.name,
        accountType: "organization",
        plan: plan?.toLowerCase() ?? null,
        billingCurrency: "USD",
        dashboardUrl: `https://vercel.com/${t.slug}`,
      });
    }
    if (!accounts.length) {
      accounts.push({
        externalId: `user:${me.id}`,
        name: me.name ?? me.username,
        accountType: "account",
        plan: me.billing?.plan?.toLowerCase() ?? "hobby",
        billingCurrency: "USD",
        dashboardUrl: `https://vercel.com/${me.username}`,
      });
    }

    const resources: DiscoveredResource[] = [];
    for (const a of accounts) {
      const slug = a.dashboardUrl!.slice("https://vercel.com/".length);
      let from: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await api.get<{ projects?: { id: string; name: string }[]; pagination?: { next?: number | null } }>("/v10/projects", {
          ...teamQuery(a.externalId),
          limit: "100",
          ...(from ? { from } : {}),
        });
        if (!Array.isArray(res?.projects)) throw new ProviderError("invalid_response", "Unexpected projects response");
        for (const p of res.projects) {
          resources.push({
            externalId: p.id,
            accountExternalId: a.externalId,
            name: p.name,
            resourceType: "project",
            region: null,
            plan: null,
            providerStatus: null,
            status: "active",
            dashboardUrl: `https://vercel.com/${slug}/${p.name}`,
          });
        }
        if (!res.pagination?.next) break;
        from = String(res.pagination.next);
      }
    }
    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const result = emptyResult();
    const from = startOfUtcDay(target.since);

    for (const r of target.resources) {
      const scope = { resourceExternalId: r.externalId };
      try {
        const times = await listDeploymentTimes(api, r.accountExternalId, r.externalId, from.getTime());
        const perDay = new Map<number, number>();
        for (const t of times) {
          const day = startOfUtcDay(new Date(t)).getTime();
          perDay.set(day, (perDay.get(day) ?? 0) + 1);
        }
        for (const day of utcDays(from, now)) {
          result.observations.push(dayObservation(V.deployments, scope, day, perDay.get(day.getTime()) ?? 0, now, { source: "derived" }));
        }
        recordOk(result, [V.deployments], [scope]);
      } catch (e) {
        recordFailure(result, [V.deployments], [scope], e);
      }
    }

    for (const account of target.accounts) {
      const resources = target.resources.filter((r) => r.accountExternalId === account.externalId);
      if (!resources.length) continue;
      const scopes = resources.map((r) => ({ resourceExternalId: r.externalId }));

      if (!isTeam(account.externalId) || account.plan === "hobby") {
        for (const scope of scopes) {
          for (const metricKey of BILLING_METRICS) result.outcomes.push({ metricKey, scope, status: "unsupported", detail: HOBBY_DETAIL });
        }
        continue;
      }

      try {
        const start = new Date(Math.min(from.getTime(), account.cycle.start.getTime()));
        const rows = parseFocusJsonl(
          await api.text("/v1/billing/charges", { teamId: account.externalId, from: start.toISOString(), to: now.toISOString() }),
        );
        const monitored = new Set(resources.map((r) => r.externalId));
        const usage = new Map<string, number>(); // metric|project|dayMs → value
        let cycleCost = 0;
        let currency = "USD";
        for (const row of rows) {
          const periodStart = row.ChargePeriodStart ? new Date(row.ChargePeriodStart) : null;
          if (!periodStart || Number.isNaN(periodStart.getTime())) continue;
          if (row.BillingCurrency) currency = row.BillingCurrency;
          if (periodStart >= account.cycle.start && periodStart < account.cycle.end) cycleCost += toNumber(row.BilledCost) ?? 0;
          if (row.ChargeCategory !== "Usage" || periodStart < from) continue;
          const metricKey = SERVICE_METRICS.find((s) => s.match.test(row.ServiceName ?? ""))?.metricKey;
          const project = projectIdOf(row.Tags);
          if (!metricKey || !project || !monitored.has(project)) continue;
          const value = toMetricUnits(metricKey, toNumber(row.ConsumedQuantity) ?? 0, row.ConsumedUnit);
          if (value === null) continue;
          const key = `${metricKey}|${project}|${startOfUtcDay(periodStart).getTime()}`;
          usage.set(key, (usage.get(key) ?? 0) + value);
        }
        for (const [key, value] of usage) {
          const [metricKey, project, day] = key.split("|");
          result.observations.push(dayObservation(metricKey, { resourceExternalId: project }, new Date(Number(day)), value, now));
        }
        result.costs.push({
          accountExternalId: account.externalId,
          periodStart: account.cycle.start,
          periodEnd: account.cycle.end,
          amount: Math.round(cycleCost * 100) / 100,
          currency,
        });
        recordOk(result, BILLING_METRICS, scopes);
      } catch (e) {
        recordFailure(result, BILLING_METRICS, scopes, e);
      }
    }
    return result;
  },
};
