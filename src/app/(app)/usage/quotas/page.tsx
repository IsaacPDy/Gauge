import Link from "next/link";
import { SubmitButton } from "@/components/form-controls";
import { SourceBadge, UsageBar } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { Badge, Card, CardHeader, EmptyState, Flash, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { loadInventory, loadQuotaViews, loadResourceUsage, type QuotaView } from "@/lib/data/views";
import { getAdapter, PROVIDER_NAMES } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { formatValue } from "@/lib/units";
import { applyPlanAllowance, deleteQuota } from "../actions";

export const metadata = { title: "Limits & quotas" };

const EFFECT_SHORT: Record<string, string> = {
  charges: "Billed",
  restriction: "Restricted",
  both: "Billed or restricted",
  none: "No effect",
  unknown: "Unknown",
};

function explorerHref(metricKey: string, scope: string) {
  return `/usage?${new URLSearchParams({ metric: metricKey, scope })}`;
}

export default async function QuotasPage({ searchParams }: PageProps<"/usage/quotas">) {
  const sp = await searchParams;
  const { supabase } = await getSession();
  const inv = await loadInventory(supabase);
  const quotas = await loadQuotaViews(supabase, inv);
  const monitored = inv.resources.filter((r) => r.is_monitored && r.status === "active");
  const usage = await loadResourceUsage(supabase, inv, monitored.map((r) => r.id));

  // Metrics with data but no applicable limit at resource or organization scope.
  const unknown: { resourceId: string; resourceName: string; metricKey: string; metricName: string; unit: string; value: number | null }[] = [];
  for (const r of monitored) {
    for (const m of getAdapter(r.provider)?.metrics.filter((x) => x.supported) ?? []) {
      const covered = quotas.some(
        (q) => q.metricKey === m.key && q.limit !== null && (q.resourceId === r.id || (q.accountId !== null && q.accountId === r.account_id)),
      );
      const u = usage.get(`${m.key}|${r.id}`);
      if (!covered && u) unknown.push({ resourceId: r.id, resourceName: r.name, metricKey: m.key, metricName: m.name, unit: m.unit, value: u.value });
    }
  }

  // Documented plan allowances that the user has not confirmed yet.
  const suggestions: { provider: string; plan: string; metricKey: string; metricName: string; unit: string; scope: "account" | "resource"; scopeIds: string[]; scopeLabel: string; limit: number; note: string; sourceUrl: string; verifiedAt: string }[] = [];
  for (const a of inv.accounts) {
    const adapter = getAdapter(a.provider);
    if (!adapter || !a.plan) continue;
    const resources = monitored.filter((r) => r.account_id === a.id);
    if (!resources.length) continue;
    for (const al of adapter.planAllowances.filter((x) => x.plan === a.plan)) {
      const metric = adapter.metrics.find((m) => m.key === al.metricKey)!;
      const ids =
        al.scope === "account"
          ? quotas.some((q) => q.metricKey === al.metricKey && q.accountId === a.id && q.source === "user")
            ? []
            : [a.id]
          : resources.filter((r) => !quotas.some((q) => q.metricKey === al.metricKey && q.resourceId === r.id && q.source === "user")).map((r) => r.id);
      if (!ids.length) continue;
      suggestions.push({
        provider: a.provider,
        plan: al.plan,
        metricKey: al.metricKey,
        metricName: metric.name,
        unit: metric.unit,
        scope: al.scope,
        scopeIds: ids,
        scopeLabel: al.scope === "account" ? a.name : `${ids.length} project${ids.length === 1 ? "" : "s"} in ${a.name}`,
        limit: al.limit,
        note: al.note,
        sourceUrl: al.sourceUrl,
        verifiedAt: al.verifiedAt,
      });
    }
  }

  const unsupported = [...new Set(monitored.map((r) => r.provider))].flatMap((p) =>
    (getAdapter(p)?.metrics.filter((m) => !m.supported) ?? []).map((m) => ({ ...m, providerName: PROVIDER_NAMES[p] })),
  );

  const sorted = [...quotas].sort((a, b) => a.scopeName.localeCompare(b.scopeName) || a.metricName.localeCompare(b.metricName));

  return (
    <>
      <PageHeader
        title="Limits & quotas"
        description="Provider-reported limits, limits you configured, and metrics whose limit is unknown. CloudWatch never substitutes an assumed value for an unknown limit."
        actions={<LinkButton href="/usage">Usage explorer</LinkButton>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      {suggestions.length ? (
        <Card className="mb-6 border-info/40">
          <CardHeader title="Suggested plan allowances" description="From the provider's published documentation. Review and confirm each one; they are not applied automatically." />
          <ul className="divide-y divide-border">
            {suggestions.map((s) => (
              <li key={`${s.metricKey}-${s.scopeIds.join()}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {s.metricName}: {formatValue(s.limit, s.unit)} <span className="font-normal text-muted">· {s.scopeLabel}</span>{" "}
                    <Badge>{s.plan} plan</Badge>
                  </p>
                  <p className="text-xs text-muted">
                    {s.note}{" "}
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      Source
                    </a>{" "}
                    · verified {s.verifiedAt}
                  </p>
                </div>
                <form action={applyPlanAllowance}>
                  <input type="hidden" name="provider" value={s.provider} />
                  <input type="hidden" name="plan" value={s.plan} />
                  <input type="hidden" name="metricKey" value={s.metricKey} />
                  <input type="hidden" name="scopeType" value={s.scope} />
                  {s.scopeIds.map((id) => (
                    <input key={id} type="hidden" name="scopeId" value={id} />
                  ))}
                  <input type="hidden" name="back" value="/usage/quotas" />
                  <SubmitButton size="sm" variant="secondary" pendingText="Applying…">
                    Confirm
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mb-6">
        <CardHeader title="Configured and provider-reported limits" description="Your own limit takes precedence over a provider-reported one for the same scope." />
        {sorted.length === 0 ? (
          <EmptyState title="No limits yet">Confirm a plan allowance above or set a limit from the usage explorer.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Metric</Th>
                <Th>Scope</Th>
                <Th>Limit</Th>
                <Th className="min-w-44">Used</Th>
                <Th>If exceeded</Th>
                <Th>Verified</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((q: QuotaView) => {
                const scope = q.resourceId ? `r:${q.resourceId}` : `a:${q.accountId}`;
                const overridden = q.evaluation && !q.evaluation.isEffective;
                return (
                  <tr key={q.id} className={overridden ? "opacity-60" : undefined}>
                    <Td className="whitespace-nowrap">
                      <Link href={explorerHref(q.metricKey, scope)} className="font-medium hover:underline">
                        {q.metricName}
                      </Link>
                      {q.isDemo ? (
                        <Badge tone="demo" className="ml-1.5">
                          Demo
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="min-w-36 text-xs">
                      {q.scopeName}
                      <span className="block text-muted">{q.scopeType === "account" ? "Organization-wide" : "Per resource"}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="num">{formatValue(q.limit, q.unit)}</span>{" "}
                      <SourceBadge kind={q.source} />
                      {overridden ? <span className="block text-xs text-muted">Overridden by your limit</span> : null}
                    </Td>
                    <Td>
                      {q.evaluation?.current === null || !q.evaluation ? (
                        <SourceBadge kind="missing" />
                      ) : (
                        <>
                          <UsageBar percent={q.evaluation.percent} projectedPercent={q.evaluation.forecast?.status === "ok" ? q.evaluation.forecast.projectedPercent : null} label={`${q.metricName} used`} />
                          <span className="num text-xs text-muted">
                            {formatValue(q.evaluation.current, q.unit)}
                            {q.evaluation.dataState === "stale" ? " · stale" : ""}
                            {q.evaluation.coverage.partial ? " · partial coverage" : ""}
                          </span>
                        </>
                      )}
                    </Td>
                    <Td className="text-xs text-muted">{EFFECT_SHORT[q.overageEffect]}</Td>
                    <Td className="text-xs text-muted">
                      <TimeAgo iso={q.verifiedAt} />
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      <Link href={explorerHref(q.metricKey, scope)} className="text-xs text-accent hover:underline">
                        {q.source === "user" ? "Edit" : "Override"}
                      </Link>
                      {q.source === "user" ? (
                        <form action={deleteQuota} className="inline">
                          <input type="hidden" name="quotaId" value={q.id} />
                          <input type="hidden" name="back" value="/usage/quotas" />
                          <SubmitButton variant="ghost" size="sm" confirm="Remove this limit?" className="ml-1">
                            Remove
                          </SubmitButton>
                        </form>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader title="Unknown limits" description="Metrics with data but no known allowance. No alerts can fire for these until you set a limit." />
        {unknown.length === 0 ? (
          <EmptyState title="Every collected metric has a limit" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Metric</Th>
                <Th>Resource</Th>
                <Th className="text-right">Current</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {unknown.map((u) => (
                <tr key={`${u.metricKey}-${u.resourceId}`}>
                  <Td className="font-medium">{u.metricName}</Td>
                  <Td className="text-muted">{u.resourceName}</Td>
                  <Td className="num text-right">{formatValue(u.value, u.unit)}</Td>
                  <Td className="text-right">
                    <span className="mr-2">
                      <SourceBadge kind="unknown" />
                    </span>
                    <Link href={explorerHref(u.metricKey, `r:${u.resourceId}`)} className="text-xs text-accent hover:underline">
                      Set limit
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {unsupported.length ? (
        <Card>
          <CardHeader title="Not available from the provider" description="Shown for transparency. Check these in the provider's own dashboard." />
          <Table>
            <tbody>
              {unsupported.map((m) => (
                <tr key={m.key}>
                  <Td className="font-medium">
                    {m.name} <span className="text-xs font-normal text-muted">· {m.providerName}</span>
                  </Td>
                  <Td>
                    <SourceBadge kind="unsupported" />
                  </Td>
                  <Td className="text-xs text-muted">{m.unsupportedReason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
