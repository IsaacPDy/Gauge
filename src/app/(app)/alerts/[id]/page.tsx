import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertStatusBadge, CATEGORY_LABEL, SeverityBadge } from "@/components/status";
import { formatDate, TimeAgo } from "@/components/time";
import { Badge, Card, CardBody, CardHeader, Flash, KeyValue, LinkButton, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { getMetric, PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { formatPercent, formatValue } from "@/lib/units";
import { AlertActions } from "../alert-actions";

export const metadata = { title: "Alert" };

export default async function AlertPage({ params, searchParams }: PageProps<"/alerts/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await getSession();
  const { data: a } = await supabase
    .from("alerts")
    .select("*, provider_connections(id, label, provider), provider_resources(id, name, dashboard_url), provider_accounts(id, name, dashboard_url), applications(id, name)")
    .eq("id", id)
    .maybeSingle();
  if (!a) notFound();
  const { data: deliveries } = await supabase.from("notification_deliveries").select("*").eq("alert_id", a.id).order("channel");

  const unit = a.unit ?? "count";
  const conn = a.provider_connections;
  const scope = a.provider_resources?.name ?? a.provider_accounts?.name ?? null;
  const dashboard = a.provider_resources?.dashboard_url ?? a.provider_accounts?.dashboard_url ?? null;
  const usageHref =
    a.metric_key && (a.resource_id || a.account_id)
      ? `/usage?${new URLSearchParams({ metric: a.metric_key, scope: a.resource_id ? `r:${a.resource_id}` : `a:${a.account_id}` })}`
      : null;
  const back = `/alerts/${a.id}`;

  return (
    <>
      <Link href="/alerts" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-text">
        <ArrowLeft className="size-3" aria-hidden /> All alerts
      </Link>
      <PageHeader
        title={a.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={a.severity} />
            <AlertStatusBadge status={a.status} />
            <span>{CATEGORY_LABEL[a.category]}</span>
            {conn?.provider === "demo" ? <Badge tone="demo">Demo data</Badge> : null}
          </span>
        }
        actions={<AlertActions alert={a} back={back} />}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="What happened" />
            <CardBody className="space-y-4">
              <p className="text-sm leading-relaxed">{a.message}</p>
              <KeyValue
                items={[
                  ["Affected application", a.applications?.name ?? (a.category === "integration_health" ? "All applications using this connection" : "Not assigned / shared billing scope")],
                  ["Provider", conn ? `${PROVIDER_NAMES[conn.provider] ?? conn.provider} · ${conn.label}` : "—"],
                  ["Billing or resource scope", scope ?? "—"],
                  ["Metric", a.metric_key ? (getMetric(a.metric_key)?.name ?? a.metric_key) : "—"],
                  ["Current consumption", a.current_value === null ? "—" : formatValue(Number(a.current_value), unit)],
                  ["Applicable limit", a.limit_value === null ? "—" : formatValue(Number(a.limit_value), unit)],
                  ["Percentage used", a.percent_used === null ? "—" : formatPercent(Number(a.percent_used))],
                  ["Billing cycle resets", a.cycle_reset_at ? formatDate(a.cycle_reset_at) : "—"],
                  ["Forecasted breach (estimate)", a.forecast_breach_at ? formatDate(a.forecast_breach_at) : "—"],
                  ["Last data update", a.data_updated_at ? <TimeAgo key="d" iso={a.data_updated_at} /> : "—"],
                ]}
              />
            </CardBody>
          </Card>
          {a.recommended_action ? (
            <Notice tone="info" title="Recommended next step">
              {a.recommended_action}
            </Notice>
          ) : null}
          <p className="text-xs text-muted">
            Limit Gauge alerts are monitoring notices, not spending caps or provider controls. Estimates can differ from your invoice,
            which is authoritative.
          </p>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Next steps" />
            <CardBody className="flex flex-col gap-2">
              {usageHref ? <LinkButton href={usageHref}>Inspect usage history</LinkButton> : null}
              {a.resource_id ? <LinkButton href={`/providers/${conn?.id}`}>Open connection</LinkButton> : null}
              {a.category === "integration_health" && conn ? (
                <LinkButton href={`/providers/${conn.id}`} variant="primary">
                  Repair connection
                </LinkButton>
              ) : null}
              {a.applications ? <LinkButton href={`/applications/${a.applications.id}`}>Open {a.applications.name}</LinkButton> : null}
              {dashboard ? (
                <a href={dashboard} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                  Provider dashboard <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Notifications" description="Delivery attempts for this alert." />
            <Table>
              <thead>
                <tr>
                  <Th>Channel</Th>
                  <Th>Status</Th>
                  <Th>Attempts</Th>
                </tr>
              </thead>
              <tbody>
                {(deliveries ?? []).map((d) => (
                  <tr key={d.id}>
                    <Td>{d.channel === "in_app" ? "In-app" : "Email"}</Td>
                    <Td>
                      <Badge tone={d.status === "sent" ? "ok" : d.status === "failed" ? "crit" : d.status === "skipped" ? "neutral" : "info"}>{d.status}</Badge>
                      {d.last_error ? <span className="mt-1 block text-xs text-muted">{d.last_error}</span> : null}
                    </Td>
                    <Td className="num text-xs">{d.attempts}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardBody>
              <KeyValue
                items={[
                  ["Created", <TimeAgo key="c" iso={a.created_at} />],
                  ["Acknowledged", a.acknowledged_at ? <TimeAgo key="a" iso={a.acknowledged_at} /> : "—"],
                  ["Resolved", a.resolved_at ? <TimeAgo key="r" iso={a.resolved_at} /> : "—"],
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
