import { DAY_MS, dayKey, startOfUtcDay } from "../../engine/time";
import type { MetricDefinition } from "../../types";
import { dayObservation, emptyResult, isAuthFailure, recordFailure, recordOk, toNumber, utcDays } from "../collect";
import { requestJson } from "../http";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type DiscoveredAccount,
  type DiscoveredResource,
  type Discovery,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Verified against developers.cloudflare.com (GraphQL Analytics API, Workers, R2 and D1
// metrics docs, R2 pricing) on 2026-10-29. Dataset field names are confirmed against a
// live account in the batch 1 live check. Re-verify before changing.

export const CLOUDFLARE_API_URL = process.env.CLOUDFLARE_API_URL ?? "https://api.cloudflare.com/client/v4";

/** Adaptive datasets answer at most 30 days per query on every plan. */
const MAX_DAYS = 30;

export const C = {
  workersRequests: "cloudflare.workers_requests",
  workersCpuTime: "cloudflare.workers_cpu_time",
  r2ClassA: "cloudflare.r2_class_a_ops",
  r2ClassB: "cloudflare.r2_class_b_ops",
  r2Storage: "cloudflare.r2_storage",
  d1RowsRead: "cloudflare.d1_rows_read",
  d1RowsWritten: "cloudflare.d1_rows_written",
  d1Storage: "cloudflare.d1_storage",
} as const;

const metric = (key: string, name: string, description: string, unit: "count" | "bytes", aggregation: "incremental" | "gauge"): MetricDefinition => ({
  key,
  provider: "cloudflare",
  name,
  description,
  unit,
  aggregation,
  scopeLevel: "resource",
  derivation: "reported",
  supported: true,
});

const metrics: MetricDefinition[] = [
  metric(C.workersRequests, "Workers requests", "Daily requests to the Worker. The Free plan allows 100,000 requests a day across the account.", "count", "incremental"),
  metric(C.workersCpuTime, "Workers CPU time (ms)", "Daily CPU time used by the Worker, in milliseconds.", "count", "incremental"),
  metric(C.r2ClassA, "R2 Class A operations", "Daily writes and lists (PutObject, ListObjects, multipart uploads and similar).", "count", "incremental"),
  metric(C.r2ClassB, "R2 Class B operations", "Daily reads (GetObject, HeadObject and similar).", "count", "incremental"),
  metric(C.r2Storage, "R2 storage", "Stored object and metadata size. R2 bills the monthly average (GB-months).", "bytes", "gauge"),
  metric(C.d1RowsRead, "D1 rows read", "Daily rows read by queries against the database.", "count", "incremental"),
  metric(C.d1RowsWritten, "D1 rows written", "Daily rows written by queries against the database.", "count", "incremental"),
  metric(C.d1Storage, "D1 storage", "Database size.", "bytes", "gauge"),
];

const recommendations: Record<string, string> = {
  [C.workersRequests]: "Look for bots or retry loops in the Worker's analytics and cache responses at the edge where you can.",
  [C.workersCpuTime]: "Profile the Worker for expensive work per request (parsing, crypto, large JSON) and cache results.",
  [C.r2ClassA]: "Batch writes and avoid listing buckets on hot paths.",
  [C.r2ClassB]: "Put a cache in front of frequently read objects so repeat reads don't reach R2.",
  [C.r2Storage]: "Delete unused objects or add lifecycle rules to expire old ones.",
  [C.d1RowsRead]: "Add indexes for frequent queries; full table scans count every row read.",
  [C.d1RowsWritten]: "Batch writes and avoid rewriting unchanged rows.",
  [C.d1Storage]: "Delete old rows or archive them elsewhere.",
};

/** R2 operation classes from developers.cloudflare.com/r2/pricing. Anything else is free. */
const R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts",
  "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

type Kind = "worker" | "r2" | "d1";
const RESOURCE_TYPE: Record<Kind, string> = { worker: "worker", r2: "r2_bucket", d1: "d1_database" };

const resourceId = (accountId: string, kind: Kind, name: string) => `${accountId}:${kind}:${name}`;
function parseResourceId(id: string): { accountId: string; kind: Kind; name: string } | null {
  const [accountId, kind, ...rest] = id.split(":");
  if (!accountId || !(kind in RESOURCE_TYPE) || !rest.length) return null;
  return { accountId, kind: kind as Kind, name: rest.join(":") };
}

interface Envelope<T> {
  success?: boolean;
  result?: T;
  result_info?: { page?: number; total_pages?: number };
}
type GqlRow = { dimensions?: Record<string, string>; sum?: Record<string, unknown>; max?: Record<string, unknown> };

function client(ctx: AdapterContext) {
  if (ctx.credentials.kind !== "token") throw new ProviderError("auth_invalid", "Cloudflare connections use an API token");
  const headers = { Authorization: `Bearer ${ctx.credentials.token}`, Accept: "application/json" };
  return {
    get: <T>(path: string) => requestJson<Envelope<T>>(`${CLOUDFLARE_API_URL}${path}`, { headers, fetch: ctx.fetch }),
    async gql(query: string, variables: Record<string, string>): Promise<GqlRow[]> {
      const res = await requestJson<{ data?: { viewer?: { accounts?: { rows?: GqlRow[] }[] } } | null; errors?: { message?: string }[] | null }>(
        `${CLOUDFLARE_API_URL}/graphql`,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), fetch: ctx.fetch },
      );
      if (res?.errors?.length) {
        const message = res.errors.map((e) => e.message ?? "").join("; ");
        // GraphQL answers 200 even for authorization failures.
        if (/not authori[sz]ed|permission|access denied|forbidden/i.test(message)) throw new ProviderError("permission_denied", message);
        throw new ProviderError("invalid_response", message || "GraphQL query failed");
      }
      const rows = res?.data?.viewer?.accounts?.[0]?.rows;
      if (!Array.isArray(rows)) throw new ProviderError("invalid_response", "GraphQL response has no rows");
      return rows;
    },
  };
}
type Api = ReturnType<typeof client>;

