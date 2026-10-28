import clsx from "clsx";
import { BellOff, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { SubmitButton } from "@/components/form-controls";
import { AlertStatusBadge, CATEGORY_LABEL, SeverityBadge } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { Card, EmptyState, Flash, LinkButton, PageHeader } from "@/components/ui";
import { listAlerts, listInbox } from "@/db/repos/alerts";
import { getSession } from "@/lib/session";
import { SEVERITY_RANK, type Severity } from "@/lib/types";
import { markAllRead, openNotification } from "./actions";
import { AlertActions } from "./alert-actions";

export const metadata = { title: "Alerts" };

const TABS = [
  { id: "active", label: "Active" },
  { id: "inbox", label: "Inbox" },
  { id: "history", label: "History" },
] as const;

export default async function AlertsPage({ searchParams }: PageProps<"/alerts">) {
  const sp = await searchParams;
  const tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as (typeof TABS)[number]["id"]) : "active";
  const { scope } = await getSession();
  const back = `/alerts?tab=${tab}`;

  const tabs = (
    <nav aria-label="Alert views" className="mb-4 flex gap-1 border-b border-border">
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={`/alerts?tab=${t.id}`}
          aria-current={tab === t.id ? "page" : undefined}
          className={clsx(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
            tab === t.id ? "border-accent text-accent" : "border-transparent text-muted hover:text-text",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );

  let body: React.ReactNode;
  if (tab === "inbox") {
    const items = await listInbox(scope, 100);
    body = (
      <Card>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-xs text-muted">{items.filter((i) => !i.read_at).length} unread</p>
          <form action={markAllRead}>
            <SubmitButton size="sm" variant="ghost" pendingText="…">
              Mark all as read
            </SubmitButton>
          </form>
        </div>
        {items.length === 0 ? (
          <EmptyState icon={<BellOff className="size-8" />} title="No notifications yet" />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((n) =>
              n.alerts ? (
                <li key={n.id}>
                  <form action={openNotification}>
                    <input type="hidden" name="deliveryId" value={n.id} />
                    <button type="submit" className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2">
                      <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-accent")} aria-label={n.read_at ? undefined : "Unread"} />
                      <span className="min-w-0 flex-1">
                        <span className={clsx("block text-sm", !n.read_at && "font-medium")}>{n.alerts.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <SeverityBadge severity={n.alerts.severity} />
                          {CATEGORY_LABEL[n.alerts.category]} · <TimeAgo iso={n.created_at} />
                        </span>
                      </span>
                    </button>
                  </form>
                </li>
              ) : null,
            )}
          </ul>
        )}
      </Card>
    );
  } else {
    const data = await listAlerts(scope, {
      statuses: tab === "active" ? ["open", "acknowledged", "muted"] : undefined,
      limit: tab === "history" ? 200 : 100,
    });
    // Active view: most severe first; history stays chronological.
    const alerts = [...data].sort((a, b) =>
      tab === "active" ? SEVERITY_RANK[b.severity as Severity] - SEVERITY_RANK[a.severity as Severity] || b.created_at.localeCompare(a.created_at) : 0,
    );
    body = (
      <Card>
        {alerts.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="size-8 text-ok" />} title={tab === "active" ? "No active alerts" : "No alerts yet"}>
            {tab === "active" ? "Everything monitored is within its configured thresholds." : null}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={a.severity} />
                    <AlertStatusBadge status={a.status} />
                    <span className="text-xs text-muted">{CATEGORY_LABEL[a.category]}</span>
                  </div>
                  <Link href={`/alerts/${a.id}`} className="mt-1 block font-medium hover:underline">
                    {a.title}
                  </Link>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{a.message}</p>
                  <p className="mt-1 text-xs text-faint">
                    <TimeAgo iso={a.created_at} />
                    {a.status === "muted" && a.muted_until ? (
                      <>
                        {" "}
                        · muted until <TimeAgo iso={a.muted_until} />
                      </>
                    ) : null}
                    {a.resolved_at ? (
                      <>
                        {" "}
                        · resolved <TimeAgo iso={a.resolved_at} />
                      </>
                    ) : null}
                  </p>
                </div>
                <AlertActions alert={a} back={back} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Monitoring notices about quotas, forecasts, estimated costs and connection health. Alerts never cap spending."
        actions={<LinkButton href="/alerts/rules">Alert rules</LinkButton>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {tabs}
      {body}
    </>
  );
}
