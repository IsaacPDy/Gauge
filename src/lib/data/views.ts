import "server-only";
import { listAccounts, listApplicationMappings, listApplications, listConnections, listResources } from "../../db/repos/inventory";
import { listQuotasWithEvaluations } from "../../db/repos/quotas";
import { loadSamples as querySamples } from "../../db/repos/samples";
import type { WorkspaceScope } from "../../db/scope";
import type { Row } from "../../db/types";
import type { CostEstimate } from "../engine/cost";
import type { Forecast } from "../engine/forecast";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { currentUsage, dailySeries, type CurrentUsage, type DailyValue, type UsagePoint } from "../engine/usage";
import { getAdapter, getMetric, PROVIDER_NAMES } from "../providers/registry";
import type { MetricDefinition } from "../types";

// Read models for pages. Everything here reads stored data for the caller's workspace
// through repositories; no provider API is called while rendering.

export type ConnectionRow = Row<"provider_connections">;
export type AccountRow = Row<"provider_accounts">;
export type ResourceRow = Row<"provider_resources">;
export type ApplicationRow = Row<"applications">;

export interface Inventory {
  connections: ConnectionRow[];
  accounts: AccountRow[];
  resources: ResourceRow[];
  applications: ApplicationRow[];
  appByResource: Map<string, ApplicationRow>;
  connectionById: Map<string, ConnectionRow>;
  accountById: Map<string, AccountRow>;
  resourceById: Map<string, ResourceRow>;
}

export async function loadInventory(scope: WorkspaceScope): Promise<Inventory> {
  const [conns, accs, resources, apps, mappings] = await Promise.all([
    listConnections(scope),
    listAccounts(scope),
    listResources(scope),
    listApplications(scope),
    listApplicationMappings(scope),
  ]);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const appByResource = new Map<string, ApplicationRow>();
  for (const m of mappings) {
    const app = appById.get(m.application_id);
    if (app) appByResource.set(m.resource_id, app);
  }
  return {
    connections: conns,
    accounts: accs,
    resources,
    applications: apps,
    appByResource,
    connectionById: new Map(conns.map((c) => [c.id, c])),
    accountById: new Map(accs.map((a) => [a.id, a])),
    resourceById: new Map(resources.map((r) => [r.id, r])),
  };
}

export function isSyncing(c: ConnectionRow, now = new Date()) {
  return c.status === "syncing" || (c.locked_until !== null && Date.parse(c.locked_until) > now.getTime());
}

export function providerLabel(c: ConnectionRow | undefined) {
  if (!c) return "Unknown connection";
  return `${PROVIDER_NAMES[c.provider] ?? c.provider} · ${c.label}`;
}

export interface QuotaView {
  id: string;
  metricKey: string;
  metric: MetricDefinition | undefined;
  metricName: string;
  unit: string;
  scopeType: "account" | "resource";
  scopeName: string;
  accountId: string | null;
  resourceId: string | null;
  connection: ConnectionRow | undefined;
  application: ApplicationRow | undefined;
  isDemo: boolean;
  source: "provider" | "user";
  limit: number | null;
  overageEffect: string;
  notes: string | null;
  verifiedAt: string | null;
  thresholds: unknown;
  pricingRuleId: string | null;
  evaluation: {
    isEffective: boolean;
    current: number | null;
    percent: number | null;
    dataState: "fresh" | "stale" | "missing" | "unknown_limit";
    dataUpdatedAt: string | null;
    cycleStart: string | null;
    cycleEnd: string | null;
    forecast: Forecast | null;
    cost: CostEstimate | null;
    coverage: { monitored: number; total: number; partial: boolean };
    computedAt: string;
  } | null;
}

export async function loadQuotaViews(scope: WorkspaceScope, inv: Inventory): Promise<QuotaView[]> {
  const rows = await listQuotasWithEvaluations(scope);
  return rows.map((q) => {
    const metric = getMetric(q.metric_key);
    const resource = q.resource_id ? inv.resourceById.get(q.resource_id) : undefined;
    const account = q.account_id ? inv.accountById.get(q.account_id) : undefined;
    const connection = inv.connectionById.get(resource?.connection_id ?? account?.connection_id ?? "");
    const ev = q.quota_evaluations;
    const forecast = ev && ev.forecast && typeof ev.forecast === "object" && "status" in ev.forecast ? (ev.forecast as unknown as Forecast) : null;
    const cost = ev && ev.cost && typeof ev.cost === "object" && "status" in ev.cost ? (ev.cost as unknown as CostEstimate) : null;
    const coverage = (ev?.coverage ?? {}) as { monitored?: number; total?: number; partial?: boolean };
    return {
      id: q.id,
      metricKey: q.metric_key,
      metric,
      metricName: metric?.name ?? q.metric_key,
      unit: q.unit,
      scopeType: q.scope_type as "account" | "resource",
      scopeName: resource?.name ?? account?.name ?? "Unknown scope",
      accountId: q.account_id,
      resourceId: q.resource_id,
      connection,
      application: resource ? inv.appByResource.get(resource.id) : undefined,
      isDemo: connection?.provider === "demo",
      source: q.source as "provider" | "user",
      limit: q.limit_value === null ? null : Number(q.limit_value),
      overageEffect: q.overage_effect,
      notes: q.notes,
      verifiedAt: q.verified_at,
      thresholds: q.thresholds,
      pricingRuleId: q.pricing_rule_id,
      evaluation: ev
        ? {
            isEffective: ev.is_effective,
            current: ev.current_value === null ? null : Number(ev.current_value),
            percent: ev.percent_used === null ? null : Number(ev.percent_used),
            dataState: ev.data_state as "fresh",
            dataUpdatedAt: ev.data_updated_at,
            cycleStart: ev.cycle_start,
            cycleEnd: ev.cycle_end,
            forecast,
            cost,
            coverage: { monitored: coverage.monitored ?? 0, total: coverage.total ?? 0, partial: coverage.partial ?? false },
            computedAt: ev.computed_at,
          }
        : null,
    };
  });
}