/** Lists a paginated v4 collection (page/per_page with result_info.total_pages). */
async function pagedList<T>(api: Api, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const env = await api.get<T[]>(`${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`);
    if (!Array.isArray(env?.result)) throw new ProviderError("invalid_response", `Unexpected response from ${path}`);
    out.push(...env.result);
    if (page >= (env.result_info?.total_pages ?? 1)) break;
  }
  return out;
}

const query = (node: string, dimensions: string, values: string) =>
  `query ($accountTag: string!, $from: Date!, $to: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) { rows: ${node}(limit: 10000, filter: { date_geq: $from, date_leq: $to }) { dimensions { ${dimensions} } ${values} } } } }`;

interface Dataset {
  kind: Kind;
  metricKeys: string[];
  gauge: boolean;
  query: string;
  /** Resource name and per-metric values for one row, or null to ignore the row. */
  read(row: GqlRow): { name: string; values: Record<string, number> } | null;
}

const num = (v: unknown) => toNumber(v) ?? 0;

const DATASETS: Dataset[] = [
  {
    kind: "worker",
    metricKeys: [C.workersRequests, C.workersCpuTime],
    gauge: false,
    query: query("workersInvocationsAdaptive", "date scriptName", "sum { requests cpuTimeUs }"),
    read: (row) =>
      row.dimensions?.scriptName
        ? { name: row.dimensions.scriptName, values: { [C.workersRequests]: num(row.sum?.requests), [C.workersCpuTime]: num(row.sum?.cpuTimeUs) / 1000 } }
        : null,
  },
  {
    kind: "r2",
    metricKeys: [C.r2ClassA, C.r2ClassB],
    gauge: false,
    query: query("r2OperationsAdaptiveGroups", "date bucketName actionType", "sum { requests }"),
    read: (row) => {
      const action = row.dimensions?.actionType ?? "";
      const key = R2_CLASS_A.has(action) ? C.r2ClassA : R2_CLASS_B.has(action) ? C.r2ClassB : null;
      return row.dimensions?.bucketName && key ? { name: row.dimensions.bucketName, values: { [key]: num(row.sum?.requests) } } : null;
    },
  },
  {
    kind: "r2",
    metricKeys: [C.r2Storage],
    gauge: true,
    query: query("r2StorageAdaptiveGroups", "date bucketName", "max { payloadSize metadataSize }"),
    read: (row) =>
      row.dimensions?.bucketName
        ? { name: row.dimensions.bucketName, values: { [C.r2Storage]: num(row.max?.payloadSize) + num(row.max?.metadataSize) } }
        : null,
  },
  {
    kind: "d1",
    metricKeys: [C.d1RowsRead, C.d1RowsWritten],
    gauge: false,
    query: query("d1AnalyticsAdaptiveGroups", "date databaseId", "sum { rowsRead rowsWritten }"),
    read: (row) =>
      row.dimensions?.databaseId
        ? { name: row.dimensions.databaseId, values: { [C.d1RowsRead]: num(row.sum?.rowsRead), [C.d1RowsWritten]: num(row.sum?.rowsWritten) } }
        : null,
  },
  {
    kind: "d1",
    metricKeys: [C.d1Storage],
    gauge: true,
    query: query("d1StorageAdaptiveGroups", "date databaseId", "max { databaseSizeBytes }"),
    read: (row) => (row.dimensions?.databaseId ? { name: row.dimensions.databaseId, values: { [C.d1Storage]: num(row.max?.databaseSizeBytes) } } : null),
  },
];

