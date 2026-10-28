import { and, eq, inArray } from "drizzle-orm";
import { claimConnection } from "../../db/claims";
import { db } from "../../db/client";
import { dbErrorMessage } from "../../db/errors";
import type { Json } from "../../db/json";
import { cost_records, provider_accounts, provider_connections, provider_resources, quota_rules, sync_runs, usage_samples } from "../../db/schema";
import { excludedFrom } from "../../db/sql";
import type { Row } from "../../db/types";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { findPricingRule, getAdapter, getMetric } from "../providers/registry";
import {
  type CollectResult,
  type Discovery,
  type MetricOutcome,
  ProviderError,
  type ProviderErrorCode,
  type ScopeRef,
} from "../providers/types";
import type { ConnectionStatus } from "../types";
import { loadCredentials } from "./credentials";
import { chunk } from "./db";
import { ensureReferenceData } from "./reference";

type Connection = Row<"provider_connections">;
export type SyncTrigger = "scheduled" | "manual" | "connect";

export interface SyncSummary {
  connectionId: string;
  workspaceId: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  errorCode?: string;
  message?: string;
}

const DISCOVERY_EVERY_MS = 24 * 3_600_000;
const HISTORY_DAYS = 35;

/**
 * Discover and collect one connection (PRD Workflow B / D).
 * Never deletes historical data; a failed run only records the failure and backs off.
 */
export async function runConnectionSync(
  connectionId: string,
  trigger: SyncTrigger,
  opts: { alreadyClaimed?: boolean; now?: Date } = {},
): Promise<SyncSummary> {
  const now = opts.now ?? new Date();
  await ensureReferenceData();

  const conn: Connection | undefined = opts.alreadyClaimed
    ? (await db.select().from(provider_connections).where(eq(provider_connections.id, connectionId)).limit(1))[0]
    : await claimConnection(connectionId);
  if (!conn) return { connectionId, workspaceId: "", status: "skipped", message: "Connection is busy or disconnected" };

  const [run] = await db
    .insert(sync_runs)
    .values({ workspace_id: conn.workspace_id, connection_id: conn.id, trigger })
    .returning({ id: sync_runs.id });

  const stats: Record<string, number> = {};
  try {
    const adapter = getAdapter(conn.provider);
    if (!adapter) throw new ProviderError("unknown", `No integration available for provider "${conn.provider}"`, { retryable: false });

    const credentials = await loadCredentials(conn, now);
    const ctx = { credentials, now };

    const discoveryDue =
      trigger !== "scheduled" || !conn.last_discovery_at || now.getTime() - Date.parse(conn.last_discovery_at) > DISCOVERY_EVERY_MS;
    if (discoveryDue) {
      const discovery = await adapter.discover(ctx);
      Object.assign(stats, await persistDiscovery(conn, discovery, now));
    }

    const target = await buildTarget(conn, now);
    let outcomes: MetricOutcome[] = [];
    if (target.resources.length > 0) {
      const result = await adapter.collect(ctx, target.collect);
      Object.assign(stats, await persistCollection(conn, result, target, run.id, now));
      outcomes = result.outcomes;
    }

    const failed = outcomes.filter((o) => o.status === "error");
    const permissionGaps = failed.filter((o) => o.errorCode === "permission_denied").length;
    const detail = failed.length
      ? `${failed.length} metric reading${failed.length === 1 ? "" : "s"} failed${permissionGaps ? ` (${permissionGaps} due to missing permissions)` : ""}. See the capability table.`
      : null;

    await updateConnection(conn, {
      status: "connected",
      status_detail: detail,
      last_success_at: now.toISOString(),
      last_discovery_at: discoveryDue ? now.toISOString() : conn.last_discovery_at,
      consecutive_failures: 0,
      last_error_code: null,
      next_sync_at: new Date(now.getTime() + conn.sync_interval_minutes * 60_000).toISOString(),
      capabilities: mergeOutcomes(conn.capabilities, adapter.capabilities, outcomes, now),
    });

    const status = failed.length ? "partial" : "succeeded";
    await db
      .update(sync_runs)
      .set({ status, finished_at: new Date().toISOString(), stats: { ...stats, metricErrors: failed.length } })
      .where(eq(sync_runs.id, run.id));
    return { connectionId: conn.id, workspaceId: conn.workspace_id, status };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("unknown", dbErrorMessage(e), { retryable: false });
    const plan = failurePlan(conn, err, now);
    await updateConnection(conn, {
      status: plan.status,
      status_detail: plan.detail,
      consecutive_failures: conn.consecutive_failures + 1,
      last_error_code: err.code,
      next_sync_at: plan.nextSyncAt?.toISOString() ?? null,
    });
    await db
      .update(sync_runs)
      .set({ status: "failed", finished_at: new Date().toISOString(), error_code: err.code, error_message: err.message.slice(0, 500), stats })
      .where(eq(sync_runs.id, run.id));
    return { connectionId: conn.id, workspaceId: conn.workspace_id, status: "failed", errorCode: err.code, message: err.message };
  }
}

