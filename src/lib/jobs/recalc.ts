import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { dbErrorMessage } from "../../db/errors";
import type { Json } from "../../db/json";
import {
  alert_rules,
  alerts,
  application_resources,
  applications,
  cost_records,
  notification_deliveries,
  profiles,
  provider_accounts,
  provider_connections,
  provider_resources,
  quota_evaluations,
  quota_rules,
  usage_samples,
  workspaces,
} from "../../db/schema";
import { excludedFrom } from "../../db/sql";
import type { Row } from "../../db/types";
import { evaluateAlerts, normalizeThresholds, type AlertCandidate, type QuotaStateForAlerts } from "../engine/alerts";
import { estimateCost, type CostEstimate } from "../engine/cost";
import { forecast, type Forecast } from "../engine/forecast";
import { isStale } from "../engine/health";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { currentUsage, dailySeries, type CurrentUsage, type UsagePoint } from "../engine/usage";
import { findPricingRule, getMetric, getPricingRule, PROVIDER_NAMES, recommendationFor } from "../providers/registry";
import {
  type AlertCategory,
  type ConnectionStatus,
  DEFAULT_THRESHOLDS,
  type MetricDefinition,
  type OverageEffect,
  SEVERITY_RANK,
  type Severity,
} from "../types";
import { formatValue } from "../units";
import { chunk } from "./db";

type QuotaRow = Row<"quota_rules">;
type AlertRow = Row<"alerts">;

const FORECAST_LOOKBACK_DAYS = 15;
// Postgres allows 65,535 bound parameters per statement: keep bulk writes well under it.
const ROW_CHUNK = 500;
const ID_CHUNK = 1000;

export interface QuotaComputation {
  quota: QuotaRow;
  metric: MetricDefinition;
  isEffective: boolean;
  cycle: Cycle;
  usage: CurrentUsage;
  percent: number | null;
  forecast: Forecast | null;
  cost: CostEstimate | null;
  dataState: "fresh" | "stale" | "missing" | "unknown_limit";
  coverage: { monitored: number; total: number; scopeIds: string[] };
  accountId: string | null;
  connectionId: string | null;
  plan: string | null;
}

interface WorkspaceData {
  workspace: Row<"workspaces">;
  ownerEmail: string | null;
  connections: Row<"provider_connections">[];
  accounts: Row<"provider_accounts">[];
  resources: Row<"provider_resources">[];
  appByResource: Map<string, { id: string; name: string }>;
  quotas: QuotaRow[];
  rules: Row<"alert_rules">[];
}

async function loadWorkspace(workspaceId: string): Promise<WorkspaceData | null> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) return null;
  const [owner, connections, accounts, resources, mappings, quotas, rules] = await Promise.all([
    db.select({ email: profiles.email }).from(profiles).where(eq(profiles.id, workspace.owner_id)).limit(1),
    db.select().from(provider_connections).where(eq(provider_connections.workspace_id, workspaceId)),
    db.select().from(provider_accounts).where(eq(provider_accounts.workspace_id, workspaceId)),
    db.select().from(provider_resources).where(eq(provider_resources.workspace_id, workspaceId)),
    db
      .select({ resource_id: application_resources.resource_id, id: applications.id, name: applications.name })
      .from(application_resources)
      .innerJoin(applications, eq(application_resources.application_id, applications.id))
      .where(eq(application_resources.workspace_id, workspaceId)),
    db.select().from(quota_rules).where(eq(quota_rules.workspace_id, workspaceId)),
    db.select().from(alert_rules).where(eq(alert_rules.workspace_id, workspaceId)),
  ]);
  const appByResource = new Map<string, { id: string; name: string }>();
  for (const m of mappings) appByResource.set(m.resource_id, { id: m.id, name: m.name });
  return { workspace, ownerEmail: owner[0]?.email ?? null, connections, accounts, resources, appByResource, quotas, rules };
}

