import { ExternalLink, Gauge } from "lucide-react";
import Link from "next/link";
import { BreakdownChart, type TrendPoint, UsageTrendChart } from "@/components/charts";
import { SubmitButton } from "@/components/form-controls";
import { SourceBadge, UsageBar } from "@/components/status";
import { formatDate, TimeAgo } from "@/components/time";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Flash, LinkButton, Notice, PageHeader, Select, StatCard, Table, Td, Th } from "@/components/ui";
import {
  type Inventory,
  isAtRisk,
  loadInventory,
  loadQuotaViews,
  loadSamples,
  type QuotaView,
  riskScore,
  seriesFor,
  toPoints,
} from "@/lib/data/views";
import { forecast as runForecast, type Forecast } from "@/lib/engine/forecast";
import { isStale } from "@/lib/engine/health";
import { billingCycle, DAY_MS, dayKey, startOfUtcDay } from "@/lib/engine/time";
import { currentUsage } from "@/lib/engine/usage";
import { getAdapter, getMetric, PROVIDER_NAMES } from "@/lib/providers/registry";
import { formatCost } from "@/lib/currency";
import { getDisplay } from "@/lib/currency-server";
import { getSession } from "@/lib/session";
import type { MetricDefinition } from "@/lib/types";
import { formatPercent, formatValue } from "@/lib/units";
import { applyPlanAllowance, deleteQuota } from "./actions";
import { QuotaForm } from "./quota-form";