/** Decide the connection state and next attempt after a failed run. */
export function failurePlan(
  conn: Pick<Connection, "status" | "consecutive_failures" | "sync_interval_minutes">,
  err: ProviderError,
  now: Date,
): { status: ConnectionStatus; detail: string; nextSyncAt: Date | null } {
  const failures = conn.consecutive_failures + 1;
  const interval = conn.sync_interval_minutes * 60_000;
  switch (err.code as ProviderErrorCode) {
    case "auth_invalid":
    case "auth_expired":
      // Retrying with rejected credentials only produces noise; wait for the user.
      return { status: "reauth_required", detail: err.message, nextSyncAt: null };
    case "permission_denied":
      return { status: "permission_insufficient", detail: err.message, nextSyncAt: new Date(now.getTime() + 24 * 3_600_000) };
    case "rate_limited":
    case "provider_unavailable":
    case "network": {
      const backoff = Math.min(interval, 5 * 60_000 * 2 ** (failures - 1));
      const wait = Math.max(backoff, err.options.retryAfterMs ?? 0);
      const status: ConnectionStatus = failures >= 3 ? "error" : conn.status === "syncing" ? "syncing" : conn.status === "connected" ? "connected" : "error";
      return {
        status,
        detail: `${err.message} (attempt ${failures}; retrying automatically)`,
        nextSyncAt: new Date(now.getTime() + wait),
      };
    }
    default:
      return { status: "error", detail: err.message, nextSyncAt: new Date(now.getTime() + interval) };
  }
}

async function updateConnection(conn: Connection, patch: Partial<Connection>) {
  const statusChanged = patch.status !== undefined && patch.status !== conn.status;
  await db
    .update(provider_connections)
    .set({ ...patch, ...(statusChanged ? { status_changed_at: new Date().toISOString() } : {}), locked_until: null })
    .where(eq(provider_connections.id, conn.id));
}

function mergeOutcomes(previous: Json, declared: object, outcomes: MetricOutcome[], now: Date): Json {
  const prev = (previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}) as Record<string, Json>;
  const metrics = { ...((prev.metrics as Record<string, Json>) ?? {}) };
  for (const o of outcomes) {
    const scope = "resourceExternalId" in o.scope ? o.scope.resourceExternalId : o.scope.accountExternalId;
    metrics[`${o.metricKey}|${scope}`] = {
      metricKey: o.metricKey,
      scope,
      status: o.status,
      errorCode: o.errorCode ?? null,
      detail: o.detail ?? null,
      at: now.toISOString(),
    };
  }
  return { declared: declared as Json, metrics };
}

// ---------------------------------------------------------------------------
// Discovery persistence: idempotent upserts keyed by provider IDs. User choices
// (monitoring flag, application grouping, billing-cycle day) are never overwritten.
// ---------------------------------------------------------------------------

