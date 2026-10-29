"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useCurrency } from "@/components/currency";
import { Badge, Card, CardBody, CardHeader, Notice, type Tone } from "@/components/ui";
import { formatUsdAs } from "@/lib/currency";
import { cheapestThatFits, comparePlans, type PlanVariant, ROLES } from "@/lib/engine/simulate/compare";
import { MonthSelect } from "../month-select";
import { LimitList } from "../plan-limits";
import { SimulatorForm } from "../simulator-form";
import { useSimInputs } from "../use-sim-inputs";

const MONTHS = 12;

function PlanCard({ variant: v, best, month }: { variant: PlanVariant; best: boolean; month: number }) {
  const display = useCurrency();
  const badge: { tone: Tone; text: string } | null = v.unavailable
    ? null
    : v.overLimit
      ? { tone: "crit", text: "Over limit" }
      : best
        ? { tone: "ok", text: "Cheapest that fits" }
        : { tone: "neutral", text: "Fits" };
  return (
    <div className={clsx("flex min-w-0 flex-col gap-3 rounded-md border p-3", best ? "border-ok/40" : "border-border")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{v.label}</h3>
          {v.unavailable ? null : (
            <>
              <p className="num text-lg font-semibold text-text">
                {formatUsdAs(v.total, display)}
                <span className="text-xs font-normal text-muted"> /mo</span>
              </p>
              {v.computeFits ? null : <p className="text-xs text-crit">Database compute can&apos;t keep up with this load on this plan.</p>}
            </>
          )}
        </div>
        {badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : null}
      </div>
      {v.unavailable ? <p className="text-sm text-muted">{v.unavailable}</p> : <LimitList bars={v.bars} payFromFirst={v.payFromFirst} month={month} />}
    </div>
  );
}

export function CompareView({ initialNotices, now }: { initialNotices: string[]; now: string }) {
  const [month, setMonth] = useState(1);
  const sim = useSimInputs(initialNotices, () => setMonth(1));
  const { variants, notices } = useMemo(() => comparePlans(sim.inputs, month, { now: new Date(now) }), [sim.inputs, month, now]);
  const allNotices = [...sim.urlNotices, ...notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <SimulatorForm inputs={sim.inputs} edited={sim.edited} onChange={sim.change} onPreset={sim.choosePreset} stackFields="routing" />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={`/simulator?${sim.query}`} className="text-sm font-medium text-accent hover:underline">
            <span aria-hidden>←</span> Back to simulator
          </Link>
          <MonthSelect months={MONTHS} value={month} onChange={setMonth} />
        </div>
        {allNotices.length > 0 ? (
          <Notice tone="warn" title="Some settings were adjusted">
            <ul className="list-disc pl-4">
              {allNotices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {ROLES.map((role) => {
          const own = variants.filter((v) => v.role === role.key);
          // A badge for the only plan in a role compares it with nothing.
          const best = own.length > 1 ? cheapestThatFits(own) : null;
          return (
            <Card key={role.key}>
              <CardHeader title={role.label} description={role.description} />
              <CardBody className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {own.map((v) => (
                  <PlanCard key={`${v.service}:${v.plan}`} variant={v} best={v === best} month={month} />
                ))}
                {role.key === "backend" && sim.inputs.cache !== "off" ? (
                  <p className="text-xs text-muted md:col-span-2 2xl:col-span-3">
                    Supabase plans include your cache&apos;s effect on database load; the cache itself is priced under Cache.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
        <p className="text-xs text-muted">Estimates from published prices and your assumptions. Not a bill.</p>
      </div>
    </div>
  );
}
