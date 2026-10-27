import type { AlertCategory, ConnectionStatus, OverageEffect, Severity, Threshold, Unit } from "../types";
import { SEVERITY_RANK } from "../types";
import type { CostEstimate } from "./cost";
import type { Forecast } from "./forecast";
import { HOUR_MS, type Cycle } from "./time";

/** Highest threshold reached by `percent`, or null when below all thresholds. */
export function highestCrossed(percent: number, thresholds: Threshold[]): Threshold | null {
  let best: Threshold | null = null;
  for (const t of thresholds) {
    if (percent >= t.percent && (!best || t.percent > best.percent)) best = t;
  }
  return best;
}

export function normalizeThresholds(input: unknown): Threshold[] | null {
  if (!Array.isArray(input)) return null;
  const valid = input.filter(
    (t): t is Threshold =>
      !!t &&
      typeof t === "object" &&
      typeof (t as Threshold).percent === "number" &&
      (t as Threshold).percent > 0 &&
      (t as Threshold).percent <= 1000 &&
      (t as Threshold).severity in SEVERITY_RANK,
  );
  return valid.length ? [...valid].sort((a, b) => a.percent - b.percent) : null;
}

export interface QuotaStateForAlerts {
  quotaId: string;
  metricKey: string;
  metricName: string;
  unit: Unit;
  scopeName: string;
  providerLabel: string;
  connectionId: string;
  accountId: string | null;
  resourceId: string | null;
  applicationId: string | null;
  applicationName: string | null;
  limit: number | null;
  current: number | null;
  percent: number | null;
  cycle: Cycle;
  dataUpdatedAt: Date | null;
  stale: boolean;
  partialCoverage: boolean;
  overageEffect: OverageEffect;
  thresholds: Threshold[];
  forecast: Forecast | null;
  cost: CostEstimate | null;
  recommendedAction: string;
}

export interface ConnectionForAlerts {
  id: string;
  label: string;
  providerName: string;
  status: ConnectionStatus;
  statusDetail: string | null;
  statusChangedAt: Date;
  lastSuccessAt: Date | null;
  createdAt: Date;
}

export interface AlertRuleSettings {
  enabled: boolean;
}

export interface AlertCandidate {
  category: AlertCategory;
  severity: Severity;
  dedupeKey: string;
  groupKey: string;
  title: string;
  message: string;
  recommendedAction: string;
  connectionId: string | null;
  accountId: string | null;
  resourceId: string | null;
  applicationId: string | null;
  quotaRuleId: string | null;
  metricKey: string | null;
  currentValue: number | null;
  limitValue: number | null;
  unit: Unit | null;
  percentUsed: number | null;
  cycleStart: string | null;
  cycleResetAt: string | null;
  forecastBreachAt: string | null;
  dataUpdatedAt: string | null;
  details: Record<string, unknown>;
}

export interface EvaluationInput {
  now: Date;
  staleAfterHours: number;
  rules: Record<AlertCategory, AlertRuleSettings>;
  quotas: QuotaStateForAlerts[];
  connections: ConnectionForAlerts[];
  format: (value: number, unit: Unit) => string;
}

export interface EvaluationResult {
  candidates: AlertCandidate[];
  /** Groups whose condition was evaluated with usable data; open alerts in these groups that are no longer active can be resolved. */
  evaluatedGroups: Set<string>;
}

const SEVERITY_WORD: Record<Severity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
  limit_reached: "Limit reached",
};

const FAILURE_TEXT: Partial<Record<ConnectionStatus, { title: string; action: string; severity: Severity }>> = {
  reauth_required: {
    title: "needs reauthorization",
    action: "Open the connection on the Providers page and reauthorize it. Monitoring is paused until then.",
    severity: "critical",
  },
  permission_insufficient: {
    title: "is missing permissions",
    action: "Reconnect with the read permissions listed on the connection page.",
    severity: "critical",
  },
  error: {
    title: "is failing to sync",
    action: "Check the provider's status page. CloudWatch retries automatically with backoff; reconnect if the problem persists.",
    severity: "warning",
  },
  unsupported_capability: {
    title: "cannot collect some metrics",
    action: "Review the connection's capabilities and configure limits manually where data is unavailable.",
    severity: "warning",
  },
};

