"use client";

import clsx from "clsx";
import Link from "next/link";
import { useCurrency } from "@/components/currency";
import { Badge, Card, CardBody, CardHeader, type Tone } from "@/components/ui";
import { formatUsdAs } from "@/lib/currency";
import type { LimitBar, LimitState, PayFromFirstUnit, SimulationResult } from "@/lib/engine/simulate";
import { formatAmount } from "@/lib/engine/simulate/format";
import { limitBars } from "@/lib/engine/simulate/limits";
import { formatPercent } from "@/lib/units";
import { MonthSelect } from "./month-select";

const FILL: Record<LimitState, string> = { ok: "bg-ok", near: "bg-warn", paying: "bg-accent", blocked: "bg-crit" };

function badgeFor(bar: LimitBar, month: number, usd: (n: number) => string): { tone: Tone; text: string } | null {
  const later = bar.hitsLimitMonth !== null && bar.hitsLimitMonth > month ? bar.hitsLimitMonth : null;
  switch (bar.state) {
    case "blocked":
      return { tone: "crit", text: bar.notOnPlan ? "Not on this plan" : "Over the limit: needs a paid plan" };
    case "paying":
      return { tone: "accent", text: `Over by ${formatAmount(bar.used - bar.included, bar.unit)} · ${usd(bar.overageCost)}/mo` };
    case "near":
      return { tone: "warn", text: later ? `Near the limit · passed in month ${later}` : "Near the limit" };
    case "ok":
      return later ? { tone: "neutral", text: `Passes the limit in month ${later}` } : null;
  }
}

export function LimitBarRow({ bar, month }: { bar: LimitBar; month: number }) {
  const display = useCurrency();
  const width = Math.min(100, bar.pct);
  const usage = bar.notOnPlan ? `${formatAmount(bar.used, bar.unit)} used` : `${formatAmount(bar.used, bar.unit)} of ${formatAmount(bar.included, bar.unit)}`;
  const badge = badgeFor(bar, month, (n) => formatUsdAs(n, display));
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="font-medium text-text">{bar.label}</span>
        <span className="num text-xs text-muted">{usage}</span>
      </div>
      <div className="flex items-center gap-2">
        <div
          className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-label={bar.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(width)}
          aria-valuetext={bar.notOnPlan ? `Not on this plan, ${usage}` : `${formatPercent(bar.pct)} of the allowance, ${usage}`}
        >
          <div className={clsx("absolute inset-y-0 left-0 rounded-full", FILL[bar.state])} style={{ width: `${width}%` }} />
        </div>
        <span className="num w-14 shrink-0 text-right text-xs font-medium text-text">{bar.notOnPlan ? "—" : formatPercent(bar.pct)}</span>
      </div>
      {badge ? (
        <div>
          {/* Badges are nowrap by default; these are long enough to need wrapping in a narrow plan card. */}
          <Badge tone={badge.tone} className="whitespace-normal!">
            {badge.text}
          </Badge>
        </div>
      ) : null}
    </li>
  );
}

export function LimitList({ bars, payFromFirst, month }: { bars: LimitBar[]; payFromFirst: PayFromFirstUnit[]; month: number }) {
  const display = useCurrency();
  return (
    <>
      {bars.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {bars.map((b) => (
            <LimitBarRow key={b.key} bar={b} month={month} />
          ))}
        </ul>
      ) : null}
      {payFromFirst.length > 0 ? (
        <p className={clsx("text-xs text-muted", bars.length > 0 && "mt-3")}>
          Billed from the first unit: {payFromFirst.map((p) => `${p.label} ${formatAmount(p.used, p.unit)} · ${formatUsdAs(p.cost, display)}`).join("; ")}
        </p>
      ) : null}
    </>
  );
}

export function PlanLimits({ result, month, onMonth, compareHref }: { result: SimulationResult; month: number; onMonth: (m: number) => void; compareHref: string }) {
  const { bars, payFromFirst } = limitBars(result, month);
  return (
    <Card>
      <CardHeader
        title="Plan limits"
        description="How close this month's usage is to each plan's allowance, and what you pay past it."
        actions={
          <>
            <MonthSelect months={result.months.length} value={month} onChange={onMonth} label="Month for plan limits" />
            <Link href={compareHref} className="text-xs font-medium text-accent hover:underline">
              Compare plans
            </Link>
          </>
        }
      />
      <CardBody className="flex flex-col gap-5">
        {result.provenance.map((p) => {
          const own = bars.filter((b) => b.service === p.service);
          const first = payFromFirst.filter((f) => f.service === p.service);
          if (own.length === 0 && first.length === 0) return null;
          return (
            <section key={p.service}>
              <h3 className="mb-2 text-xs font-semibold text-text">{p.label}</h3>
              <LimitList bars={own} payFromFirst={first} month={month} />
            </section>
          );
        })}
      </CardBody>
    </Card>
  );
}
