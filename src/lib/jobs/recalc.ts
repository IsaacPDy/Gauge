import { evaluateAlerts, normalizeThresholds, type AlertCandidate, type QuotaStateForAlerts } from "../engine/alerts";
import { estimateCost, type CostEstimate } from "../engine/cost";
import { forecast, type Forecast } from "../engine/forecast";
import { isStale } from "../engine/health";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { currentUsage, dailySeries, type CurrentUsage, type UsagePoint } from "../engine/usage";
import { findPricingRule, getMetric, getPricingRule, PROVIDER_NAMES, recommendationFor } from "../providers/registry";
import { adminClient, type AdminClient } from "../supabase/admin";
import type { Database, Json } from "../supabase/database.types";
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
import { fetchAll, must } from "./db";

type Tables = Database["public"]["Tables"];
type QuotaRow = Tables["quota_rules"]["Row"];
type AlertRow = Tables["alerts"]["Row"];

const FORECAST_LOOKBACK_DAYS = 15;

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
  workspace: Tables["workspaces"]["Row"];
  ownerEmail: string | null;
  connections: Tables["provider_connections"]["Row"][];
  accounts: Tables["provider_accounts"]["Row"][];
  resources: Tables["provider_resources"]["Row"][];
  appByResource: Map<string, { id: string; name: string }>;
  quotas: QuotaRow[];
  rules: Tables["alert_rules"]["Row"][];
}

async function loadWorkspace(admin: AdminClient, workspaceId: string): Promise<WorkspaceData | null> {
  const workspace = must(await admin.from("workspaces").select("*").eq("id", workspaceId).maybeSingle(), "Load workspace");
  if (!workspace) return null;
  const [owner, connections, accounts, resources, mappings, quotas, rules] = await Promise.all([
    admin.from("profiles").select("email").eq("id", workspace.owner_id).maybeSingle(),
    admin.from("provider_connections").select("*").eq("workspace_id", workspaceId),
    admin.from("provider_accounts").select("*").eq("workspace_id", workspaceId),
    fetchAll((a, b) => admin.from("provider_resources").select("*").eq("workspace_id", workspaceId).range(a, b)),
    fetchAll((a, b) =>
      admin.from("application_resources").select("resource_id, applications(id, name)").eq("workspace_id", workspaceId).range(a, b),
    ),
    fetchAll((a, b) => admin.from("quota_rules").select("*").eq("workspace_id", workspaceId).range(a, b)),
    admin.from("alert_rules").select("*").eq("workspace_id", workspaceId),
  ]);
  const appByResource = new Map<string, { id: string; name: string }>();
  for (const m of mappings as { resource_id: string; applications: { id: string; name: string } | null }[]) {
    if (m.applications) appByResource.set(m.resource_id, m.applications);
  }
  return {
    workspace,
    ownerEmail: owner.data?.email ?? null,
    connections: must(connections, "Load connections"),
    accounts: must(accounts, "Load accounts"),
    resources,
    appByResource,
    quotas,
    rules: must(rules, "Load alert rules"),
  };
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
export async function computeQuotas(admin: AdminClient, data: WorkspaceData, now: Date): Promise<QuotaComputation[]> {
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
    ? await fetchAll((a, b) =>
        admin
          .from("usage_samples")
          .select("metric_key, account_id, resource_id, bucket_start, bucket_end, value, observed_at, quality")
          .eq("workspace_id", workspace.id)
          .in("metric_key", metricKeys)
          .gte("bucket_start", new Date(earliest).toISOString())
          .order("id")
          .range(a, b),
      )
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
  const admin = adminClient();
  const data = await loadWorkspace(admin, workspaceId);
  if (!data) return { quotas: 0, newAlerts: 0 };
  const computed = await computeQuotas(admin, data, now);

  // 1. Persist evaluations
  if (computed.length) {
    must(
      await admin.from("quota_evaluations").upsert(
        computed.map((c) => ({
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
        })),
        { onConflict: "quota_rule_id" },
      ),
      "Upsert quota evaluations",
    );
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
    must(
      await admin
        .from("cost_records")
        .upsert(costRows, { onConflict: "workspace_id,kind,metric_key,account_id,resource_id,period_start" }),
      "Upsert estimated costs",
    );
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
  const newAlerts = await persistAlerts(admin, data, candidates, evaluatedGroups, effectiveIds, ruleBy, now);
  return { quotas: computed.length, newAlerts };
}

// ---------------------------------------------------------------------------
// Alert persistence: dedupe, escalation, muting, resolution and delivery queueing
// ---------------------------------------------------------------------------

const ACTIVE = ["open", "acknowledged", "muted"];

async function persistAlerts(
  admin: AdminClient,
  data: WorkspaceData,
  candidates: AlertCandidate[],
  evaluatedGroups: Set<string>,
  effectiveQuotaIds: Set<string>,
  ruleBy: Map<AlertCategory, Tables["alert_rules"]["Row"]>,
  now: Date,
): Promise<number> {
  const workspaceId = data.workspace.id;
  const nowIso = now.toISOString();
  // Every active alert, plus any earlier alert sharing a candidate's dedupe key.
  const loaded = new Map<string, AlertRow>();
  const active = await fetchAll((a, b) =>
    admin.from("alerts").select("*").eq("workspace_id", workspaceId).in("status", ACTIVE).order("created_at").range(a, b),
  );
  for (const a of active) loaded.set(a.id, a);
  const keys = candidates.map((c) => c.dedupeKey);
  for (let i = 0; i < keys.length; i += 100) {
    const rows = must(
      await admin.from("alerts").select("*").eq("workspace_id", workspaceId).in("dedupe_key", keys.slice(i, i + 100)),
      "Load alerts",
    );
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
        await admin.from("alerts").update(freshFields).eq("id", prior.id);
      } else if (!othersActive) {
        // The condition came back within the same cycle: reopen quietly.
        await admin.from("alerts").update({ ...freshFields, status: "open", resolved_at: null }).eq("id", prior.id);
      }
      continue;
    }

    const muted = groupAlerts.some((a) => a.muted_until && Date.parse(a.muted_until) > now.getTime());
    const rule = ruleBy.get(c.category);
    const { data: inserted, error } = await admin
      .from("alerts")
      .insert({
        workspace_id: workspaceId,
        rule_id: rule?.id ?? null,
        category: c.category,
        severity: c.severity,
        status: muted ? "muted" : "open",
        muted_until: muted ? groupAlerts.find((a) => a.muted_until)?.muted_until : null,
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
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") continue; // a concurrent run created it first
      throw new Error(`Creating alert failed: ${error.message}`);
    }
    created++;

    // Escalation: the new alert supersedes less or equally severe active alerts in its group.
    const supersede = groupAlerts.filter(
      (a) => ACTIVE.includes(a.status) && SEVERITY_RANK[a.severity as Severity] <= SEVERITY_RANK[c.severity],
    );
    if (supersede.length) {
      await admin.from("alerts").update({ status: "superseded" }).in("id", supersede.map((a) => a.id));
    }

    if (!muted) await queueDeliveries(admin, data, inserted, rule);
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
  if (toResolve.length) {
    await admin.from("alerts").update({ status: "resolved", resolved_at: nowIso }).in("id", toResolve.map((a) => a.id));
  }
  return created;
}

async function queueDeliveries(admin: AdminClient, data: WorkspaceData, alert: AlertRow, rule: Tables["alert_rules"]["Row"] | undefined) {
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

  await admin.from("notification_deliveries").upsert(
    [
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
    ],
    { onConflict: "alert_id,channel", ignoreDuplicates: true },
  );
}
