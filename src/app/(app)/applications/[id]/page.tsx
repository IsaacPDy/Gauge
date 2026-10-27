import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UsageTrendChart } from "@/components/charts";
import { SubmitButton } from "@/components/form-controls";
import { ConnectionStatusBadge, SeverityBadge, SourceBadge, UsageBar } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Flash, Input, Label, Notice, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { isSyncing, loadInventory, loadQuotaViews, loadSamples, seriesFor } from "@/lib/data/views";
import { DAY_MS, startOfUtcDay } from "@/lib/engine/time";
import { getAdapter, getMetric, PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { formatValue } from "@/lib/units";
import { addResources, deleteApplication, removeResource, updateApplication } from "../actions";

export const metadata = { title: "Application" };

export default async function ApplicationPage({ params, searchParams }: PageProps<"/applications/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await getSession();
  const inv = await loadInventory(supabase);
  const app = inv.applications.find((a) => a.id === id);
  if (!app) notFound();

  const quotas = await loadQuotaViews(supabase, inv);
  const resources = inv.resources.filter((r) => inv.appByResource.get(r.id)?.id === app.id);
  const ids = new Set(resources.map((r) => r.id));
  const accountIds = new Set(resources.map((r) => r.account_id).filter(Boolean) as string[]);
  const connections = [...new Set(resources.map((r) => r.connection_id))].map((cid) => inv.connectionById.get(cid)!).filter(Boolean);
  const resourceQuotas = quotas.filter((q) => q.evaluation?.isEffective && q.resourceId && ids.has(q.resourceId));
  const sharedQuotas = quotas.filter((q) => q.evaluation?.isEffective && q.accountId && accountIds.has(q.accountId));
  const candidates = inv.resources.filter((r) => !ids.has(r.id) && r.status === "active");

  const { data: alerts } = await supabase
    .from("alerts")
    .select("*")
    .in("status", ["open", "acknowledged", "muted"])
    .order("created_at", { ascending: false })
    .limit(200);
  const appAlerts = (alerts ?? []).filter(
    (a) => a.application_id === app.id || (a.resource_id && ids.has(a.resource_id)) || (a.category === "integration_health" && connections.some((c) => c.id === a.connection_id)),
  );

  // Historical consumption for a selected resource-level metric, summed over this app's monitored resources.
  const monitored = resources.filter((r) => r.is_monitored && r.status === "active");
  const metricChoices = [...new Set(monitored.map((r) => r.provider))].flatMap(
    (p) => getAdapter(p)?.metrics.filter((m) => m.supported && m.scopeLevel === "resource") ?? [],
  );
  const metricFilter = typeof sp.metric === "string" ? sp.metric : "";
  const metric = getMetric(metricFilter) ?? metricChoices[0];
  const chartScope = metric ? monitored.filter((r) => r.provider === metric.provider).map((r) => r.id) : [];
  const now = new Date();
  const from = new Date(startOfUtcDay(now).getTime() - 29 * DAY_MS);
  const rows = metric && chartScope.length ? await loadSamples(supabase, { metricKeys: [metric.key], resourceIds: chartScope, from }) : [];
  const today = now.toISOString().slice(0, 10);
  // Today's total for incremental metrics is still accumulating; leave it out of the history chart.
  const daily = metric ? seriesFor(metric, rows, chartScope, from, now).filter((d) => metric.aggregation !== "incremental" || d.day !== today) : [];
  const shownQuotas = metricFilter ? resourceQuotas.filter((q) => q.metricKey === metricFilter) : resourceQuotas;

  return (
    <>
      <PageHeader
        title={app.name}
        description={app.description ?? "No description"}
        actions={
          <form action={deleteApplication}>
            <input type="hidden" name="id" value={app.id} />
            <SubmitButton variant="danger" size="sm" confirm="Delete this application? Its resources stay connected and monitored.">
              Delete application
            </SubmitButton>
          </form>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Resources</p>
          <p className="num mt-1 text-2xl font-semibold">{resources.length}</p>
          <p className="text-xs text-muted">{monitored.length} monitored</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Active warnings</p>
          <p className="num mt-1 text-2xl font-semibold">{appAlerts.length}</p>
          <p className="text-xs text-muted">{appAlerts[0] ? appAlerts[0].title : "None"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-muted">Monitoring status</p>
          <div className="mt-2 flex flex-col gap-1">
            {connections.length === 0 ? <span className="text-sm text-muted">No connections yet</span> : null}
            {connections.map((c) => (
              <Link key={c.id} href={`/providers/${c.id}`} className="flex items-center justify-between gap-2 text-xs hover:underline">
                <span className="truncate">{c.label}</span>
                <ConnectionStatusBadge status={c.status} syncing={isSyncing(c)} />
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader
          title="Historical consumption"
          description={metric ? `${metric.name}, summed across this application's monitored ${PROVIDER_NAMES[metric.provider]} resources (last 30 days)` : undefined}
          actions={
            metricChoices.length ? (
              <form className="flex items-center gap-2">
                <label htmlFor="metric" className="sr-only">
                  Metric
                </label>
                <Select id="metric" name="metric" defaultValue={metric?.key} className="h-8 w-auto text-xs">
                  {metricChoices.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                <Button size="sm" type="submit">
                  Filter
                </Button>
              </form>
            ) : null
          }
        />
        <CardBody>
          {!metric || daily.every((d) => d.value === null) ? (
            <EmptyState title="No usage history yet">Monitor this application's resources to collect history.</EmptyState>
          ) : (
            <UsageTrendChart
              points={daily.map((d) => ({ day: d.day, value: d.value, partial: !d.complete }))}
              unit={metric.unit}
              limit={null}
              seriesLabel={metric.aggregation === "incremental" ? `Daily ${metric.name.toLowerCase()}` : metric.name}
              height={220}
            />
          )}
        </CardBody>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Resource quotas" description="Limits that apply to individual resources of this application." />
          {shownQuotas.length === 0 ? (
            <EmptyState title="No resource-level limits">Set limits from the usage explorer or confirm plan allowances.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {shownQuotas.map((q) => (
                <li key={q.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <Link href={`/usage?${new URLSearchParams({ metric: q.metricKey, scope: `r:${q.resourceId}` })}`} className="font-medium hover:underline">
                      {q.metricName} · {q.scopeName}
                    </Link>
                    <SourceBadge kind={q.isDemo ? "demo" : q.source} />
                  </div>
                  <div className="mt-1.5">
                    <UsageBar percent={q.evaluation?.percent ?? null} projectedPercent={q.evaluation?.forecast?.status === "ok" ? q.evaluation.forecast.projectedPercent : null} label={`${q.metricName} used`} />
                  </div>
                  <p className="num mt-0.5 text-xs text-muted">
                    {formatValue(q.evaluation?.current, q.unit)} of {formatValue(q.limit, q.unit)}
                    {q.evaluation?.dataState === "stale" ? " · stale" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Shared organization quotas" description="Billed at organization level and shared with other projects." />
          <CardBody className="space-y-3">
            <Notice tone="neutral">
              These allowances cover every project in the organization. CloudWatch does not attribute shared usage or charges to this
              application.
            </Notice>
            {sharedQuotas.length === 0 ? <p className="text-sm text-muted">None configured.</p> : null}
            {sharedQuotas.map((q) => (
              <div key={q.id}>
                <Link href={`/usage?${new URLSearchParams({ metric: q.metricKey, scope: `a:${q.accountId}` })}`} className="text-sm font-medium hover:underline">
                  {q.metricName} · {q.scopeName}
                </Link>
                <div className="mt-1">
                  <UsageBar percent={q.evaluation?.percent ?? null} label={`${q.metricName} used`} />
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader title="Resources" description="Provider resources that make up this application." />
        {resources.length === 0 ? (
          <EmptyState title="No resources yet">Add resources below.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Provider</Th>
                <Th>Organization</Th>
                <Th>Monitoring</Th>
                <Th>Last collected</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <span className="font-medium">{r.name}</span>
                    <span className="block text-xs text-faint">{r.resource_type}</span>
                  </Td>
                  <Td className="text-xs">
                    {PROVIDER_NAMES[r.provider]}
                    <span className="block text-muted">{inv.connectionById.get(r.connection_id)?.label}</span>
                  </Td>
                  <Td className="text-xs text-muted">{inv.accountById.get(r.account_id ?? "")?.name ?? "—"}</Td>
                  <Td>{r.status !== "active" ? <Badge tone="warn">{r.status}</Badge> : r.is_monitored ? <Badge tone="accent">Monitored</Badge> : <Badge>Not monitored</Badge>}</Td>
                  <Td className="text-xs text-muted">
                    <TimeAgo iso={r.last_collected_at} />
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    {r.dashboard_url ? (
                      <a href={r.dashboard_url} target="_blank" rel="noreferrer" className="mr-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        Dashboard <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                    <form action={removeResource} className="inline">
                      <input type="hidden" name="applicationId" value={app.id} />
                      <input type="hidden" name="resourceId" value={r.id} />
                      <SubmitButton variant="ghost" size="sm">
                        Remove
                      </SubmitButton>
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Add resources" description="A resource belongs to one application; adding moves it here." />
          {candidates.length === 0 ? (
            <EmptyState title="No other resources">Connect a provider to discover more.</EmptyState>
          ) : (
            <form action={addResources}>
              <input type="hidden" name="applicationId" value={app.id} />
              <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                {candidates.map((r) => {
                  const other = inv.appByResource.get(r.id);
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2">
                      <Checkbox id={`add-${r.id}`} name="resourceId" value={r.id} />
                      <label htmlFor={`add-${r.id}`} className="min-w-0 flex-1 text-sm">
                        {r.name}{" "}
                        <span className="text-xs text-muted">
                          · {PROVIDER_NAMES[r.provider]} · {inv.accountById.get(r.account_id ?? "")?.name}
                          {other ? ` · currently in ${other.name}` : ""}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t border-border px-4 py-3">
                <SubmitButton size="sm" pendingText="Adding…">
                  Add selected
                </SubmitButton>
              </div>
            </form>
          )}
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Active warnings" />
            {appAlerts.length === 0 ? (
              <EmptyState title="No active warnings" />
            ) : (
              <ul className="divide-y divide-border">
                {appAlerts.slice(0, 8).map((a) => (
                  <li key={a.id} className="px-4 py-2.5">
                    <Link href={`/alerts/${a.id}`} className="flex items-center gap-2 text-sm hover:underline">
                      <SeverityBadge severity={a.severity} />
                      <span className="truncate">{a.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <form action={updateApplication} className="space-y-3">
                <input type="hidden" name="id" value={app.id} />
                <div>
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" defaultValue={app.name} maxLength={80} required />
                </div>
                <div>
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" name="description" defaultValue={app.description ?? ""} maxLength={500} />
                </div>
                <SubmitButton variant="secondary" pendingText="Saving…">
                  Save
                </SubmitButton>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
