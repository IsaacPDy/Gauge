"use client";

import { Calculator, ExternalLink } from "lucide-react";
import { CostProjectionChart } from "@/components/charts";
import { useCurrency } from "@/components/currency";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, StatCard, Table, Td, Th, type Tone } from "@/components/ui";
import type { SimulationResult, VerdictKind } from "@/lib/engine/simulate";
import { CATALOG, SERVICE_LABELS } from "@/lib/engine/simulate/catalog";
import { formatAmount, formatPerUser, formatQps } from "@/lib/engine/simulate/format";
import { convertUsd, formatUsdAs } from "@/lib/currency";
import { formatCount } from "@/lib/units";
import { MonthSelect } from "./month-select";
import { PlanLimits } from "./plan-limits";

const FIXED_KEYS = new Set(["base", "compute", "credit"]);
const VERDICT: Record<VerdictKind, { title: string; tone: Tone }> = {
  add_cache: { title: "Add a cache", tone: "accent" },
  no_cache_needed: { title: "No cache needed", tone: "ok" },
  upgrade_compute: { title: "Upgrade compute instead", tone: "warn" },
  no_tier_fits: { title: "No compute size fits", tone: "crit" },
  not_applicable: { title: "Cache comparison not available", tone: "neutral" },
};

export function SimulatorResults({ result, month, onMonth, query }: { result: SimulationResult; month: number; onMonth: (m: number) => void; query: string }) {
  const display = useCurrency();
  const usd = (n: number) => formatUsdAs(n, display);
  const services = result.provenance.map((p) => p.service);
  if (services.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Calculator className="size-8" />} title="Pick at least one service">
          Turn on Supabase, Firebase, Vercel or Cloudflare to see estimated costs.
        </EmptyState>
      </Card>
    );
  }

  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  const selected = result.months[month - 1] ?? first;
  const labels = Object.fromEntries(services.map((s) => [s, SERVICE_LABELS[s]]));
  const chartData = result.months.map((m) => ({
    month: m.restricted ? `M${m.month} ⚠` : `M${m.month}`,
    restricted: m.restricted,
    ...Object.fromEntries(services.map((s) => [s, convertUsd(m.totalsByService[s] ?? 0, display)])),
    ...Object.fromEntries(services.map((s) => [`restricted_${s}`, m.items.some((i) => i.service === s && i.restricted)])),
  }));
  const verdict = VERDICT[result.verdict.kind];
  const anyRestricted = result.months.some((m) => m.restricted);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Month 1" value={usd(first.total)} hint="per month, estimated" />
        <StatCard label="Month 12" value={usd(last.total)} hint={`${formatCount(last.usage.mau)} MAU`} />
        <StatCard label="Cost per MAU" value={first.usage.mau > 0 ? formatPerUser(first.total / first.usage.mau, display) : "—"} hint="month 1" />
        <StatCard
          label="Peak DB load"
          value={result.backend !== null ? `${formatQps(first.usage.peakDbQps)} q/s` : "—"}
          hint={
            result.backend === "supabase"
              ? `month 1, ${CATALOG.compute.find((c) => c.key === first.computeSize)?.label} compute`
              : result.backend === "firebase"
                ? "month 1, Firestore scales automatically"
                : "No database is on"
          }
        />
      </div>

      {/* The cache comparison only means something when there is a database to put a cache in front of. */}
      {result.backend === "supabase" ? (
        <Notice tone={verdict.tone} title={verdict.title}>
          <p>{result.verdict.message}</p>
          {/* Month 1 is the verdict itself, so only a later payoff is worth saying. */}
          {result.verdict.kind !== "add_cache" && result.verdict.paysOffMonth !== null && result.verdict.paysOffMonth > 1 ? (
            <p className="mt-1">A cache starts paying off in month {result.verdict.paysOffMonth}.</p>
          ) : null}
        </Notice>
      ) : null}

      <PlanLimits result={result} month={month} onMonth={onMonth} compareHref={`/simulator/compare?${query}`} />

      <Card>
        <CardHeader title="12-month projection" description="Monthly cost by service. Growth compounds each month." />
        <CardBody>
          <CostProjectionChart data={chartData} keys={services} labels={labels} currency={display.currency} />
          {anyRestricted ? (
            <p className="mt-2 text-xs text-muted">Months marked ⚠ go over a free plan limit, so a paid plan would be needed. Hatched bars show which service.</p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What happens when" />
        <CardBody>
          {result.events.length === 0 ? (
            <p className="text-sm text-muted">No plan limits, overages or compute changes within 12 months.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {result.events.map((e) => (
                <li key={e.key} className="flex items-start gap-3 text-sm">
                  {/* credit_used_up and overage_start fall through to "warn". */}
                  <Badge tone={e.kind === "plan_limit" || e.kind === "compute_saturated" ? "crit" : e.kind === "cache_pays_off" ? "accent" : "warn"} className="mt-0.5 shrink-0">
                    Month {e.month}
                  </Badge>
                  <span>
                    <span className="font-medium text-text">{SERVICE_LABELS[e.service]}:</span> {e.message}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Line items"
          description="Usage, included allowance and estimated cost per service."
          actions={<MonthSelect months={result.months.length} value={month} onChange={onMonth} />}
        />
        <Table className="min-w-[34rem]">
          <thead>
            <tr>
              <Th>Item</Th>
              <Th className="text-right">Usage</Th>
              <Th className="text-right">Included</Th>
              <Th className="text-right">Billable</Th>
              <Th className="text-right">Cost</Th>
            </tr>
          </thead>
          {services.map((s) => (
            <tbody key={s}>
              <tr>
                <Td colSpan={5} className="bg-surface-2 text-xs font-semibold text-text">
                  {SERVICE_LABELS[s]}
                </Td>
              </tr>
              {selected.items
                .filter((i) => i.service === s)
                .map((i) => {
                  const fixed = FIXED_KEYS.has(i.key);
                  return (
                    <tr key={i.key}>
                      <Td className="min-w-44">
                        {i.label}
                        {i.restricted ? (
                          <Badge tone="crit" className="ml-2">
                            Over plan limit
                          </Badge>
                        ) : null}
                        {i.note ? <p className="text-xs text-muted">{i.note}</p> : null}
                      </Td>
                      <Td className="num text-right">{fixed ? "—" : formatAmount(i.usage, i.unit)}</Td>
                      <Td className="num text-right">{fixed ? "—" : formatAmount(i.included, i.unit)}</Td>
                      <Td className="num text-right">{fixed ? "—" : formatAmount(i.billable, i.unit)}</Td>
                      <Td className="num text-right font-medium">{usd(i.cost)}</Td>
                    </tr>
                  );
                })}
              <tr>
                <Td colSpan={4} className="text-right text-xs text-muted">
                  Subtotal
                </Td>
                <Td className="num text-right font-semibold">{usd(selected.totalsByService[s] ?? 0)}</Td>
              </tr>
            </tbody>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader title="Where the prices come from" />
        <CardBody>
          <ul className="flex flex-col gap-1.5 text-sm">
            {result.provenance.map((p) => (
              <li key={`${p.service}:${p.plan}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text">{p.label}</span>
                <span className="text-xs text-muted">
                  version {p.version}, checked {p.verifiedAt}
                </span>
                {p.stale ? <Badge tone="warn">May be outdated</Badge> : null}
                <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  Source <ExternalLink className="size-3" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Estimates from published prices and your assumptions. Not a bill.</p>
        </CardBody>
      </Card>
    </div>
  );
}