/** User-configured quotas override provider-reported ones for the same metric and scope. */
export function effectiveQuotaIds(quotas: Pick<QuotaRow, "id" | "metric_key" | "account_id" | "resource_id" | "source">[]): Set<string> {
  const byScope = new Map<string, Pick<QuotaRow, "id" | "source">>();
  for (const q of quotas) {
    const key = `${q.metric_key}|${q.account_id ?? ""}|${q.resource_id ?? ""}`;
    const cur = byScope.get(key);
    if (!cur || (cur.source === "provider" && q.source === "user")) byScope.set(key, q);
  }
  return new Set([...byScope.values()].map((q) => q.id));
}

/**
 * Compute every quota's current state from stored samples (never from live provider calls).
 * Shared by the alert engine and anything that needs consistent numbers.
 */
export async function computeQuotas(data: WorkspaceData, now: Date): Promise<QuotaComputation[]> {
  const { workspace, accounts, resources, quotas } = data;
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const resourceById = new Map(resources.map((r) => [r.id, r]));
  const effective = effectiveQuotaIds(quotas);

  const prepared = quotas
    .map((q) => {
      const metric = getMetric(q.metric_key);
      if (!metric) return null;
      const resource = q.resource_id ? resourceById.get(q.resource_id) : undefined;
      const account = q.account_id ? accountById.get(q.account_id) : resource?.account_id ? accountById.get(resource.account_id) : undefined;
      const cycle = billingCycle(now, account?.billing_cycle_anchor_day ?? 1);
      const inAccount = account ? resources.filter((r) => r.account_id === account.id && r.status === "active") : [];
      let scopeIds: string[];
      let total: number;
      if (metric.scopeLevel === "account") {
        scopeIds = q.account_id ? [q.account_id] : [];
        total = scopeIds.length;
      } else if (q.scope_type === "resource") {
        scopeIds = resource?.is_monitored && resource.status === "active" ? [resource.id] : [];
        total = 1;
      } else {
        scopeIds = inAccount.filter((r) => r.is_monitored).map((r) => r.id);
        total = inAccount.length;
      }
      return { q, metric, cycle, account, resource, scopeIds, total };
    })
    .filter((x) => x !== null);

  // One query for all samples needed by every quota in the workspace.
  const metricKeys = [...new Set(prepared.map((p) => p.q.metric_key))];
  const earliest = prepared.reduce(
    (min, p) => Math.min(min, p.cycle.start.getTime(), startOfUtcDay(now).getTime() - FORECAST_LOOKBACK_DAYS * DAY_MS),
    now.getTime(),
  );
  const samples = metricKeys.length
    ? await db
        .select({
          metric_key: usage_samples.metric_key,
          account_id: usage_samples.account_id,
          resource_id: usage_samples.resource_id,
          bucket_start: usage_samples.bucket_start,
          bucket_end: usage_samples.bucket_end,
          value: usage_samples.value,
          observed_at: usage_samples.observed_at,
          quality: usage_samples.quality,
        })
        .from(usage_samples)
        .where(
          and(
            eq(usage_samples.workspace_id, workspace.id),
            inArray(usage_samples.metric_key, metricKeys),
            gte(usage_samples.bucket_start, new Date(earliest).toISOString()),
          ),
        )
        .orderBy(asc(usage_samples.id))
    : [];
  const byMetric = new Map<string, UsagePoint[]>();
  for (const s of samples) {
    const p: UsagePoint = {
      scopeId: (s.resource_id ?? s.account_id)!,
      bucketStart: new Date(s.bucket_start),
      bucketEnd: new Date(s.bucket_end),
      value: Number(s.value),
      observedAt: new Date(s.observed_at),
      quality: s.quality as UsagePoint["quality"],
    };
    const arr = byMetric.get(s.metric_key);
    if (arr) arr.push(p);
    else byMetric.set(s.metric_key, [p]);
  }

  const tomorrow = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  return prepared.map(({ q, metric, cycle, account, resource, scopeIds, total }) => {
    const scopeSet = new Set(scopeIds);
    const points = (byMetric.get(q.metric_key) ?? []).filter((p) => scopeSet.has(p.scopeId));
    const usage = currentUsage(metric.aggregation, points, cycle, scopeIds);
    const limit = q.limit_value === null ? null : Number(q.limit_value);
    const percent =
      limit === null || usage.value === null ? null : limit === 0 ? (usage.value > 0 ? 100 : 0) : (usage.value / limit) * 100;

    let fc: Forecast | null = null;
    if (usage.value !== null) {
      const from = new Date(Math.min(cycle.start.getTime(), startOfUtcDay(now).getTime() - FORECAST_LOOKBACK_DAYS * DAY_MS));
      const daily = dailySeries(metric.aggregation, points, scopeIds, from, tomorrow);
      fc = forecast({ aggregation: metric.aggregation, daily, current: usage.value, cycle, now, limit });
    }

    const plan = account?.plan ?? null;
    let cost: CostEstimate | null = null;
    const billable = (["charges", "both"] as OverageEffect[]).includes(q.overage_effect as OverageEffect);
    if (billable) {
      const rule = getPricingRule(q.pricing_rule_id) ?? findPricingRule(q.metric_key, plan);
      cost = estimateCost(rule, usage.value, fc?.status === "ok" ? fc.projected : null, {
        unavailableReason: plan ? `No pricing rule for the ${plan} plan` : "Plan unknown",
      });
    }

    const dataState: QuotaComputation["dataState"] =
      usage.value === null
        ? "missing"
        : limit === null
          ? "unknown_limit"
          : isStale(usage.asOf, now, data.workspace.stale_after_hours)
            ? "stale"
            : "fresh";

    return {
      quota: q,
      metric,
      isEffective: effective.has(q.id),
      cycle,
      usage,
      percent,
      forecast: fc,
      cost,
      dataState,
      coverage: { monitored: scopeIds.length, total, scopeIds },
      accountId: account?.id ?? null,
      connectionId: account?.connection_id ?? resource?.connection_id ?? null,
      plan,
    };
  });
}

