import type { Aggregation } from "../types";
import type { DailyValue } from "./usage";
import { type Cycle, DAY_MS, dayKey, daysUntil, startOfUtcDay } from "./time";

export type ForecastStatus = "ok" | "insufficient_data" | "stale" | "no_data";
export type Confidence = "low" | "medium" | "high";

export interface Forecast {
  status: ForecastStatus;
  /** cycle_run_rate for cumulative/incremental metrics, linear_growth for gauges. */
  method: "cycle_run_rate" | "linear_growth";
  /** Estimated value at the end of the billing cycle. */
  projected: number | null;
  projectedPercent: number | null;
  /** Average daily usage (or growth for gauges) over the observation window. */
  avgDaily: number | null;
  observations: number;
  windowDays: number;
  lastObservationDay: string | null;
  /** When the limit is expected to be crossed (ISO), if that happens within the horizon. */
  crossingAt: string | null;
  alreadyExceeded: boolean;
  confidence: Confidence | null;
  remainingDays: number;
}

export interface ForecastInput {
  aggregation: Aggregation;
  /** Daily values ending at or before today; must include the current cycle. */
  daily: DailyValue[];
  current: number | null;
  cycle: Cycle;
  now: Date;
  limit: number | null;
  /** Up to this many valid daily observations are averaged (PRD: initially 7). */
  windowDays?: number;
  /** Fewer valid observations than this produce no forecast. */
  minObservations?: number;
  /** A last observation older than this many days marks the forecast stale. */
  maxStaleDays?: number;
  /** Gauges do not reset, so their crossing date may lie beyond the cycle (capped here). */
  gaugeHorizonDays?: number;
}

interface Observation {
  day: string;
  amount: number;
}

/**
 * Valid daily observations of "usage per day", newest last.
 * Only complete days strictly before today are used; today is still in progress.
 */
export function dailyObservations(aggregation: Aggregation, daily: DailyValue[], cycle: Cycle, now: Date): Observation[] {
  const today = dayKey(now);
  const cycleStartDay = dayKey(cycle.start);
  const done = daily.filter((d) => d.day < today);
  const out: Observation[] = [];

  if (aggregation === "incremental") {
    for (const d of done) if (d.complete && d.value !== null) out.push({ day: d.day, amount: d.value });
    return out;
  }

  const byDay = new Map(done.map((d) => [d.day, d]));
  for (const d of done) {
    if (!d.complete || d.value === null) continue;
    if (aggregation === "cumulative") {
      // Cycle-to-date counters reset at the cycle boundary: never difference across it.
      if (d.day < cycleStartDay) continue;
      if (d.day === cycleStartDay) {
        out.push({ day: d.day, amount: d.value });
        continue;
      }
    }
    const prevDay = new Date(Date.parse(d.day) - DAY_MS).toISOString().slice(0, 10);
    const prev = byDay.get(prevDay);
    if (!prev || !prev.complete || prev.value === null) continue;
    const delta = d.value - prev.value;
    // A decreasing cumulative counter means a reset or a data problem, not negative usage.
    if (aggregation === "cumulative" && delta < 0) continue;
    out.push({ day: d.day, amount: delta });
  }
  return out;
}

function confidenceFor(amounts: number[], windowDays: number): Confidence {
  const n = amounts.length;
  const mean = amounts.reduce((a, b) => a + b, 0) / n;
  const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : variance === 0 ? 0 : Infinity;
  if (n >= windowDays && cv <= 0.35) return "high";
  if (n >= Math.min(5, windowDays) && cv <= 0.75) return "medium";
  return "low";
}

/**
 * Deterministic projection (PRD FR-09):
 *   projected = current usage + (recent average daily usage × remaining days)
 * Reproducible from stored history: the same inputs always give the same output.
 */
export function forecast(input: ForecastInput): Forecast {
  const {
    aggregation,
    daily,
    current,
    cycle,
    now,
    limit,
    windowDays = 7,
    minObservations = 3,
    maxStaleDays = 2,
    gaugeHorizonDays = 90,
  } = input;
  const method = aggregation === "gauge" ? "linear_growth" : "cycle_run_rate";
  const remainingDays = daysUntil(now, cycle.end);
  const base: Forecast = {
    status: "no_data",
    method,
    projected: null,
    projectedPercent: null,
    avgDaily: null,
    observations: 0,
    windowDays,
    lastObservationDay: null,
    crossingAt: null,
    alreadyExceeded: limit !== null && current !== null && current >= limit,
    confidence: null,
    remainingDays,
  };
  if (current === null) return base;

  // Look back at most twice the window so very old data cannot drive the estimate.
  const earliest = dayKey(new Date(startOfUtcDay(now).getTime() - windowDays * 2 * DAY_MS));
  const obs = dailyObservations(aggregation, daily, cycle, now).filter((o) => o.day >= earliest);
  const window = obs.slice(-windowDays);
  const lastObservationDay = window.length ? window[window.length - 1].day : null;

  if (window.length < minObservations) {
    return { ...base, status: "insufficient_data", observations: window.length, lastObservationDay };
  }
  const staleCutoff = dayKey(new Date(startOfUtcDay(now).getTime() - (maxStaleDays + 1) * DAY_MS));
  if (lastObservationDay! < staleCutoff) {
    return { ...base, status: "stale", observations: window.length, lastObservationDay };
  }

  const amounts = window.map((o) => o.amount);
  const avgDaily = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const projected = Math.max(0, current + avgDaily * remainingDays);

  let crossingAt: string | null = null;
  if (limit !== null && current < limit && avgDaily > 0) {
    const days = (limit - current) / avgDaily;
    const at = new Date(now.getTime() + days * DAY_MS);
    const horizon = aggregation === "gauge" ? new Date(now.getTime() + gaugeHorizonDays * DAY_MS) : cycle.end;
    if (at < horizon) crossingAt = at.toISOString();
  }

  return {
    ...base,
    status: "ok",
    projected,
    projectedPercent: limit ? (projected / limit) * 100 : null,
    avgDaily,
    observations: window.length,
    lastObservationDay,
    crossingAt,
    confidence: confidenceFor(amounts, windowDays),
  };
}