/** Sort key for "closest to trouble": the higher of current and projected utilization. */
export function riskScore(q: QuotaView): number {
  const e = q.evaluation;
  if (!e || e.percent === null) return -1;
  // Projections rank below anything already at 90%+, and below each other by size.
  const projected = e.forecast?.status === "ok" && e.forecast.crossingAt ? (e.forecast.projectedPercent ?? 0) : 0;
  return Math.max(e.percent, Math.min(projected, 120) * 0.74);
}

export function isAtRisk(q: QuotaView): boolean {
  const e = q.evaluation;
  if (!e?.isEffective || e.percent === null) return false;
  return (
    e.percent >= 50 ||
    (e.forecast?.status === "ok" && !!e.forecast.crossingAt) ||
    (e.cost?.status === "estimated" && ((e.cost.currentOverageCost ?? 0) > 0 || (e.cost.projectedOverageCost ?? 0) > 0))
  );
}

// ---------------------------------------------------------------------------
// Usage series and per-resource current usage, computed with the same engine the
// alert evaluator uses so numbers always agree.
// ---------------------------------------------------------------------------

export function cycleForResource(inv: Inventory, resourceId: string | null, accountId: string | null, now = new Date()): Cycle {
  const r = resourceId ? inv.resourceById.get(resourceId) : undefined;
  const a = inv.accountById.get(accountId ?? r?.account_id ?? "");
  return billingCycle(now, a?.billing_cycle_anchor_day ?? 1);
}

export interface SampleRow {
  metric_key: string;
  resource_id: string | null;
  account_id: string | null;
  bucket_start: string;
  bucket_end: string;
  value: number;
  observed_at: string;
  collected_at: string;
  quality: string;
  source: string;
  dimensions: unknown;
}

export async function loadSamples(
  scope: WorkspaceScope,
  opts: { metricKeys?: string[]; resourceIds?: string[]; accountIds?: string[]; from: Date },
): Promise<SampleRow[]> {
  return querySamples(scope, opts);
}

export function toPoints(rows: SampleRow[]): UsagePoint[] {
  return rows.map((s) => ({
    scopeId: (s.resource_id ?? s.account_id)!,
    bucketStart: new Date(s.bucket_start),
    bucketEnd: new Date(s.bucket_end),
    value: Number(s.value),
    observedAt: new Date(s.observed_at),
    quality: s.quality as UsagePoint["quality"],
  }));
}

/** Current-cycle usage for every (metric, monitored resource) pair. */
export async function loadResourceUsage(
  scope: WorkspaceScope,
  inv: Inventory,
  resourceIds: string[],
  now = new Date(),
): Promise<Map<string, CurrentUsage & { metricKey: string; resourceId: string; source: string | null }>> {
  const out = new Map<string, CurrentUsage & { metricKey: string; resourceId: string; source: string | null }>();
  if (!resourceIds.length) return out;
  const from = new Date(startOfUtcDay(now).getTime() - 40 * DAY_MS);
  const rows = await loadSamples(scope, { resourceIds, from });
  const grouped = new Map<string, SampleRow[]>();
  for (const r of rows) {
    const key = `${r.metric_key}|${r.resource_id}`;
    const arr = grouped.get(key);
    if (arr) arr.push(r);
    else grouped.set(key, [r]);
  }
  for (const [key, list] of grouped) {
    const [metricKey, resourceId] = key.split("|");
    const metric = getMetric(metricKey);
    if (!metric) continue;
    const cycle = cycleForResource(inv, resourceId, null, now);
    const usage = currentUsage(metric.aggregation, toPoints(list), cycle, [resourceId]);
    out.set(key, { ...usage, metricKey, resourceId, source: list[list.length - 1]?.source ?? null });
  }
  return out;
}

export function seriesFor(
  metric: MetricDefinition,
  rows: SampleRow[],
  scopeIds: string[],
  from: Date,
  now = new Date(),
): DailyValue[] {
  return dailySeries(metric.aggregation, toPoints(rows), scopeIds, from, new Date(startOfUtcDay(now).getTime() + DAY_MS));
}

/** Metrics an adapter declares, split into supported and unsupported. */
export function providerMetrics(provider: string) {
  const adapter = getAdapter(provider);
  return {
    supported: adapter?.metrics.filter((m) => m.supported) ?? [],
    unsupported: adapter?.metrics.filter((m) => !m.supported) ?? [],
  };
}