export const cloudflareAdapter: ProviderAdapter = {
  id: "cloudflare",
  name: "Cloudflare",
  authMethods: ["token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Accounts the token can see" },
    resourceDiscovery: { level: "supported", note: "Workers, R2 buckets and D1 databases" },
    usageMetrics: { level: "supported", note: "Workers requests and CPU time, R2 operations and storage, D1 rows and storage, daily." },
    quotaRetrieval: { level: "unsupported", note: "Set limits yourself; plan detection would need billing permissions." },
    actualCost: { level: "unsupported", note: "Not collected; it would need billing permissions." },
    forecastingInputs: { level: "supported", note: "Up to 30 days of daily history per sync." },
    billingCycleMetadata: { level: "unsupported", note: "Set each account's billing cycle day manually." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes Workers, buckets or databases." },
  },
  metrics,
  pricingRules: [],
  planAllowances: [],
  recommendations,
  tokenConnect: {
    tokenLabel: "API token",
    createUrl: "https://dash.cloudflare.com/profile/api-tokens",
    steps: [
      "Open My Profile → API Tokens in the Cloudflare dashboard and choose Create Token → Create Custom Token.",
      "Add each permission below at the Account level, set to Read.",
      "Under Account Resources, include the accounts you want to monitor, then create the token and copy it.",
    ],
    permissions: ["Account Settings: Read", "Account Analytics: Read", "Workers Scripts: Read", "Workers R2 Storage: Read", "D1: Read"],
  },

  async validate(ctx) {
    const accounts = await pagedList<{ id: string }>(client(ctx), "/accounts");
    if (!accounts.length) {
      throw new ProviderError("permission_denied", "The token can't see any accounts. Add the Account Settings: Read permission.");
    }
    return {
      identity: `${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
      grantedScopes: cloudflareAdapter.tokenConnect!.permissions!,
    };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const list = await pagedList<{ id: string; name: string }>(api, "/accounts");
    const accounts: DiscoveredAccount[] = [];
    const resources: DiscoveredResource[] = [];

    for (const a of list) {
      const skipped: string[] = [];
      const dash = `https://dash.cloudflare.com/${a.id}`;
      const tryType = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          if (isAuthFailure(e)) throw e;
          skipped.push(`${label}: ${(e as Error).message}`);
        }
      };
      const resource = (kind: Kind, name: string, display: string, dashboardUrl: string): DiscoveredResource => ({
        externalId: resourceId(a.id, kind, name),
        accountExternalId: a.id,
        name: display,
        resourceType: RESOURCE_TYPE[kind],
        region: null,
        plan: null,
        providerStatus: null,
        status: "active",
        dashboardUrl,
      });

      await tryType("Workers", async () => {
        const env = await api.get<{ id: string }[]>(`/accounts/${a.id}/workers/scripts`);
        if (!Array.isArray(env?.result)) throw new ProviderError("invalid_response", "Unexpected Workers response");
        for (const s of env.result) resources.push(resource("worker", s.id, s.id, `${dash}/workers/services/view/${s.id}/production`));
      });
      await tryType("R2", async () => {
        const env = await api.get<{ buckets?: { name: string }[] }>(`/accounts/${a.id}/r2/buckets?per_page=1000`);
        const buckets = env?.result?.buckets;
        if (!Array.isArray(buckets)) throw new ProviderError("invalid_response", "Unexpected R2 response");
        for (const b of buckets) resources.push(resource("r2", b.name, b.name, `${dash}/r2/default/buckets/${b.name}`));
      });
      await tryType("D1", async () => {
        const dbs = await pagedList<{ uuid: string; name: string }>(api, `/accounts/${a.id}/d1/database`);
        for (const d of dbs) resources.push(resource("d1", d.uuid, d.name, `${dash}/workers/d1/databases/${d.uuid}`));
      });

      accounts.push({
        externalId: a.id,
        name: a.name,
        accountType: "account",
        plan: null,
        billingCurrency: "USD",
        dashboardUrl: dash,
        ...(skipped.length ? { metadata: { skipped } } : {}),
      });
    }
    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const result = emptyResult();
    const today = startOfUtcDay(now);
    const from = new Date(Math.max(startOfUtcDay(target.since).getTime(), today.getTime() - (MAX_DAYS - 1) * DAY_MS));
    const days = utcDays(from, today);

    const parsed = target.resources.map((r) => ({ id: r.externalId, ...parseResourceId(r.externalId) }));
    const accountIds = [...new Set(parsed.map((p) => p.accountId).filter(Boolean) as string[])];

    for (const accountId of accountIds) {
      for (const ds of DATASETS) {
        const monitored = parsed.filter((p) => p.accountId === accountId && p.kind === ds.kind) as { id: string; name: string }[];
        if (!monitored.length) continue;
        const scopes = monitored.map((m) => ({ resourceExternalId: m.id }));
        try {
          const rows = await api.gql(ds.query, { accountTag: accountId, from: dayKey(from), to: dayKey(today) });
          // name|date → metric → value (summed for counters, max for gauges)
          const agg = new Map<string, Record<string, number>>();
          for (const row of rows) {
            const read = ds.read(row);
            const date = row.dimensions?.date;
            if (!read || !date) continue;
            const key = `${read.name}|${date}`;
            const cur = agg.get(key) ?? {};
            for (const [k, v] of Object.entries(read.values)) cur[k] = ds.gauge ? Math.max(cur[k] ?? 0, v) : (cur[k] ?? 0) + v;
            agg.set(key, cur);
          }
          for (const m of monitored) {
            const scope = { resourceExternalId: m.id };
            for (const day of days) {
              const values = agg.get(`${m.name}|${dayKey(day)}`);
              // Counters with no rows on a day really were zero; gauges only exist when measured.
              if (!values && ds.gauge) continue;
              for (const k of ds.metricKeys) {
                if (ds.gauge && values?.[k] === undefined) continue;
                result.observations.push(dayObservation(k, scope, day, values?.[k] ?? 0, now, ds.gauge ? { quality: "ok" } : {}));
              }
            }
          }
          recordOk(result, ds.metricKeys, scopes);
        } catch (e) {
          recordFailure(result, ds.metricKeys, scopes, e);
        }
      }
    }
    return result;
  },
};