/**
 * PRD Workflow B steps 4–7: recalculate usage against quotas, update forecasts and
 * estimated costs, evaluate alert rules and queue notifications.
 */
export async function recalculateWorkspace(workspaceId: string, now = new Date()) {
  const data = await loadWorkspace(workspaceId);
  if (!data) return { quotas: 0, newAlerts: 0 };
  const computed = await computeQuotas(data, now);

  // 1. Persist evaluations
  if (computed.length) {
    const rows = computed.map((c) => ({
      quota_rule_id: c.quota.id,
      workspace_id: workspaceId,
      is_effective: c.isEffective,
      current_value: c.usage.value,
      limit_value: c.quota.limit_value,
      percent_used: c.percent,
      cycle_start: c.cycle.start.toISOString(),
      cycle_end: c.cycle.end.toISOString(),
      data_updated_at: c.usage.asOf?.toISOString() ?? null,
      data_state: c.dataState,
      coverage: {
        monitored: c.coverage.monitored,
        total: c.coverage.total,
        partial: c.usage.partial || c.coverage.monitored < c.coverage.total,
      } as Json,
      forecast: (c.forecast ?? {}) as unknown as Json,
      cost: (c.cost ?? {}) as unknown as Json,
      computed_at: now.toISOString(),
    }));
    const set = excludedFrom(quota_evaluations, rows, ["quota_rule_id"]);
    for (const part of chunk(rows, ROW_CHUNK)) {
      await db.insert(quota_evaluations).values(part).onConflictDoUpdate({ target: quota_evaluations.quota_rule_id, set });
    }
  }

  // 2. Estimated / projected costs (always labelled as estimates)
  const costRows = computed
    .filter((c) => c.isEffective && c.cost?.status === "estimated")
    .flatMap((c) => {
      const common = {
        workspace_id: workspaceId,
        connection_id: c.connectionId,
        account_id: c.quota.account_id,
        resource_id: c.quota.resource_id,
        metric_key: c.quota.metric_key,
        period_start: c.cycle.start.toISOString(),
        period_end: c.cycle.end.toISOString(),
        currency: c.cost!.currency!,
        pricing_rule_id: c.cost!.pricingRuleId ?? null,
        pricing_version: c.cost!.pricingVersion ?? null,
        computed_at: now.toISOString(),
      };
      const rows = [
        {
          ...common,
          kind: "estimated",
          amount: c.cost!.currentOverageCost ?? 0,
          calculation: { usage: c.usage.value, included: c.cost!.includedQuantity, basis: "current cycle-to-date usage" } as Json,
        },
      ];
      if (c.cost!.projectedOverageCost !== undefined) {
        rows.push({
          ...common,
          kind: "projected",
          amount: c.cost!.projectedOverageCost,
          calculation: { usage: c.forecast?.projected ?? null, included: c.cost!.includedQuantity, basis: "forecast at cycle end" } as Json,
        });
      }
      return rows;
    });
  if (costRows.length) {
    const set = excludedFrom(cost_records, costRows, ["workspace_id", "kind", "metric_key", "account_id", "resource_id", "period_start"]);
    for (const part of chunk(costRows, ROW_CHUNK)) {
      await db
        .insert(cost_records)
        .values(part)
        .onConflictDoUpdate({
          target: [cost_records.workspace_id, cost_records.kind, cost_records.metric_key, cost_records.account_id, cost_records.resource_id, cost_records.period_start],
          set,
        });
    }
  }

  // 3. Alerts
  const ruleBy = new Map(data.rules.map((r) => [r.category as AlertCategory, r]));
  const rules = Object.fromEntries(
    (["quota_threshold", "forecast_breach", "cost_overage", "integration_health"] as AlertCategory[]).map((c) => [
      c,
      { enabled: ruleBy.get(c)?.enabled ?? true },
    ]),
  ) as Record<AlertCategory, { enabled: boolean }>;
  const workspaceThresholds = normalizeThresholds(ruleBy.get("quota_threshold")?.thresholds) ?? DEFAULT_THRESHOLDS;

  const connById = new Map(data.connections.map((c) => [c.id, c]));
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const resourceById = new Map(data.resources.map((r) => [r.id, r]));

  const quotaStates: QuotaStateForAlerts[] = computed
    .filter((c) => c.isEffective && c.connectionId && connById.get(c.connectionId)?.status !== "disconnected")
    .map((c) => {
      const resource = c.quota.resource_id ? resourceById.get(c.quota.resource_id) : undefined;
      const account = c.accountId ? accountById.get(c.accountId) : undefined;
      const app = resource ? data.appByResource.get(resource.id) : undefined;
      const conn = connById.get(c.connectionId!)!;
      return {
        quotaId: c.quota.id,
        metricKey: c.quota.metric_key,
        metricName: c.metric.name,
        unit: c.metric.unit,
        scopeName: resource ? resource.name : `${account?.name ?? "account"} (all projects)`,
        providerLabel: `${PROVIDER_NAMES[conn.provider] ?? conn.provider} · ${conn.label}`,
        connectionId: conn.id,
        accountId: c.accountId,
        resourceId: resource?.id ?? null,
        applicationId: app?.id ?? null,
        applicationName: app?.name ?? null,
        limit: c.quota.limit_value === null ? null : Number(c.quota.limit_value),
        current: c.usage.value,
        percent: c.percent,
        cycle: c.cycle,
        dataUpdatedAt: c.usage.asOf,
        stale: c.dataState === "stale",
        partialCoverage: c.usage.partial || c.coverage.monitored < c.coverage.total,
        overageEffect: c.quota.overage_effect as OverageEffect,
        thresholds: normalizeThresholds(c.quota.thresholds) ?? workspaceThresholds,
        forecast: c.forecast,
        cost: c.cost,
        recommendedAction: recommendationFor(c.quota.metric_key),
      };
    });

  const { candidates, evaluatedGroups } = evaluateAlerts({
    now,
    staleAfterHours: data.workspace.stale_after_hours,
    rules,
    quotas: quotaStates,
    connections: data.connections.map((c) => ({
      id: c.id,
      label: c.label,
      providerName: PROVIDER_NAMES[c.provider] ?? c.provider,
      status: c.status as ConnectionStatus,
      statusDetail: c.status_detail,
      statusChangedAt: new Date(c.status_changed_at),
      lastSuccessAt: c.last_success_at ? new Date(c.last_success_at) : null,
      createdAt: new Date(c.created_at),
    })),
    format: (v, u) => formatValue(v, u),
  });

  const effectiveIds = new Set(computed.filter((c) => c.isEffective).map((c) => c.quota.id));
  const newAlerts = await persistAlerts(data, candidates, evaluatedGroups, effectiveIds, ruleBy, now);
  return { quotas: computed.length, newAlerts };
}