function base(q: QuotaStateForAlerts) {
  return {
    connectionId: q.connectionId,
    accountId: q.accountId,
    resourceId: q.resourceId,
    applicationId: q.applicationId,
    quotaRuleId: q.quotaId,
    metricKey: q.metricKey,
    currentValue: q.current,
    limitValue: q.limit,
    unit: q.unit,
    percentUsed: q.percent,
    cycleStart: q.cycle.start.toISOString(),
    cycleResetAt: q.cycle.end.toISOString(),
    dataUpdatedAt: q.dataUpdatedAt?.toISOString() ?? null,
  };
}

function scopeText(q: QuotaStateForAlerts) {
  return q.applicationName ? `${q.scopeName} (${q.applicationName})` : q.scopeName;
}

export function evaluateAlerts(input: EvaluationInput): EvaluationResult {
  const { now, rules, quotas, connections, format, staleAfterHours } = input;
  const candidates: AlertCandidate[] = [];
  const evaluatedGroups = new Set<string>();

  for (const q of quotas) {
    if (q.limit === null || q.current === null) continue; // unknown limit or no data: never guess
    const cycleKey = q.cycle.start.toISOString();
    const caveats: string[] = [];
    if (q.stale) caveats.push("Data is stale; the latest successful reading is shown.");
    if (q.partialCoverage) caveats.push("Not every resource in this billing scope is monitored, so actual usage may be higher.");

    // 1. Quota thresholds
    if (rules.quota_threshold.enabled && q.percent !== null) {
      const group = `quota:${q.quotaId}:${cycleKey}`;
      evaluatedGroups.add(group);
      const crossed = highestCrossed(q.percent, q.thresholds);
      if (crossed) {
        const usageText = `${format(q.current, q.unit)} of ${format(q.limit, q.unit)} (${q.percent.toFixed(1)}%)`;
        candidates.push({
          ...base(q),
          category: "quota_threshold",
          severity: crossed.severity,
          groupKey: group,
          dedupeKey: `${group}:${crossed.percent}`,
          title:
            crossed.severity === "limit_reached"
              ? `${q.metricName} limit reached for ${scopeText(q)}`
              : `${q.metricName} at ${crossed.percent}% for ${scopeText(q)}`,
          message: `${q.providerLabel}: ${usageText}. ${effectText(q.overageEffect)}${caveats.length ? " " + caveats.join(" ") : ""}`,
          recommendedAction: q.recommendedAction,
          forecastBreachAt: q.forecast?.crossingAt ?? null,
          details: { threshold: crossed.percent, stale: q.stale, partialCoverage: q.partialCoverage },
        });
      }
    }

    // 2. Forecasted limit breach
    if (rules.forecast_breach.enabled && q.forecast && q.forecast.status === "ok") {
      const group = `forecast:${q.quotaId}:${cycleKey}`;
      evaluatedGroups.add(group);
      if (!q.forecast.alreadyExceeded && q.forecast.crossingAt) {
        const daysLeft = (Date.parse(q.forecast.crossingAt) - now.getTime()) / (24 * HOUR_MS);
        const severity: Severity = daysLeft <= 3 ? "critical" : "warning";
        const when = q.forecast.crossingAt.slice(0, 10);
        candidates.push({
          ...base(q),
          category: "forecast_breach",
          severity,
          groupKey: group,
          dedupeKey: `${group}:${severity}`,
          title: `${q.metricName} projected to exceed its limit for ${scopeText(q)}`,
          message:
            `Estimate: at the recent average of ${format(Math.max(0, q.forecast.avgDaily ?? 0), q.unit)}/day, ` +
            `usage is expected to cross ${format(q.limit, q.unit)} around ${when} ` +
            `(${q.forecast.confidence} confidence, ${q.forecast.observations} daily observations). ` +
            `This is a projection, not a guarantee.`,
          recommendedAction: q.recommendedAction,
          forecastBreachAt: q.forecast.crossingAt,
          details: { forecast: q.forecast },
        });
      }
    }

    // 3. Projected cost overage (estimates only; never presented as a billed amount)
    if (rules.cost_overage.enabled && q.cost?.status === "estimated") {
      const group = `cost:${q.quotaId}:${cycleKey}`;
      evaluatedGroups.add(group);
      const currentCost = q.cost.currentOverageCost ?? 0;
      const projectedCost = q.cost.projectedOverageCost ?? 0;
      if (currentCost > 0 || projectedCost > 0) {
        const severity: Severity = currentCost > 0 ? "critical" : "warning";
        const money = (n: number) => `${n.toFixed(2)} ${q.cost!.currency}`;
        candidates.push({
          ...base(q),
          category: "cost_overage",
          severity,
          groupKey: group,
          dedupeKey: `${group}:${severity}`,
          title: `Estimated overage charges for ${q.metricName} on ${scopeText(q)}`,
          message:
            (currentCost > 0
              ? `Usage above the included allowance so far is estimated at ${money(currentCost)}. `
              : "") +
            (q.cost.projectedOverageCost !== undefined
              ? `If the current trend continues, the estimate for this cycle is ${money(projectedCost)}. `
              : "") +
            `Calculated from pricing rule ${q.cost.pricingVersion} (verified ${q.cost.verifiedAt}); your invoice is authoritative.`,
          recommendedAction: q.recommendedAction,
          forecastBreachAt: q.forecast?.crossingAt ?? null,
          details: { cost: q.cost },
        });
      }
    }
  }

  // 4. Monitoring / integration failures
  if (rules.integration_health.enabled) {
    for (const c of connections) {
      if (c.status === "disconnected") continue;
      const group = `integration:${c.id}`;
      evaluatedGroups.add(group);
      const failure = FAILURE_TEXT[c.status];
      const common = {
        category: "integration_health" as const,
        groupKey: group,
        connectionId: c.id,
        accountId: null,
        resourceId: null,
        applicationId: null,
        quotaRuleId: null,
        metricKey: null,
        currentValue: null,
        limitValue: null,
        unit: null,
        percentUsed: null,
        cycleStart: null,
        cycleResetAt: null,
        forecastBreachAt: null,
        dataUpdatedAt: c.lastSuccessAt?.toISOString() ?? null,
      };
      if (failure) {
        candidates.push({
          ...common,
          severity: failure.severity,
          dedupeKey: `${group}:${c.status}:${c.statusChangedAt.toISOString()}`,
          title: `${c.providerName} connection “${c.label}” ${failure.title}`,
          message:
            `${c.statusDetail ?? "The provider rejected CloudWatch's request."} ` +
            `Usage shown for this connection is no longer current; missing data is not treated as zero usage.`,
          recommendedAction: failure.action,
          details: { status: c.status },
        });
        continue;
      }
      const reference = c.lastSuccessAt ?? c.createdAt;
      if (now.getTime() - reference.getTime() > staleAfterHours * HOUR_MS) {
        candidates.push({
          ...common,
          severity: "warning",
          dedupeKey: `${group}:stale:${c.lastSuccessAt?.toISOString() ?? "never"}`,
          title: `Monitoring data for “${c.label}” is stale`,
          message: c.lastSuccessAt
            ? `The last successful sync was at ${c.lastSuccessAt.toISOString()}, more than ${staleAfterHours} hours ago.`
            : `This connection has not completed a successful sync in the last ${staleAfterHours} hours.`,
          recommendedAction: "Run a manual sync from the Providers page and check the sync history for errors.",
          details: { staleAfterHours },
        });
      }
    }
  }

  return { candidates, evaluatedGroups };
}

function effectText(effect: OverageEffect): string {
  switch (effect) {
    case "charges":
      return "Usage above this allowance is billed.";
    case "restriction":
      return "Exceeding this allowance can restrict the service (no charge).";
    case "both":
      return "Exceeding this allowance can cause charges or service restrictions depending on plan settings.";
    case "none":
      return "Exceeding this limit has no provider-side effect; it is your own threshold.";
    default:
      return "The provider-side consequence of exceeding this limit is unknown.";
  }
}