async function persistDiscovery(conn: Connection, d: Discovery, now: Date) {
  const seen = now.toISOString();
  if (d.accounts.length) {
    const rows = d.accounts.map((a) => ({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      provider: conn.provider,
      external_id: a.externalId,
      name: a.name,
      account_type: a.accountType,
      plan: a.plan,
      billing_currency: a.billingCurrency,
      dashboard_url: a.dashboardUrl,
      metadata: (a.metadata ?? {}) as Json,
      status: "active",
      last_seen_at: seen,
    }));
    await db
      .insert(provider_accounts)
      .values(rows)
      .onConflictDoUpdate({
        target: [provider_accounts.connection_id, provider_accounts.external_id],
        set: excludedFrom(provider_accounts, rows, ["connection_id", "external_id"]),
      });
  }
  const accounts = await db
    .select({ id: provider_accounts.id, external_id: provider_accounts.external_id, status: provider_accounts.status })
    .from(provider_accounts)
    .where(eq(provider_accounts.connection_id, conn.id));
  const accountIds = new Map(accounts.map((a) => [a.external_id, a.id]));
  const goneAccounts = accounts.filter((a) => !d.accounts.some((x) => x.externalId === a.external_id) && a.status === "active");
  if (goneAccounts.length) {
    await db.update(provider_accounts).set({ status: "inaccessible" }).where(inArray(provider_accounts.id, goneAccounts.map((a) => a.id)));
  }

  if (d.resources.length) {
    for (const part of chunk(d.resources, 500)) {
      const rows = part.map((r) => ({
        workspace_id: conn.workspace_id,
        connection_id: conn.id,
        account_id: r.accountExternalId ? (accountIds.get(r.accountExternalId) ?? null) : null,
        provider: conn.provider,
        external_id: r.externalId,
        name: r.name,
        resource_type: r.resourceType,
        region: r.region,
        plan: r.plan,
        provider_status: r.providerStatus,
        status: r.status,
        dashboard_url: r.dashboardUrl,
        metadata: (r.metadata ?? {}) as Json,
        last_seen_at: seen,
      }));
      // is_monitored is not in the row, so a user's monitoring choice survives re-discovery.
      await db
        .insert(provider_resources)
        .values(rows)
        .onConflictDoUpdate({
          target: [provider_resources.connection_id, provider_resources.resource_type, provider_resources.external_id],
          set: excludedFrom(provider_resources, rows, ["connection_id", "resource_type", "external_id"]),
        });
    }
  }
  const resources = await db
    .select({
      id: provider_resources.id,
      external_id: provider_resources.external_id,
      resource_type: provider_resources.resource_type,
      status: provider_resources.status,
    })
    .from(provider_resources)
    .where(eq(provider_resources.connection_id, conn.id));
  const seenKeys = new Set(d.resources.map((r) => `${r.resourceType}|${r.externalId}`));
  const gone = resources.filter((r) => !seenKeys.has(`${r.resource_type}|${r.external_id}`) && r.status === "active");
  if (gone.length) {
    await db.update(provider_resources).set({ status: "inaccessible" }).where(inArray(provider_resources.id, gone.map((r) => r.id)));
  }
  return { accountsDiscovered: d.accounts.length, resourcesDiscovered: d.resources.length, resourcesNowInaccessible: gone.length };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface Target {
  collect: Parameters<NonNullable<ReturnType<typeof getAdapter>>["collect"]>[1];
  resources: { id: string; externalId: string; accountId: string | null }[];
  accounts: { id: string; externalId: string; plan: string | null; cycle: Cycle }[];
}

async function buildTarget(conn: Connection, now: Date): Promise<Target> {
  const accounts = await db
    .select({
      id: provider_accounts.id,
      external_id: provider_accounts.external_id,
      plan: provider_accounts.plan,
      billing_cycle_anchor_day: provider_accounts.billing_cycle_anchor_day,
    })
    .from(provider_accounts)
    .where(and(eq(provider_accounts.connection_id, conn.id), eq(provider_accounts.status, "active")));
  const resources = await db
    .select({
      id: provider_resources.id,
      external_id: provider_resources.external_id,
      account_id: provider_resources.account_id,
      provider_status: provider_resources.provider_status,
      last_collected_at: provider_resources.last_collected_at,
    })
    .from(provider_resources)
    .where(and(eq(provider_resources.connection_id, conn.id), eq(provider_resources.status, "active"), eq(provider_resources.is_monitored, true)));
  const acc = accounts.map((a) => ({
    id: a.id,
    externalId: a.external_id,
    plan: a.plan,
    cycle: billingCycle(now, a.billing_cycle_anchor_day),
  }));
  const accById = new Map(acc.map((a) => [a.id, a]));
  const defaultCycle = billingCycle(now, 1);

  const lastCollected = resources.map((r) => (r.last_collected_at ? Date.parse(r.last_collected_at) : null));
  const oldest = lastCollected.includes(null) ? null : Math.min(...(lastCollected as number[]));
  const historyStart = startOfUtcDay(now).getTime() - HISTORY_DAYS * DAY_MS;
  const since = new Date(oldest === null ? historyStart : Math.max(historyStart, startOfUtcDay(new Date(oldest)).getTime() - DAY_MS));

  const accountsInUse = acc.filter((a) => resources.some((r) => r.account_id === a.id));
  return {
    accounts: accountsInUse,
    resources: resources.map((r) => ({ id: r.id, externalId: r.external_id, accountId: r.account_id })),
    collect: {
      since,
      accounts: accountsInUse.map((a) => ({ externalId: a.externalId, plan: a.plan, cycle: a.cycle })),
      resources: resources.map((r) => {
        const a = r.account_id ? accById.get(r.account_id) : undefined;
        return {
          externalId: r.external_id,
          accountExternalId: a?.externalId ?? null,
          providerStatus: r.provider_status,
          cycle: a?.cycle ?? defaultCycle,
        };
      }),
    },
  };
}

async function persistCollection(conn: Connection, result: CollectResult, target: Target, runId: string, now: Date) {
  const resByExt = new Map(target.resources.map((r) => [r.externalId, r]));
  const accByExt = new Map(target.accounts.map((a) => [a.externalId, a]));
  const resolve = (scope: ScopeRef): { account_id: string | null; resource_id: string | null } | null => {
    if ("resourceExternalId" in scope) {
      const r = resByExt.get(scope.resourceExternalId);
      return r ? { account_id: r.accountId, resource_id: r.id } : null;
    }
    const a = accByExt.get(scope.accountExternalId);
    return a ? { account_id: a.id, resource_id: null } : null;
  };

  // Usage samples: one row per (scope, metric, bucket). Re-collection overwrites.
  const samples: (typeof usage_samples.$inferInsert)[] = [];
  for (const o of result.observations) {
    const metric = getMetric(o.metricKey);
    const ids = resolve(o.scope);
    if (!metric || !ids || !Number.isFinite(o.value) || o.value < 0) continue;
    samples.push({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      // Resource-level samples keep account_id null so the unique key stays one row per resource.
      account_id: ids.resource_id ? null : ids.account_id,
      resource_id: ids.resource_id,
      metric_key: o.metricKey,
      bucket_start: o.bucketStart.toISOString(),
      bucket_end: o.bucketEnd.toISOString(),
      value: o.value,
      unit: metric.unit,
      aggregation: metric.aggregation,
      observed_at: o.observedAt.toISOString(),
      collected_at: now.toISOString(),
      source: o.source,
      quality: o.quality,
      dimensions: (o.dimensions ?? null) as Json | null,
      sync_run_id: runId,
    });
  }
  const sampleKey = ["connection_id", "metric_key", "account_id", "resource_id", "bucket_start"];
  for (const part of chunk(samples, 500)) {
    await db
      .insert(usage_samples)
      .values(part)
      .onConflictDoUpdate({
        target: [usage_samples.connection_id, usage_samples.metric_key, usage_samples.account_id, usage_samples.resource_id, usage_samples.bucket_start],
        set: excludedFrom(usage_samples, part, sampleKey),
      });
  }

  // Provider-reported quotas. User-configured quotas live in separate rows and take precedence.
  const quotas: (typeof quota_rules.$inferInsert)[] = [];
  for (const q of result.quotas) {
    const ids = resolve(q.scope);
    if (!ids || !getMetric(q.metricKey)) continue;
    const scopeType = "resourceExternalId" in q.scope ? "resource" : "account";
    const plan = scopeType === "account" ? target.accounts.find((a) => a.id === ids.account_id)?.plan : undefined;
    quotas.push({
      workspace_id: conn.workspace_id,
      metric_key: q.metricKey,
      scope_type: scopeType,
      account_id: scopeType === "account" ? ids.account_id : null,
      resource_id: scopeType === "resource" ? ids.resource_id : null,
      limit_value: q.limit,
      unit: q.unit,
      source: "provider",
      overage_effect: q.overageEffect,
      pricing_rule_id: findPricingRule(q.metricKey, plan)?.id ?? null,
      notes: q.notes ?? null,
      verified_at: now.toISOString(),
    });
  }
  if (quotas.length) {
    await db
      .insert(quota_rules)
      .values(quotas)
      .onConflictDoUpdate({
        target: [quota_rules.workspace_id, quota_rules.metric_key, quota_rules.account_id, quota_rules.resource_id, quota_rules.source],
        set: excludedFrom(quota_rules, quotas, ["workspace_id", "metric_key", "account_id", "resource_id", "source"]),
      });
  }

  // Provider-reported spend.
  const costs: (typeof cost_records.$inferInsert)[] = [];
  for (const c of result.costs) {
    const a = accByExt.get(c.accountExternalId);
    if (!a) continue;
    costs.push({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      account_id: a.id,
      resource_id: null,
      metric_key: null,
      period_start: c.periodStart.toISOString(),
      period_end: c.periodEnd.toISOString(),
      amount: c.amount,
      currency: c.currency,
      kind: "reported",
      calculation: { source: "provider" } as Json,
      computed_at: now.toISOString(),
    });
  }
  if (costs.length) {
    await db
      .insert(cost_records)
      .values(costs)
      .onConflictDoUpdate({
        target: [cost_records.workspace_id, cost_records.kind, cost_records.metric_key, cost_records.account_id, cost_records.resource_id, cost_records.period_start],
        set: excludedFrom(cost_records, costs, ["workspace_id", "kind", "metric_key", "account_id", "resource_id", "period_start"]),
      });
  }

  const collectedIds = [
    ...new Set(
      result.outcomes
        .filter((o) => o.status === "ok" && "resourceExternalId" in o.scope)
        .map((o) => resByExt.get((o.scope as { resourceExternalId: string }).resourceExternalId)?.id)
        .filter(Boolean) as string[],
    ),
  ];
  if (collectedIds.length) {
    await db.update(provider_resources).set({ last_collected_at: now.toISOString() }).where(inArray(provider_resources.id, collectedIds));
  }

  return { samplesStored: samples.length, providerQuotas: quotas.length, reportedCosts: costs.length };
}