// ---------------------------------------------------------------------------
// Alert persistence: dedupe, escalation, muting, resolution and delivery queueing
// ---------------------------------------------------------------------------

const ACTIVE = ["open", "acknowledged", "muted"];

async function persistAlerts(
  data: WorkspaceData,
  candidates: AlertCandidate[],
  evaluatedGroups: Set<string>,
  effectiveQuotaIds: Set<string>,
  ruleBy: Map<AlertCategory, Row<"alert_rules">>,
  now: Date,
): Promise<number> {
  const workspaceId = data.workspace.id;
  const nowIso = now.toISOString();
  // Every active alert, plus any earlier alert sharing a candidate's dedupe key.
  const loaded = new Map<string, AlertRow>();
  const active = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workspace_id, workspaceId), inArray(alerts.status, ACTIVE)))
    .orderBy(asc(alerts.created_at));
  for (const a of active) loaded.set(a.id, a);
  const keys = candidates.map((c) => c.dedupeKey);
  for (let i = 0; i < keys.length; i += 100) {
    const rows = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.workspace_id, workspaceId), inArray(alerts.dedupe_key, keys.slice(i, i + 100))));
    for (const a of rows) loaded.set(a.id, a);
  }
  const existing = [...loaded.values()];

  const byDedupe = new Map(existing.map((a) => [a.dedupe_key, a]));
  const byGroup = new Map<string, AlertRow[]>();
  for (const a of existing) {
    const arr = byGroup.get(a.group_key);
    if (arr) arr.push(a);
    else byGroup.set(a.group_key, [a]);
  }
  const activeDedupe = new Set(candidates.map((c) => c.dedupeKey));
  let created = 0;

  for (const c of candidates) {
    const groupAlerts = byGroup.get(c.groupKey) ?? [];
    const prior = byDedupe.get(c.dedupeKey);
    const freshFields = {
      current_value: c.currentValue,
      limit_value: c.limitValue,
      percent_used: c.percentUsed,
      forecast_breach_at: c.forecastBreachAt,
      data_updated_at: c.dataUpdatedAt,
      message: c.message,
      details: c.details as Json,
    };

    if (prior) {
      // Same threshold, same cycle: never notify twice. Keep the numbers current.
      const othersActive = groupAlerts.some((a) => a.id !== prior.id && ACTIVE.includes(a.status));
      if (ACTIVE.includes(prior.status)) {
        await db.update(alerts).set(freshFields).where(eq(alerts.id, prior.id));
      } else if (!othersActive) {
        // The condition came back within the same cycle: reopen quietly.
        await db.update(alerts).set({ ...freshFields, status: "open", resolved_at: null }).where(eq(alerts.id, prior.id));
      }
      continue;
    }

    const muted = groupAlerts.some((a) => a.muted_until && Date.parse(a.muted_until) > now.getTime());
    const rule = ruleBy.get(c.category);
    // Insert, escalation and delivery queueing commit together, so a crash can never leave an alert
    // without its deliveries, or a superseded alert without its replacement.
    let wasCreated: boolean;
    try {
      wasCreated = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(alerts)
          .values({
                workspace_id: workspaceId,
                rule_id: rule?.id ?? null,
                category: c.category,
                severity: c.severity,
                status: muted ? "muted" : "open",
                muted_until: muted ? (groupAlerts.find((a) => a.muted_until)?.muted_until ?? null) : null,
                dedupe_key: c.dedupeKey,
                group_key: c.groupKey,
                title: c.title,
                message: c.message,
                recommended_action: c.recommendedAction,
                connection_id: c.connectionId,
                account_id: c.accountId,
                resource_id: c.resourceId,
                application_id: c.applicationId,
                quota_rule_id: c.quotaRuleId,
                metric_key: c.metricKey,
                current_value: c.currentValue,
                limit_value: c.limitValue,
                unit: c.unit,
                percent_used: c.percentUsed,
                cycle_start: c.cycleStart,
                cycle_reset_at: c.cycleResetAt,
                forecast_breach_at: c.forecastBreachAt,
                data_updated_at: c.dataUpdatedAt,
                details: c.details as Json,
          })
          // A concurrent run may have created it first; a plain insert error would abort the transaction.
          .onConflictDoNothing({ target: [alerts.workspace_id, alerts.dedupe_key] })
          .returning();
        if (!inserted) return false;

        // Escalation: the new alert supersedes less or equally severe active alerts in its group.
        const supersede = groupAlerts.filter(
          (a) => ACTIVE.includes(a.status) && SEVERITY_RANK[a.severity as Severity] <= SEVERITY_RANK[c.severity],
        );
        for (const ids of chunk(supersede.map((a) => a.id), ID_CHUNK)) {
          await tx.update(alerts).set({ status: "superseded" }).where(inArray(alerts.id, ids));
        }

        if (!muted) await queueDeliveries(tx, data, inserted, rule);
        return true;
      });
    } catch (e) {
      throw new Error(`Creating alert failed: ${dbErrorMessage(e)}`);
    }
    if (wasCreated) created++;
  }

  // Resolution: active alerts whose condition no longer holds.
  const toResolve = existing.filter((a) => {
    if (!ACTIVE.includes(a.status) || activeDedupe.has(a.dedupe_key)) return false;
    if (evaluatedGroups.has(a.group_key)) return true;
    if (a.category === "integration_health") {
      const conn = data.connections.find((c) => c.id === a.connection_id);
      return !conn || conn.status === "disconnected";
    }
    // Quota-based alerts from an ended cycle, for a deleted quota, or for a quota that your
    // own limit now overrides.
    return (
      (a.cycle_reset_at !== null && Date.parse(a.cycle_reset_at) <= now.getTime()) ||
      a.quota_rule_id === null ||
      !effectiveQuotaIds.has(a.quota_rule_id)
    );
  });
  for (const ids of chunk(toResolve.map((a) => a.id), ID_CHUNK)) {
    await db.update(alerts).set({ status: "resolved", resolved_at: nowIso }).where(inArray(alerts.id, ids));
  }
  return created;
}