export const metadata = { title: "Usage explorer" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const EFFECT: Record<string, string> = {
  charges: "Usage above the limit is billed",
  restriction: "Exceeding restricts the service (no charge)",
  both: "Billed or restricted, depending on plan settings",
  none: "Your own budget; no provider effect",
  unknown: "Provider effect unknown",
};
const DIMENSION_LABELS: Record<string, string> = { rest: "REST", auth: "Auth", storage: "Storage", realtime: "Realtime" };

function scopeOptions(inv: Inventory, metric: MetricDefinition) {
  const resources = inv.resources.filter((r) => r.is_monitored && r.status === "active" && r.provider === metric.provider);
  const accounts = inv.accounts.filter((a) => resources.some((r) => r.account_id === a.id));
  return [
    ...(metric.scopeLevel === "resource" ? resources.map((r) => ({ value: `r:${r.id}`, label: r.name, group: "Resources" })) : []),
    ...accounts.map((a) => ({ value: `a:${a.id}`, label: `${a.name} (all monitored projects)`, group: "Organizations" })),
  ];
}

export default async function UsagePage({ searchParams }: PageProps<"/usage">) {
  const sp = await searchParams;
  const { scope: wsScope, workspace } = await getSession();
  const { display } = await getDisplay();
  const inv = await loadInventory(wsScope);
  const quotas = await loadQuotaViews(wsScope, inv);
  const monitored = inv.resources.filter((r) => r.is_monitored && r.status === "active");

  if (monitored.length === 0) {
    return (
      <>
        <PageHeader title="Usage explorer" />
        <Card>
          <EmptyState icon={<Gauge className="size-8" />} title="Nothing is monitored yet" action={<LinkButton href="/providers" variant="primary">Go to Providers</LinkButton>}>
            Connect a provider and choose resources to monitor. Usage history appears after the first collection.
          </EmptyState>
        </Card>
      </>
    );
  }

  const providers = [...new Set(monitored.map((r) => r.provider))];
  const metricOptions = providers.flatMap((p) => getAdapter(p)?.metrics ?? []);
  const topRisk = quotas.filter((q) => q.evaluation?.isEffective && q.evaluation.current !== null).sort((a, b) => riskScore(b) - riskScore(a))[0];

  let metric = getMetric(str(sp.metric));
  if (!metric || !metricOptions.some((m) => m.key === metric!.key)) {
    metric = topRisk?.metric ?? metricOptions.find((m) => m.supported) ?? metricOptions[0];
  }
  const scopes = scopeOptions(inv, metric);
  let scope = str(sp.scope);
  if (!scopes.some((s) => s.value === scope)) {
    const fromRisk = topRisk && topRisk.metricKey === metric.key ? (topRisk.resourceId ? `r:${topRisk.resourceId}` : `a:${topRisk.accountId}`) : null;
    scope = fromRisk && scopes.some((s) => s.value === fromRisk) ? fromRisk : (scopes[0]?.value ?? "");
  }
  const range = [7, 30, 90].includes(Number(sp.range)) ? Number(sp.range) : 30;
  const here = `/usage?${new URLSearchParams({ metric: metric.key, scope, range: String(range) })}`;

  const picker = (
    <Card className="mb-4 p-3">
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
        <Select name="metric" defaultValue={metric.key} aria-label="Metric">
          {providers.map((p) => (
            <optgroup key={p} label={PROVIDER_NAMES[p] ?? p}>
              {(getAdapter(p)?.metrics ?? []).map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                  {m.supported ? "" : " (unsupported)"}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select name="scope" defaultValue={scope} aria-label="Scope">
          {["Resources", "Organizations"].map((g) => {
            const opts = scopes.filter((s) => s.group === g);
            return opts.length ? (
              <optgroup key={g} label={g}>
                {opts.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </Select>
        <Select name="range" defaultValue={String(range)} aria-label="Time range">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
        <Button type="submit" variant="primary">
          Show
        </Button>
      </form>
    </Card>
  );

  const header = (
    <PageHeader
      title="Usage explorer"
      description="Stored history for each metric, compared against the applicable limit. Projections are estimates, not guarantees."
      actions={<LinkButton href="/usage/quotas">Manage limits</LinkButton>}
    />
  );

  if (!metric.supported) {
    return (
      <>
        {header}
        {picker}
        <Notice tone="neutral" title={`${metric.name} is not available from ${PROVIDER_NAMES[metric.provider]}`}>
          {metric.unsupportedReason} Limit Gauge shows this as unsupported instead of guessing or showing zero.
        </Notice>
      </>
    );
  }
  if (!scope) {
    return (
      <>
        {header}
        {picker}
        <Notice tone="neutral">No monitored scope reports this metric.</Notice>
      </>
    );
  }

  // ---- Resolve scope ----------------------------------------------------------
  const now = new Date();
  const scopeType = scope.startsWith("a:") ? "account" : "resource";
  const scopeId = scope.slice(2);
  const resource = scopeType === "resource" ? inv.resourceById.get(scopeId) : undefined;
  const account = inv.accountById.get(scopeType === "account" ? scopeId : (resource?.account_id ?? ""));
  const connection = inv.connectionById.get(resource?.connection_id ?? account?.connection_id ?? "");
  const anchor = account?.billing_cycle_anchor_day ?? 1;
  const cycle = billingCycle(now, anchor);
  const scopeResources =
    scopeType === "resource" ? (resource ? [resource] : []) : monitored.filter((r) => r.account_id === scopeId && r.provider === metric!.provider);
  const scopeIds = metric.scopeLevel === "account" ? [scopeId] : scopeResources.map((r) => r.id);
  const totalInAccount = scopeType === "account" ? inv.resources.filter((r) => r.account_id === scopeId && r.status === "active").length : 1;

  const from = new Date(Math.min(startOfUtcDay(now).getTime() - (range - 1) * DAY_MS, cycle.start.getTime()));
  const rows = await loadSamples(
    wsScope,
    metric.scopeLevel === "account" ? { metricKeys: [metric.key], accountIds: [scopeId], from } : { metricKeys: [metric.key], resourceIds: scopeIds, from },
  );
  const points = toPoints(rows);
  const daily = seriesFor(metric, rows, scopeIds, from, now);

  // ---- Quotas for this scope --------------------------------------------------
  const sameScope = (q: QuotaView) => q.metricKey === metric!.key && (scopeType === "resource" ? q.resourceId === scopeId : q.accountId === scopeId);
  const scopeQuotas = quotas.filter(sameScope);
  const effective = scopeQuotas.find((q) => q.evaluation?.isEffective) ?? scopeQuotas.find((q) => q.source === "user") ?? scopeQuotas[0];
  const userQuota = scopeQuotas.find((q) => q.source === "user");
  const providerQuota = scopeQuotas.find((q) => q.source === "provider");
  const sharedQuota =
    scopeType === "resource" ? quotas.find((q) => q.metricKey === metric!.key && q.accountId === resource?.account_id && q.evaluation?.isEffective) : undefined;

  const usage = currentUsage(metric.aggregation, points, cycle, scopeIds);
  const limit = effective?.limit ?? null;
  const current = usage.value;
  const percent = limit !== null && current !== null && limit > 0 ? (current / limit) * 100 : null;
  const fc: Forecast | null =
    effective?.evaluation?.forecast ??
    (current !== null ? runForecast({ aggregation: metric.aggregation, daily, current, cycle, now, limit }) : null);
  const stale = isStale(usage.asOf, now, workspace.stale_after_hours);
  const isDemo = connection?.provider === "demo";
  const derivationBadge = isDemo ? "demo" : metric.derivation;

  // ---- Chart series -------------------------------------------------------------
  // Compare like with like: incremental metrics are shown as cycle-to-date totals
  // against the limit, alongside the daily amounts.
  const visibleFrom = dayKey(new Date(startOfUtcDay(now).getTime() - (range - 1) * DAY_MS));
  let running = 0;
  let runningCycle = "";
  const trend: TrendPoint[] = daily.map((d) => {
    let value = d.value;
    if (metric!.aggregation === "incremental") {
      const c = dayKey(billingCycle(new Date(`${d.day}T12:00:00Z`), anchor).start);
      if (c !== runningCycle) {
        running = 0;
        runningCycle = c;
      }
      running += d.value ?? 0;
      value = d.value === null ? null : running;
    }
    return { day: d.day, value, partial: !d.complete };
  });
  const today = dayKey(now);
  if (fc?.status === "ok" && fc.avgDaily !== null && current !== null) {
    const todayPoint = trend.find((p) => p.day === today);
    if (todayPoint) todayPoint.projected = current;
    for (let t = startOfUtcDay(now).getTime() + DAY_MS; t < cycle.end.getTime(); t += DAY_MS) {
      const days = (t + DAY_MS / 2 - now.getTime()) / DAY_MS;
      trend.push({ day: dayKey(new Date(t)), value: null, projected: Math.max(0, current + fc.avgDaily * days) });
    }
  }
  const visibleTrend = trend.filter((p) => p.day >= visibleFrom);
  const dailyVisible = daily.filter((d) => d.day >= visibleFrom);

  // Dimension breakdown (e.g. API requests by service)
  const dimRows = rows.filter((r) => r.dimensions && typeof r.dimensions === "object" && dayKey(new Date(r.bucket_start)) >= visibleFrom);
  const dimByDay = new Map<string, Record<string, number>>();
  for (const r of dimRows) {
    const day = dayKey(new Date(r.bucket_start));
    const acc = dimByDay.get(day) ?? {};
    for (const [k, v] of Object.entries(r.dimensions as Record<string, number>)) acc[k] = (acc[k] ?? 0) + Number(v);
    dimByDay.set(day, acc);
  }
  const dimKeys = [...new Set(dimRows.flatMap((r) => Object.keys(r.dimensions as object)))].slice(0, 4);
  const breakdown = [...dimByDay.entries()].sort().map(([day, v]) => ({ day, ...v }));

  // Per-resource contribution for organization scope
  const contributions =
    scopeType === "account" && metric.scopeLevel === "resource"
      ? scopeResources
          .map((r) => ({ r, u: currentUsage(metric!.aggregation, points, cycle, [r.id]).value }))
          .sort((a, b) => (b.u ?? -1) - (a.u ?? -1))
      : [];

  const allowance =
    !userQuota && account?.plan
      ? getAdapter(metric.provider)?.planAllowances.find((a) => a.plan === account.plan && a.metricKey === metric!.key && a.scope === scopeType)
      : undefined;
  const isCycleMetric = metric.aggregation !== "gauge";
  const cycleDay = Math.floor((now.getTime() - cycle.start.getTime()) / DAY_MS) + 1;
  const cycleLength = Math.round((cycle.end.getTime() - cycle.start.getTime()) / DAY_MS);

  return (
    <>
      {header}
      <Flash ok={sp.ok} error={sp.error} />
      {picker}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{metric.name}</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{resource?.name ?? account?.name}</span>
        <SourceBadge kind={derivationBadge} />
        {stale ? <SourceBadge kind="stale" /> : null}
        {resource?.dashboard_url ?? account?.dashboard_url ? (
          <a href={(resource?.dashboard_url ?? account?.dashboard_url)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            Provider dashboard <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>

      {scopeType === "account" && scopeResources.length < totalInAccount ? (
        <div className="mb-4">
          <Notice tone="warn">
            Only {scopeResources.length} of {totalInAccount} projects in this organization are monitored. Organization totals may be
            higher than shown.
          </Notice>
        </div>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={isCycleMetric ? "Usage this billing cycle" : "Latest reading"}
          value={current === null ? "No data" : formatValue(current, metric.unit)}
          hint={current === null ? "Not collected yet; not treated as zero." : metric.description}
        />
        <StatCard
          label="Limit"
          value={limit === null ? "Unknown" : formatValue(limit, metric.unit)}
          hint={
            <span className="flex flex-wrap items-center gap-1">
              <SourceBadge kind={!effective || limit === null ? "unknown" : effective.source} />
              {effective ? EFFECT[effective.overageEffect] : "Set a limit below to enable alerts."}
            </span>
          }
        />
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-muted">Used</p>
          <p className="num mt-1 text-2xl font-semibold">{formatPercent(percent)}</p>
          <div className="mt-2">
            <UsageBar percent={percent} projectedPercent={fc?.status === "ok" ? fc.projectedPercent : null} label={`${metric.name} used`} />
          </div>
          <p className="mt-1 text-xs text-muted">
            {limit !== null && current !== null ? `${formatValue(Math.max(0, limit - current), metric.unit)} remaining` : "—"}
          </p>
        </div>
        <StatCard
          label="Billing cycle"
          value={isCycleMetric ? `Day ${cycleDay} of ${cycleLength}` : "Not reset"}
          hint={isCycleMetric ? `Resets ${formatDate(cycle.end.toISOString())} (day ${anchor}, UTC)` : "Point-in-time measurement; it does not reset each cycle."}
        />
        <StatCard
          label="Forecast (estimate)"
          value={
            fc?.status === "ok" && fc.projected !== null
              ? formatValue(fc.projected, metric.unit)
              : fc?.status === "insufficient_data"
                ? "Not enough data"
                : fc?.status === "stale"
                  ? "Data too old"
                  : "—"
          }
          hint={
            fc?.status === "ok" ? (
              <>
                At cycle end{fc.projectedPercent !== null ? ` (${formatPercent(fc.projectedPercent)} of limit)` : ""} · {fc.confidence} confidence from {fc.observations} days
                {fc.crossingAt ? (
                  <span className="block font-medium text-warn">Limit expected around {formatDate(fc.crossingAt)}</span>
                ) : fc.alreadyExceeded ? (
                  <span className="block font-medium text-crit">Limit already exceeded</span>
                ) : null}
              </>
            ) : fc?.status === "insufficient_data" ? (
              `Needs at least 3 valid daily observations (have ${fc.observations}).`
            ) : fc?.status === "stale" ? (
              `Last valid observation ${fc.lastObservationDay}.`
            ) : (
              "No data yet."
            )
          }
        />
        <StatCard
          label="Data freshness"
          value={usage.asOf ? <TimeAgo iso={usage.asOf.toISOString()} /> : "—"}
          hint={
            <>
              Provider data timestamp
              {stale ? <span className="block text-warn">Older than your {workspace.stale_after_hours}h freshness threshold.</span> : null}
              {effective?.evaluation?.cost?.status === "estimated" ? (
                <span className="block">
                  Est. overage this cycle:{" "}
                  {formatCost(effective.evaluation.cost.projectedOverageCost ?? effective.evaluation.cost.currentOverageCost ?? 0, effective.evaluation.cost.currency!, display)} (projected)
                </span>
              ) : null}
            </>
          }
        />
      </div>

      <Card className="mb-6">
        <CardHeader
          title={metric.aggregation === "incremental" ? `${metric.name}, cycle-to-date` : metric.aggregation === "cumulative" ? `${metric.name}, cycle-to-date` : metric.name}
          description={
            <>
              Solid line: collected data. Dashed: projection to the end of the cycle (estimate).
              {limit !== null ? " Red dashed line: applicable limit." : " No limit is known for this scope."}
            </>
          }
        />
        <CardBody>
          {daily.every((d) => d.value === null) ? (
            <EmptyState title="No data in this range">Collection may not have run yet. Missing data is shown as a gap, not zero.</EmptyState>
          ) : (
            <UsageTrendChart points={visibleTrend} unit={metric.unit} limit={limit} limitLabel={effective?.source === "user" ? "Your limit" : "Limit"} seriesLabel={metric.name} />
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted">Show data table</summary>
            <Table className="mt-2 text-xs">
              <thead>
                <tr>
                  <Th>Day (UTC)</Th>
                  <Th className="text-right">{metric.aggregation === "incremental" ? "Daily usage" : "Value"}</Th>
                  <Th>Quality</Th>
                </tr>
              </thead>
              <tbody>
                {[...dailyVisible].reverse().map((d) => (
                  <tr key={d.day}>
                    <Td>{d.day}</Td>
                    <Td className="num text-right">{d.value === null ? "No data" : formatValue(d.value, metric!.unit)}</Td>
                    <Td className="text-muted">{d.value === null ? "missing" : d.complete ? "complete" : "partial"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        </CardBody>
      </Card>

      {metric.aggregation === "incremental" ? (
        <Card className="mb-6">
          <CardHeader title={`Daily ${metric.name.toLowerCase()}`} description="Usage per completed UTC day (today is still in progress and not shown)." />
          <CardBody>
            {breakdown.length && dimKeys.length ? (
              <BreakdownChart data={breakdown.filter((b) => b.day !== today)} keys={dimKeys} labels={DIMENSION_LABELS} unit={metric.unit} />
            ) : (
              <UsageTrendChart
                points={dailyVisible.filter((d) => d.day !== today).map((d) => ({ day: d.day, value: d.value, partial: !d.complete }))}
                unit={metric.unit}
                limit={null}
                seriesLabel={`Daily ${metric.name.toLowerCase()}`}
                height={200}
              />
            )}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Limit for this scope" description={scopeType === "account" ? "Applies to the organization as a whole." : "Applies to this resource only."} />
          <CardBody className="space-y-4">
            {providerQuota ? (
              <Notice tone="neutral" title={`Provider-reported limit: ${formatValue(providerQuota.limit, metric.unit)}`}>
                {providerQuota.notes} Verified <TimeAgo iso={providerQuota.verifiedAt} />.
                {userQuota ? " Your own limit below takes precedence." : ""}
              </Notice>
            ) : null}
            {allowance ? (
              <Notice tone="info" title={`Suggested ${account?.plan} plan allowance: ${formatValue(allowance.limit, metric.unit)}`}>
                {allowance.note} From{" "}
                <a className="underline" href={allowance.sourceUrl} target="_blank" rel="noreferrer">
                  provider documentation
                </a>{" "}
                (verified {allowance.verifiedAt}). It is only used after you confirm it.
                <form action={applyPlanAllowance} className="mt-2">
                  <input type="hidden" name="provider" value={metric.provider} />
                  <input type="hidden" name="plan" value={allowance.plan} />
                  <input type="hidden" name="metricKey" value={metric.key} />
                  <input type="hidden" name="scopeType" value={scopeType} />
                  <input type="hidden" name="scopeId" value={scopeId} />
                  <input type="hidden" name="back" value={here} />
                  <SubmitButton size="sm" pendingText="Applying…">
                    Confirm and use this limit
                  </SubmitButton>
                </form>
              </Notice>
            ) : null}
            {userQuota ? (
              <>
                <QuotaForm
                  metricKey={metric.key}
                  unit={metric.unit}
                  scopeType={scopeType}
                  scopeId={scopeId}
                  back={here}
                  quotaId={userQuota.id}
                  defaults={{
                    limit: userQuota.limit === null ? "" : formatValue(userQuota.limit, metric.unit).replace(/,/g, ""),
                    overageEffect: userQuota.overageEffect,
                    notes: userQuota.notes,
                    thresholds: Array.isArray(userQuota.thresholds)
                      ? (userQuota.thresholds as { percent: number; severity: string }[]).map((t) => `${t.percent}:${t.severity}`).join(", ")
                      : "",
                  }}
                />
                <form action={deleteQuota}>
                  <input type="hidden" name="quotaId" value={userQuota.id} />
                  <input type="hidden" name="back" value={here} />
                  <SubmitButton variant="ghost" size="sm" confirm="Remove your limit for this scope?">
                    Remove my limit
                  </SubmitButton>
                </form>
              </>
            ) : (
              <details open={!effective}>
                <summary className="cursor-pointer text-sm font-medium">{effective ? "Override with your own limit" : "Set your own limit"}</summary>
                <div className="mt-3">
                  <QuotaForm metricKey={metric.key} unit={metric.unit} scopeType={scopeType} scopeId={scopeId} back={here} />
                </div>
              </details>
            )}
          </CardBody>
        </Card>

        {sharedQuota ? (
          <Card>
            <CardHeader title="Shared organization quota" description="This project's usage counts toward an organization-wide allowance." />
            <CardBody className="space-y-2">
              <p className="text-sm">
                {sharedQuota.scopeName}: {formatValue(sharedQuota.evaluation?.current, metric.unit)} of {formatValue(sharedQuota.limit, metric.unit)}
              </p>
              <UsageBar percent={sharedQuota.evaluation?.percent ?? null} label="Organization quota used" />
              <p className="text-xs text-muted">Shared quotas are not attributed to individual applications.</p>
              <LinkButton size="sm" href={`/usage?${new URLSearchParams({ metric: metric.key, scope: `a:${sharedQuota.accountId}`, range: String(range) })}`}>
                View organization
              </LinkButton>
            </CardBody>
          </Card>
        ) : contributions.length ? (
          <Card>
            <CardHeader title="Contribution by project" description="Cycle-to-date usage of each monitored project." />
            <Table>
              <tbody>
                {contributions.map(({ r, u }) => (
                  <tr key={r.id}>
                    <Td>
                      <Link className="hover:underline" href={`/usage?${new URLSearchParams({ metric: metric.key, scope: `r:${r.id}`, range: String(range) })}`}>
                        {r.name}
                      </Link>
                      {inv.appByResource.get(r.id) ? <span className="block text-xs text-muted">{inv.appByResource.get(r.id)!.name}</span> : null}
                    </Td>
                    <Td className="num text-right">{u === null ? <Badge>No data</Badge> : formatValue(u, metric.unit)}</Td>
                    <Td className="num w-20 text-right text-xs text-muted">{u !== null && current ? formatPercent((u / current) * 100) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Other metrics at risk" />
            <ul className="divide-y divide-border">
              {quotas
                .filter((q) => isAtRisk(q) && !sameScope(q))
                .sort((a, b) => riskScore(b) - riskScore(a))
                .slice(0, 5)
                .map((q) => (
                  <li key={q.id} className="px-4 py-2.5">
                    <Link
                      className="text-sm font-medium hover:underline"
                      href={`/usage?${new URLSearchParams({ metric: q.metricKey, scope: q.resourceId ? `r:${q.resourceId}` : `a:${q.accountId}` })}`}
                    >
                      {q.metricName} · {q.scopeName}
                      {q.scopeType === "account" ? <span className="font-normal text-muted"> (organization-wide)</span> : null}
                    </Link>
                    <div className="mt-1">
                      <UsageBar percent={q.evaluation?.percent ?? null} label={`${q.metricName} used`} />
                    </div>
                  </li>
                ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
