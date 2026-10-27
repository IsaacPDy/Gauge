import { ArrowRight, Boxes, Cloud, Gauge, Siren } from "lucide-react";
import Link from "next/link";
import { UsageTrendChart } from "@/components/charts";
import { ConnectionStatusBadge, RiskLabel, SeverityBadge, SourceBadge, UsageBar } from "@/components/status";
import { formatDate, TimeAgo } from "@/components/time";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Flash, LinkButton, PageHeader, Select, StatCard, Table, Td, Th } from "@/components/ui";
import { isAtRisk, isSyncing, loadInventory, loadQuotaViews, loadSamples, riskScore, seriesFor } from "@/lib/data/views";
import { totalsByCurrency } from "@/lib/engine/cost";
import { connectionHealth } from "@/lib/engine/health";
import { DAY_MS, startOfUtcDay } from "@/lib/engine/time";
import { demoEnabled, getAdapter, getMetric, PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import type { ConnectionStatus } from "@/lib/types";
import { formatMoney, formatPercent, formatValue } from "@/lib/units";

export const metadata = { title: "Home" };

const STEPS = [
  { title: "Connect a provider", body: "Authorize read-only access to Supabase.", href: "/providers" },
  { title: "Choose resources", body: "Pick the projects CloudWatch should monitor.", href: "/providers/resources" },
  { title: "Group into applications", body: "Organize resources by the product they serve.", href: "/applications" },
  { title: "Confirm limits", body: "Load provider limits or set your own thresholds.", href: "/usage/quotas" },
];

export default async function HomePage({ searchParams }: PageProps<"/home">) {
  const sp = await searchParams;
  const { supabase, workspace } = await getSession();
  const inv = await loadInventory(supabase);
  const now = new Date();

  if (inv.connections.length === 0) {
    return (
      <>
        <PageHeader title="Welcome to CloudWatch" description="Know what your applications consume and get early warnings before limits or unexpected costs." />
        <Flash ok={sp.ok} error={sp.error} />
        <Card>
          <CardHeader title="Get started" description="Four steps to your first dashboard." />
          <ol className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="bg-surface p-4">
                <p className="num text-xs font-semibold text-accent">Step {i + 1}</p>
                <p className="mt-1 font-medium">{s.title}</p>
                <p className="mt-1 text-sm text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
          <CardBody className="flex flex-wrap gap-2 border-t border-border">
            <LinkButton href="/providers/connect/supabase" variant="primary">
              Connect Supabase
            </LinkButton>
            {demoEnabled() ? <LinkButton href="/providers">Try the demo provider</LinkButton> : null}
          </CardBody>
        </Card>
        <p className="mt-4 text-xs text-muted">
          CloudWatch monitors and forecasts. It never shuts down services or changes plans, and its alerts are not spending caps.
        </p>
      </>
    );
  }

  const quotas = await loadQuotaViews(supabase, inv);
  const [{ data: openAlerts }, { data: costs }] = await Promise.all([
    supabase.from("alerts").select("*").in("status", ["open", "acknowledged"]).order("created_at", { ascending: false }).limit(200),
    supabase.from("cost_records").select("*").gt("period_end", now.toISOString()),
  ]);

  const active = inv.connections.filter((c) => c.status !== "disconnected");
  const health = active.map((c) => ({
    c,
    h: connectionHealth(
      { status: c.status as ConnectionStatus, lastSuccessAt: c.last_success_at ? new Date(c.last_success_at) : null, createdAt: new Date(c.created_at), consecutiveFailures: c.consecutive_failures },
      now,
      workspace.stale_after_hours,
    ),
  }));
  const unhealthy = health.filter((x) => x.h.state === "failing" || x.h.state === "stale");
  const monitored = inv.resources.filter((r) => r.is_monitored && r.status === "active");
  const alerts = openAlerts ?? [];
  const critical = alerts.filter((a) => a.severity === "critical" || a.severity === "limit_reached").length;

  const reported = totalsByCurrency((costs ?? []).filter((c) => c.kind === "reported").map((c) => ({ amount: Number(c.amount), currency: c.currency })));
  const projected = totalsByCurrency((costs ?? []).filter((c) => c.kind === "projected").map((c) => ({ amount: Number(c.amount), currency: c.currency })));
  const money = (t: Record<string, number>) => Object.entries(t).map(([cur, v]) => formatMoney(v, cur)).join(" + ");

  const risks = quotas.filter(isAtRisk).sort((a, b) => riskScore(b) - riskScore(a)).slice(0, 8);

  // Usage section: a selectable trend summed across monitored resources of one provider.
  const trendChoices = [...new Set(monitored.map((r) => r.provider))].flatMap(
    (p) => getAdapter(p)?.metrics.filter((m) => m.supported && m.scopeLevel === "resource") ?? [],
  );
  const trendMetric = getMetric(typeof sp.trend === "string" ? sp.trend : "") ?? trendChoices.find((m) => m.aggregation === "incremental") ?? trendChoices[0];
  const trendScope = trendMetric ? monitored.filter((r) => r.provider === trendMetric.provider).map((r) => r.id) : [];
  const from = new Date(startOfUtcDay(now).getTime() - 29 * DAY_MS);
  const trendRows = trendMetric && trendScope.length ? await loadSamples(supabase, { metricKeys: [trendMetric.key], resourceIds: trendScope, from }) : [];
  const today = new Date().toISOString().slice(0, 10);
  // Today's daily total is still accumulating; showing it would look like a sudden drop.
  const trend = trendMetric
    ? seriesFor(trendMetric, trendRows, trendScope, from, now).filter((d) => trendMetric.aggregation !== "incremental" || d.day !== today)
    : [];

  return (
    <>
      <PageHeader title="Home" description={`Overview of ${workspace.name}. All figures come from stored snapshots; no provider is queried while you browse.`} />
      <Flash ok={sp.ok} error={sp.error} />

      <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Applications" value={inv.applications.length} href="/applications" hint={`${inv.resources.filter((r) => !inv.appByResource.has(r.id) && r.is_monitored).length} monitored resources unassigned`} />
        <StatCard
          label="Connected providers"
          value={active.length}
          href="/providers"
          hint={unhealthy.length ? <span className="text-crit">{unhealthy.length} need attention</span> : "All healthy"}
        />
        <StatCard label="Monitored resources" value={monitored.length} href="/providers/resources" hint={`of ${inv.resources.filter((r) => r.status === "active").length} discovered`} />
        <StatCard label="Active warnings" value={alerts.length} href="/alerts" hint={critical ? <span className="text-crit">{critical} critical</span> : "None critical"} />
        <StatCard
          label="Spending this cycle"
          value={Object.keys(reported).length ? money(reported) : "Unavailable"}
          hint={
            <>
              {Object.keys(reported).length ? "Reported by provider" : "No provider reports spend"}
              {Object.keys(projected).length ? (
                <span className="block">
                  Est. projected overage: {money(projected)} <span className="text-faint">(estimate)</span>
                </span>
              ) : null}
            </>
          }
        />
      </section>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Needs attention" description="Limits that are 50%+ used, projected to be exceeded, or likely to cost extra." actions={<LinkButton size="sm" href="/usage/quotas">All limits</LinkButton>} />
          {risks.length === 0 ? (
            <EmptyState icon={<Gauge className="size-7" />} title="Nothing is close to its limit">
              {quotas.length === 0 ? (
                <>
                  No limits configured yet.{" "}
                  <Link href="/usage/quotas" className="text-accent hover:underline">
                    Confirm plan allowances
                  </Link>{" "}
                  to enable alerts.
                </>
              ) : null}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {risks.map((q) => {
                const e = q.evaluation!;
                const f = e.forecast;
                return (
                  <li key={q.id}>
                    <Link
                      href={`/usage?${new URLSearchParams({ metric: q.metricKey, scope: q.resourceId ? `r:${q.resourceId}` : `a:${q.accountId}` })}`}
                      className="block px-4 py-3 hover:bg-surface-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {q.metricName} <span className="font-normal text-muted">· {q.scopeName}{q.scopeType === "account" ? " (organization-wide)" : ""}</span>
                          {q.application ? <span className="font-normal text-muted"> · {q.application.name}</span> : null}
                        </p>
                        <span className="flex items-center gap-1.5">
                          {q.isDemo ? <SourceBadge kind="demo" /> : null}
                          {e.dataState === "stale" ? <SourceBadge kind="stale" /> : null}
                          <RiskLabel percent={e.percent} projectedBreach={f?.status === "ok" && !!f.crossingAt} />
                        </span>
                      </div>
                      <div className="mt-2">
                        <UsageBar percent={e.percent} projectedPercent={f?.status === "ok" ? f.projectedPercent : null} label={`${q.metricName} used`} />
                      </div>
                      <p className="num mt-1 text-xs text-muted">
                        {formatValue(e.current, q.unit)} of {formatValue(q.limit, q.unit)}
                        {f?.status === "ok" && f.crossingAt ? <span className="text-warn"> · limit expected around {formatDate(f.crossingAt)} (estimate)</span> : null}
                        {f?.status === "ok" && !f.crossingAt && f.projectedPercent !== null ? ` · projected ${formatPercent(f.projectedPercent)} at cycle end` : null}
                        {e.cost?.status === "estimated" && (e.cost.projectedOverageCost ?? 0) > 0 ? ` · est. overage ${formatMoney(e.cost.projectedOverageCost!, e.cost.currency!)}` : null}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Monitoring health" />
            <ul className="divide-y divide-border">
              {health.map(({ c, h }) => (
                <li key={c.id}>
                  <Link href={`/providers/${c.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-surface-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{c.label}</span>
                      <span className="text-xs text-muted">
                        {h.label} · synced <TimeAgo iso={c.last_success_at} />
                      </span>
                    </span>
                    <ConnectionStatusBadge status={c.status} syncing={isSyncing(c)} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Latest warnings" actions={<LinkButton size="sm" href="/alerts">All</LinkButton>} />
            {alerts.length === 0 ? (
              <EmptyState icon={<Siren className="size-6" />} title="No active warnings" />
            ) : (
              <ul className="divide-y divide-border">
                {alerts.slice(0, 5).map((a) => (
                  <li key={a.id}>
                    <Link href={`/alerts/${a.id}`} className="block px-4 py-2.5 hover:bg-surface-2">
                      <span className="flex items-center gap-2">
                        <SeverityBadge severity={a.severity} />
                        <span className="text-xs text-faint">
                          <TimeAgo iso={a.created_at} />
                        </span>
                      </span>
                      <span className="mt-1 block text-sm">{a.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader title="Applications" actions={<LinkButton size="sm" href="/applications">Manage</LinkButton>} />
        {inv.applications.length === 0 ? (
          <EmptyState icon={<Boxes className="size-7" />} title="No applications yet" action={<LinkButton href="/applications" size="sm">Create an application</LinkButton>}>
            Group resources by product to see risk per application.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Application</Th>
                <Th>Resources</Th>
                <Th>Monitoring</Th>
                <Th>Highest risk</Th>
                <Th>Latest warning</Th>
              </tr>
            </thead>
            <tbody>
              {inv.applications.map((app) => {
                const res = inv.resources.filter((r) => inv.appByResource.get(r.id)?.id === app.id);
                const ids = new Set(res.map((r) => r.id));
                const accountIds = new Set(res.map((r) => r.account_id));
                const own = quotas.filter((q) => q.evaluation?.isEffective && q.resourceId && ids.has(q.resourceId));
                const shared = quotas.filter((q) => q.evaluation?.isEffective && q.accountId && accountIds.has(q.accountId));
                const top = [...own, ...shared].sort((a, b) => (b.evaluation?.percent ?? -1) - (a.evaluation?.percent ?? -1))[0];
                const conns = [...new Set(res.map((r) => r.connection_id))];
                const failing = health.filter((x) => conns.includes(x.c.id) && !x.h.reliable);
                const latest = alerts.find((a) => a.application_id === app.id || (a.resource_id && ids.has(a.resource_id)));
                return (
                  <tr key={app.id}>
                    <Td>
                      <Link href={`/applications/${app.id}`} className="font-medium hover:underline">
                        {app.name}
                      </Link>
                    </Td>
                    <Td className="text-xs text-muted">
                      {res.length} · {[...new Set(res.map((r) => PROVIDER_NAMES[r.provider]))].join(", ") || "—"}
                    </Td>
                    <Td>{failing.length ? <Badge tone="crit">{failing.length} unreliable</Badge> : <Badge tone="ok">Healthy</Badge>}</Td>
                    <Td>
                      {top ? (
                        <span className="flex flex-col gap-0.5">
                          <RiskLabel percent={top.evaluation?.percent ?? null} />
                          <span className="text-xs text-muted">
                            {top.metricName}
                            {top.scopeType === "account" ? " (shared org quota)" : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-faint">No limits</span>
                      )}
                    </Td>
                    <Td className="max-w-64 truncate text-xs text-muted">{latest ? <Link href={`/alerts/${latest.id}`} className="hover:underline">{latest.title}</Link> : "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Usage trend"
            description={
              trendMetric
                ? `${trendMetric.name} across all monitored ${PROVIDER_NAMES[trendMetric.provider]} resources, last 30 days${trendMetric.aggregation === "incremental" ? " (completed days)" : ""}`
                : undefined
            }
            actions={
              trendChoices.length ? (
                <form className="flex items-center gap-2">
                  <label htmlFor="trend" className="sr-only">
                    Metric
                  </label>
                  <Select id="trend" name="trend" defaultValue={trendMetric?.key} className="h-8 w-auto text-xs">
                    {trendChoices.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" type="submit">
                    Show
                  </Button>
                </form>
              ) : null
            }
          />
          <CardBody>
            {!trendMetric || trend.every((d) => d.value === null) ? (
              <EmptyState title="No usage history yet">History appears after the first collection.</EmptyState>
            ) : (
              <UsageTrendChart
                points={trend.map((d) => ({ day: d.day, value: d.value, partial: !d.complete }))}
                unit={trendMetric.unit}
                limit={null}
                seriesLabel={trendMetric.aggregation === "incremental" ? `Daily ${trendMetric.name.toLowerCase()}` : trendMetric.name}
                height={220}
              />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="By provider" />
          <ul className="divide-y divide-border">
            {[...new Set(inv.connections.map((c) => c.provider))].map((p) => {
              const conns = new Set(inv.connections.filter((c) => c.provider === p).map((c) => c.id));
              const stats: [string, number][] = [
                ["Resources", monitored.filter((r) => r.provider === p).length],
                ["Limits", quotas.filter((q) => q.connection && conns.has(q.connection.id) && q.evaluation?.isEffective).length],
                ["Warnings", alerts.filter((a) => a.connection_id && conns.has(a.connection_id)).length],
              ];
              return (
                <li key={p} className="px-4 py-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Cloud className="size-3.5 text-faint" aria-hidden />
                    {PROVIDER_NAMES[p]}
                  </p>
                  <dl className="mt-2 grid grid-cols-3 gap-2">
                    {stats.map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-[11px] text-muted">{k}</dt>
                        <dd className="num text-base font-semibold">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ul>
          <CardBody>
            <Link href="/usage" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              Open usage explorer <ArrowRight className="size-3" aria-hidden />
            </Link>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