async function queueDeliveries(tx: Tx, data: WorkspaceData, alert: AlertRow, rule: Row<"alert_rules"> | undefined) {
  const ws = data.workspace;
  const inApp = ws.notify_in_app && (rule?.notify_in_app ?? true);
  const severityOk = SEVERITY_RANK[alert.severity as Severity] >= SEVERITY_RANK[ws.email_min_severity as Severity];
  const recipient = ws.alert_email ?? data.ownerEmail;
  const emailEnabled = ws.notify_email && (rule?.notify_email ?? true);
  const emailReason = !emailEnabled
    ? "Email notifications are turned off"
    : !severityOk
      ? `Below the email threshold (${ws.email_min_severity})`
      : !recipient
        ? "No email address on file"
        : null;
  const nowIso = new Date().toISOString();

  await tx
    .insert(notification_deliveries)
    .values([
      {
        workspace_id: ws.id,
        alert_id: alert.id,
        channel: "in_app",
        status: inApp ? "sent" : "skipped",
        sent_at: inApp ? nowIso : null,
        last_error: inApp ? null : "In-app notifications are turned off",
      },
      {
        workspace_id: ws.id,
        alert_id: alert.id,
        channel: "email",
        recipient: emailReason ? null : recipient,
        status: emailReason ? "skipped" : "pending",
        last_error: emailReason,
      },
    ])
    .onConflictDoNothing({ target: [notification_deliveries.alert_id, notification_deliveries.channel] });
}
