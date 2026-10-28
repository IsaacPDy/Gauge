import { ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh, AutoSubmitSelect, SubmitButton } from "@/components/form-controls";
import { CapabilityBadge, ConnectionStatusBadge } from "@/components/status";
import { formatDate, TimeAgo } from "@/components/time";
import { Badge, Card, CardBody, CardHeader, Checkbox, EmptyState, Flash, inputClass, KeyValue, LinkButton, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { isSyncing, loadInventory } from "@/lib/data/views";
import { connectionHealth } from "@/lib/engine/health";
import { getAdapter, getMetric, PROVIDER_NAMES } from "@/lib/providers/registry";
import { oauthConfigured } from "@/lib/providers/supabase/oauth";
import { CAPABILITY_LABELS, type Capabilities } from "@/lib/providers/types";
import { getSession } from "@/lib/session";
import type { ConnectionStatus } from "@/lib/types";
import { disconnect, removeConnection, renameConnection, replaceToken, saveMonitoring, setDemoSimulation, syncNow, updateAccountCycle } from "../actions";
import { TokenForm } from "../token-form";

export const metadata = { title: "Connection" };

const FAILURE_HELP: Record<string, string> = {
  reauth_required: "The provider rejected the stored credentials (expired or revoked). Collection is paused until you reauthorize below.",
  permission_insufficient: "The credentials work but lack a required read permission. Reconnect with the permissions listed below.",
  error: "Repeated failures contacting the provider. Limit Gauge keeps retrying with backoff; existing data is kept and never treated as zero.",
  disconnected: "This connection is disconnected. Its credentials were deleted and no data is collected. Historical data remains visible.",
};

interface MetricOutcomeEntry {
  metricKey: string;
  scope: string;
  status: string;
  errorCode: string | null;
  detail: string | null;
  at: string;
}

export default async function ConnectionPage({ params, searchParams }: PageProps<"/providers/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, workspace } = await getSession();
  const inv = await loadInventory(supabase);
  const conn = inv.connectionById.get(id);
  if (!conn) notFound();

  const adapter = getAdapter(conn.provider);
  const accounts = inv.accounts.filter((a) => a.connection_id === conn.id);
  const resources = inv.resources.filter((r) => r.connection_id === conn.id);
  const monitoredCount = resources.filter((r) => r.is_monitored).length;
  const { data: runs } = await supabase.from("sync_runs").select("*").eq("connection_id", conn.id).order("started_at", { ascending: false }).limit(10);
  const syncing = isSyncing(conn);
  const setup = (sp.setup === "1" || monitoredCount === 0) && resources.length > 0 && conn.status !== "disconnected";
  const health = connectionHealth(
    {
      status: conn.status as ConnectionStatus,
      lastSuccessAt: conn.last_success_at ? new Date(conn.last_success_at) : null,
      createdAt: new Date(conn.created_at),
      consecutiveFailures: conn.consecutive_failures,
    },
    new Date(),
    workspace.stale_after_hours,
  );

  const caps = (conn.capabilities ?? {}) as { declared?: Capabilities; metrics?: Record<string, MetricOutcomeEntry> };
  const declared = caps.declared ?? adapter?.capabilities;
  const outcomes = Object.values(caps.metrics ?? {});
  const byMetric = new Map<string, MetricOutcomeEntry[]>();
  for (const o of outcomes) {
    const arr = byMetric.get(o.metricKey);
    if (arr) arr.push(o);
    else byMetric.set(o.metricKey, [o]);
  }

  return (
    <>
      <AutoRefresh active={syncing} />
      <PageHeader
        title={conn.label}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {PROVIDER_NAMES[conn.provider]} · {conn.auth_method === "oauth" ? "OAuth" : conn.auth_method === "token" ? "Access token" : "Demo"}
            <ConnectionStatusBadge status={conn.status} syncing={syncing} />
            {conn.provider === "demo" ? <Badge tone="demo">Demo data</Badge> : null}
            {health.state === "stale" ? <Badge tone="warn">{health.label}</Badge> : null}
          </span>
        }
        actions={
          conn.status !== "disconnected" ? (
            <form action={syncNow}>
              <input type="hidden" name="connectionId" value={conn.id} />
              <SubmitButton variant="secondary" pendingText="Starting…" disabled={syncing}>
                <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden /> {syncing ? "Syncing…" : "Sync now"}
              </SubmitButton>
            </form>
          ) : null
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      {FAILURE_HELP[conn.status] ? (
        <div className="mb-4">
          <Notice tone={conn.status === "disconnected" ? "neutral" : "crit"} title={conn.status_detail ?? undefined}>
            {FAILURE_HELP[conn.status]}
          </Notice>
        </div>
      ) : conn.status_detail ? (
        <div className="mb-4">
          <Notice tone="warn">{conn.status_detail}</Notice>
        </div>
      ) : null}

      {setup ? (
        <Card className="mb-6 border-accent/40">
          <CardHeader
            title="Choose resources to monitor"
            description="Limit Gauge only collects usage for the resources you select. You can change this at any time."
          />
          <form action={saveMonitoring}>
            <input type="hidden" name="connectionId" value={conn.id} />
            <ul className="divide-y divide-border">
              {resources.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <input type="hidden" name="ids" value={r.id} />
                  <Checkbox
                    id={`m-${r.id}`}
                    name="monitor"
                    value={r.id}
                    defaultChecked={monitoredCount === 0 ? r.status === "active" : r.is_monitored}
                    disabled={r.status !== "active"}
                  />
                  <label htmlFor={`m-${r.id}`} className="min-w-0 flex-1">
                    <span className="font-medium">{r.name}</span>{" "}
                    <span className="text-xs text-muted">
                      {r.resource_type} · {inv.accountById.get(r.account_id ?? "")?.name ?? "No organization"} · {r.region ?? "region unknown"}
                    </span>
                  </label>
                  {r.status !== "active" ? <Badge tone="warn">{r.status}</Badge> : null}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-muted">Next: group resources into applications and confirm quotas on the Usage page.</p>
              <SubmitButton pendingText="Saving…">Start monitoring</SubmitButton>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Overview" />
          <CardBody>
            <KeyValue
              items={[
                ["Last successful sync", <TimeAgo key="s" iso={conn.last_success_at} />],
                ["Last attempt", <TimeAgo key="a" iso={conn.last_attempt_at} />],
                ["Next scheduled sync", conn.next_sync_at ? <TimeAgo key="n" iso={conn.next_sync_at} /> : "Paused"],
                ["Collection interval", `Every ${Math.round(conn.sync_interval_minutes / 60)} hours`],
                ["Monitoring health", health.label],
                ["Consecutive failures", String(conn.consecutive_failures)],
                ["Connected", formatDate(conn.created_at)],
                ["Granted permissions", conn.granted_scopes.length ? conn.granted_scopes.join(", ") : "—"],
              ]}
            />
            <form action={renameConnection} className="mt-4 flex max-w-sm gap-2">
              <input type="hidden" name="connectionId" value={conn.id} />
              <label htmlFor="label" className="sr-only">
                Connection name
              </label>
              <input id="label" name="label" defaultValue={conn.label} maxLength={80} className={inputClass} />
              <SubmitButton variant="secondary" pendingText="Saving…">
                Rename
              </SubmitButton>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Credentials" description="Stored encrypted; never shown after saving." />
          <CardBody className="space-y-4">
            {conn.provider === "supabase" ? (
              <>
                {oauthConfigured() ? (
                  <LinkButton href={`/api/integrations/supabase/oauth/start?connectionId=${conn.id}`} prefetch={false} variant={conn.status === "reauth_required" ? "primary" : "secondary"}>
                    Reauthorize with OAuth
                  </LinkButton>
                ) : null}
                <details open={conn.status === "reauth_required" || conn.status === "disconnected"}>
                  <summary className="cursor-pointer text-sm font-medium">Replace access token</summary>
                  <div className="mt-3">
                    <TokenForm action={replaceToken} connectionId={conn.id} submit="Validate and replace" />
                  </div>
                </details>
              </>
            ) : null}
            {conn.provider === "demo" ? (
              <form action={setDemoSimulation} className="space-y-2">
                <input type="hidden" name="connectionId" value={conn.id} />
                <label htmlFor="simulate" className="block text-xs font-medium text-muted">
                  Simulate a provider failure (demo only)
                </label>
                <div className="flex gap-2">
                  <select id="simulate" name="simulate" defaultValue="none" className={inputClass}>
                    <option value="none">No failure</option>
                    <option value="auth_expired">Revoked credentials (401)</option>
                    <option value="permission">Missing permission (403)</option>
                    <option value="rate_limited">Rate limited (429)</option>
                    <option value="outage">Provider outage (503)</option>
                  </select>
                  <SubmitButton size="md" variant="secondary" pendingText="…">
                    Apply
                  </SubmitButton>
                </div>
              </form>
            ) : null}
            <div className="space-y-2 border-t border-border pt-4">
              {conn.status !== "disconnected" ? (
                <form action={disconnect}>
                  <input type="hidden" name="connectionId" value={conn.id} />
                  <SubmitButton variant="danger" size="sm" confirm="Disconnect and delete the stored credentials? Historical data is kept.">
                    Disconnect
                  </SubmitButton>
                </form>
              ) : null}
              <form action={removeConnection}>
                <input type="hidden" name="connectionId" value={conn.id} />
                <SubmitButton
                  variant="danger"
                  size="sm"
                  confirm="Permanently delete this connection, its discovered resources, usage history and quotas?"
                >
                  Remove connection and data
                </SubmitButton>
              </form>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Accounts" description="Billing scope. Quotas such as MAU and storage usually apply to the whole organization." />
        {accounts.length === 0 ? (
          <EmptyState title="No accounts discovered yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Plan</Th>
                <Th>Status</Th>
                <Th>Billing cycle resets on day</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td>{a.plan ? <Badge>{a.plan}</Badge> : <span className="text-faint">unknown</span>}</Td>
                  <Td>{a.status === "active" ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">{a.status}</Badge>}</Td>
                  <Td>
                    <form action={updateAccountCycle} className="flex items-center gap-2">
                      <input type="hidden" name="accountId" value={a.id} />
                      <label htmlFor={`day-${a.id}`} className="sr-only">
                        Billing cycle day for {a.name}
                      </label>
                      <AutoSubmitSelect id={`day-${a.id}`} name="day" defaultValue={String(a.billing_cycle_anchor_day)} className={`${inputClass} w-20`}>
                        {Array.from({ length: 28 }, (_, i) => (
                          <option key={i + 1} value={i + 1}>
                            {i + 1}
                          </option>
                        ))}
                      </AutoSubmitSelect>
                    </form>
                  </Td>
                  <Td className="text-right">
                    {a.dashboard_url ? (
                      <a href={a.dashboard_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        Provider dashboard <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {!setup ? (
        <Card className="mt-6">
          <CardHeader
            title="Resources"
            description={`${monitoredCount} of ${resources.length} monitored`}
            actions={<LinkButton href="/providers/resources" size="sm">Assign to applications</LinkButton>}
          />
          {resources.length === 0 ? (
            <EmptyState title="No resources discovered">Run a sync to discover projects this connection can access.</EmptyState>
          ) : (
            <form action={saveMonitoring}>
              <input type="hidden" name="connectionId" value={conn.id} />
              <Table>
                <thead>
                  <tr>
                    <Th className="w-10">
                      <span className="sr-only">Monitor</span>
                    </Th>
                    <Th>Name</Th>
                    <Th>Organization</Th>
                    <Th>Status</Th>
                    <Th>Application</Th>
                    <Th>Last collected</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {resources.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <input type="hidden" name="ids" value={r.id} />
                        <Checkbox name="monitor" value={r.id} defaultChecked={r.is_monitored} aria-label={`Monitor ${r.name}`} />
                      </Td>
                      <Td>
                        <span className="font-medium">{r.name}</span>
                        <span className="block font-mono text-[11px] text-faint">{r.external_id}</span>
                      </Td>
                      <Td className="text-muted">{inv.accountById.get(r.account_id ?? "")?.name ?? "—"}</Td>
                      <Td>
                        {r.status === "active" ? (
                          <span className="text-xs text-muted">{r.provider_status ?? "active"}</span>
                        ) : (
                          <Badge tone="warn" title="Not returned by the provider on the last discovery">
                            {r.status}
                          </Badge>
                        )}
                      </Td>
                      <Td>{inv.appByResource.get(r.id)?.name ?? <span className="text-faint">Unassigned</span>}</Td>
                      <Td className="text-xs text-muted">
                        <TimeAgo iso={r.last_collected_at} />
                      </Td>
                      <Td className="text-right">
                        {r.dashboard_url ? (
                          <a href={r.dashboard_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline" aria-label={`Open ${r.name} in provider dashboard`}>
                            <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex justify-end px-4 py-3">
                <SubmitButton variant="secondary" pendingText="Saving…">
                  Save monitoring selection
                </SubmitButton>
              </div>
            </form>
          )}
        </Card>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Capabilities" description="What this integration can and cannot provide." />
          <Table>
            <tbody>
              {declared
                ? (Object.keys(CAPABILITY_LABELS) as (keyof Capabilities)[]).map((k) => (
                    <tr key={k}>
                      <Td className="font-medium">{CAPABILITY_LABELS[k]}</Td>
                      <Td>
                        <CapabilityBadge level={declared[k].level} />
                      </Td>
                      <Td className="text-xs text-muted">{declared[k].note}</Td>
                    </tr>
                  ))
                : null}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Metrics" description="Result of the latest collection per metric." />
          <Table>
            <tbody>
              {(adapter?.metrics ?? []).map((m) => {
                const list = byMetric.get(m.key) ?? [];
                const ok = list.filter((o) => o.status === "ok").length;
                const bad = list.filter((o) => o.status === "error" || o.status === "unavailable");
                return (
                  <tr key={m.key}>
                    <Td className="font-medium">
                      <Link href={`/usage?metric=${encodeURIComponent(m.key)}`} className="hover:underline">
                        {getMetric(m.key)?.name}
                      </Link>
                    </Td>
                    <Td>
                      {!m.supported ? (
                        <Badge title={m.unsupportedReason}>Unsupported</Badge>
                      ) : list.length === 0 ? (
                        <span className="text-xs text-faint">Not collected yet</span>
                      ) : bad.length ? (
                        <Badge tone="warn">{bad.length} failed</Badge>
                      ) : (
                        <Badge tone="ok">{ok} OK</Badge>
                      )}
                    </Td>
                    <Td className="text-xs text-muted">{!m.supported ? m.unsupportedReason : (bad[0]?.detail ?? "")}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Sync history" description="Failed runs never erase earlier data." />
        {!runs?.length ? (
          <EmptyState title="No syncs yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Started</Th>
                <Th>Trigger</Th>
                <Th>Result</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const stats = (r.stats ?? {}) as Record<string, number>;
                const duration = r.finished_at ? Math.max(0, Date.parse(r.finished_at) - Date.parse(r.started_at)) : null;
                return (
                  <tr key={r.id}>
                    <Td className="text-xs">
                      <TimeAgo iso={r.started_at} />
                      {duration !== null ? <span className="text-faint"> · {(duration / 1000).toFixed(1)}s</span> : null}
                    </Td>
                    <Td className="text-xs text-muted">{r.trigger}</Td>
                    <Td>
                      <Badge tone={r.status === "succeeded" ? "ok" : r.status === "partial" ? "warn" : r.status === "running" ? "info" : "crit"}>{r.status}</Badge>
                    </Td>
                    <Td className="text-xs text-muted">
                      {r.error_message ??
                        [
                          stats.resourcesDiscovered !== undefined ? `${stats.resourcesDiscovered} resources discovered` : null,
                          stats.samplesStored !== undefined ? `${stats.samplesStored} samples stored` : null,
                          stats.metricErrors ? `${stats.metricErrors} metric errors` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
