"use client";

import { useId } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { currencySymbol, type DisplayCurrency } from "@/lib/currency";
import { formatCount, formatMoney, formatValue, niceTicks } from "@/lib/units";

export interface TrendPoint {
  day: string;
  value: number | null;
  partial?: boolean;
  projected?: number | null;
}

const axisTick = { fontSize: 11, fill: "var(--muted)" };
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function TooltipBox({ title, rows }: { title: string; rows: [string, string, string?][] }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-text">{title}</p>
      {rows.map(([label, value, color]) => (
        <p key={label} className="flex items-center justify-between gap-4 text-muted">
          <span className="flex items-center gap-1.5">
            {color ? <span className="inline-block size-2 rounded-sm" style={{ background: color }} aria-hidden /> : null}
            {label}
          </span>
          <span className="num font-medium text-text">{value}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Single-series usage history with the applicable limit and the forecast projection.
 * Missing days are gaps, never zeros.
 */
export function UsageTrendChart({
  points,
  unit,
  limit,
  limitLabel,
  seriesLabel,
  height = 260,
}: {
  points: TrendPoint[];
  unit: string;
  limit: number | null;
  limitLabel?: string;
  seriesLabel: string;
  height?: number;
}) {
  const fmt = (v: number) => formatValue(v, unit);
  const max = Math.max(limit ?? 0, ...points.map((p) => Math.max(p.value ?? 0, p.projected ?? 0)));
  const ticks = niceTicks(max, unit);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={24} />
          <YAxis
            tickFormatter={fmt}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={64}
            ticks={ticks}
            domain={[0, ticks[ticks.length - 1]]}
          />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as TrendPoint;
              const rows: [string, string, string?][] = [];
              if (p.value !== null) rows.push([p.partial ? `${seriesLabel} (day in progress)` : seriesLabel, fmt(p.value), "var(--chart-1)"]);
              else rows.push([seriesLabel, "No data"]);
              if (p.projected !== null && p.projected !== undefined) rows.push(["Projection (estimate)", fmt(p.projected), "var(--muted)"]);
              if (limit !== null) rows.push([limitLabel ?? "Limit", fmt(limit)]);
              return <TooltipBox title={shortDay(String(label))} rows={rows} />;
            }}
          />
          {limit !== null ? (
            <ReferenceLine
              y={limit}
              stroke="var(--crit)"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{ value: `${limitLabel ?? "Limit"} ${fmt(limit)}`, position: "insideTopRight", fontSize: 11, fill: "var(--crit)" }}
              ifOverflow="extendDomain"
            />
          ) : null}
          <Line
            type="monotone"
            dataKey="value"
            name={seriesLabel}
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="projected"
            name="Projection"
            stroke="var(--muted)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={false}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

/** Stacked daily breakdown by provider dimension (max 4 series, fixed color order). */
export function BreakdownChart({
  data,
  keys,
  labels,
  unit,
  height = 220,
}: {
  data: Record<string, number | string>[];
  keys: string[];
  labels: Record<string, string>;
  unit: string;
  height?: number;
}) {
  const fmt = (v: number) => formatValue(v, unit);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={16} />
          <YAxis tickFormatter={fmt} tick={axisTick} tickLine={false} axisLine={false} width={64} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const rows = keys.map((k, i): [string, string, string] => [labels[k] ?? k, fmt(Number(payload[0].payload[k] ?? 0)), SERIES_COLORS[i]]);
              return <TooltipBox title={shortDay(String(label))} rows={rows} />;
            }}
          />
          <Legend
            iconType="square"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, color: "var(--muted)" }}
            formatter={(v: string) => <span style={{ color: "var(--muted)" }}>{labels[v] ?? v}</span>}
          />
          {keys.slice(0, 4).map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              stackId="a"
              fill={SERIES_COLORS[i]}
              stroke="var(--surface)"
              strokeWidth={2}
              radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Monthly cost stacked by service. A service's bar is hatched in months where it goes over
 * a plan limit (`restricted_<key>` on the row). Values are already in `currency`.
 */
export function CostProjectionChart({
  data,
  keys,
  labels,
  currency = "USD",
  height = 260,
}: {
  data: Record<string, number | string | boolean>[];
  keys: string[];
  labels: Record<string, string>;
  currency?: DisplayCurrency;
  height?: number;
}) {
  const money = (v: number) => formatMoney(v, currency);
  const series = keys.slice(0, 4);
  // Pattern ids are document-global, so scope them to this chart instance.
  const uid = useId().replace(/:/g, "");
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="20%">
          <defs>
            {series.map((k, i) => (
              <pattern key={k} id={`${uid}-hatch-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={SERIES_COLORS[i]} />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface)" strokeWidth="3" />
              </pattern>
            ))}
          </defs>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="month" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
          <YAxis tickFormatter={(v: number) => `${currencySymbol(currency)}${formatCount(v)}`} tick={axisTick} tickLine={false} axisLine={false} width={64} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as Record<string, number | string | boolean>;
              const rows: [string, string, string?][] = series.map((k, i) => [labels[k] ?? k, money(Number(row[k] ?? 0)), SERIES_COLORS[i]]);
              rows.push(["Total", money(series.reduce((s, k) => s + Number(row[k] ?? 0), 0))]);
              return <TooltipBox title={row.restricted ? `${label} · over a plan limit` : String(label)} rows={rows} />;
            }}
          />
          <Legend
            iconType="square"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, color: "var(--muted)" }}
            formatter={(v: string) => <span style={{ color: "var(--muted)" }}>{labels[v] ?? v}</span>}
          />
          {series.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              stackId="a"
              fill={SERIES_COLORS[i]}
              stroke="var(--surface)"
              strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={String(d.month)} fill={d[`restricted_${k}`] ? `url(#${uid}-hatch-${k})` : SERIES_COLORS[i]} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
