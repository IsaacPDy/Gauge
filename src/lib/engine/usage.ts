import type { Aggregation } from "../types";
import { type Cycle, DAY_MS, dayKey, startOfUtcDay } from "./time";

export type SampleQuality = "ok" | "partial" | "estimated";

export interface UsagePoint {
  /** The resource or account that produced the sample. */
  scopeId: string;
  bucketStart: Date;
  bucketEnd: Date;
  value: number;
  /** Provider data timestamp (not our collection time). */
  observedAt: Date;
  quality: SampleQuality;
}

export interface CurrentUsage {
  /** null means "no data". Missing data is never reported as zero. */
  value: number | null;
  /** Oldest of the newest observations across scopes: the whole total is at least this fresh. */
  asOf: Date | null;
  scopesWithData: number;
  scopesExpected: number;
  partial: boolean;
}

function inCycle(p: UsagePoint, cycle: Cycle) {
  const t = p.bucketStart.getTime();
  return t >= cycle.start.getTime() && t < cycle.end.getTime();
}

function latest(points: UsagePoint[]): UsagePoint | undefined {
  let best: UsagePoint | undefined;
  for (const p of points) {
    if (!best || p.bucketStart > best.bucketStart || (+p.bucketStart === +best.bucketStart && p.observedAt > best.observedAt)) {
      best = p;
    }
  }
  return best;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Usage of one scope for the cycle, according to the metric's aggregation semantics. */
function scopeUsage(aggregation: Aggregation, points: UsagePoint[], cycle: Cycle): { value: number; asOf: Date } | null {
  if (aggregation === "gauge") {
    const p = latest(points.filter((x) => x.bucketStart < cycle.end));
    return p ? { value: p.value, asOf: p.observedAt } : null;
  }
  const within = points.filter((p) => inCycle(p, cycle));
  if (within.length === 0) return null;
  if (aggregation === "cumulative") {
    const p = latest(within)!;
    return { value: p.value, asOf: p.observedAt };
  }
  let sum = 0;
  let asOf = within[0].observedAt;
  for (const p of within) {
    sum += p.value;
    if (p.observedAt > asOf) asOf = p.observedAt;
  }
  return { value: sum, asOf };
}

/**
 * Current-cycle usage summed across the expected scopes (e.g. all monitored projects of an
 * organization). Scopes without data make the result partial instead of counting as zero.
 */
export function currentUsage(
  aggregation: Aggregation,
  points: UsagePoint[],
  cycle: Cycle,
  expectedScopes: string[],
): CurrentUsage {
  const byScope = groupBy(points, (p) => p.scopeId);
  let total = 0;
  let asOf: Date | null = null;
  let withData = 0;
  for (const scope of expectedScopes) {
    const u = scopeUsage(aggregation, byScope.get(scope) ?? [], cycle);
    if (!u) continue;
    withData++;
    total += u.value;
    if (!asOf || u.asOf < asOf) asOf = u.asOf;
  }
  return {
    value: withData === 0 ? null : total,
    asOf,
    scopesWithData: withData,
    scopesExpected: expectedScopes.length,
    partial: withData > 0 && withData < expectedScopes.length,
  };
}

export interface DailyValue {
  day: string; // YYYY-MM-DD (UTC)
  /** Sum over scopes that reported. null when no scope reported that day. */
  value: number | null;
  /** True when every expected scope reported and no sample was partial. */
  complete: boolean;
}

/**
 * One value per UTC day between `from` (inclusive) and `to` (exclusive).
 * incremental: usage during the day. cumulative / gauge: last reading of the day.
 */
export function dailySeries(
  aggregation: Aggregation,
  points: UsagePoint[],
  expectedScopes: string[],
  from: Date,
  to: Date,
): DailyValue[] {
  const byScopeDay = new Map<string, Map<string, UsagePoint[]>>();
  for (const p of points) {
    const d = dayKey(p.bucketStart);
    let m = byScopeDay.get(p.scopeId);
    if (!m) byScopeDay.set(p.scopeId, (m = new Map()));
    const arr = m.get(d);
    if (arr) arr.push(p);
    else m.set(d, [p]);
  }

  const out: DailyValue[] = [];
  for (let t = startOfUtcDay(from).getTime(); t < to.getTime(); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    let sum = 0;
    let reported = 0;
    let anyPartial = false;
    for (const scope of expectedScopes) {
      const pts = byScopeDay.get(scope)?.get(day);
      if (!pts || pts.length === 0) continue;
      reported++;
      if (aggregation === "incremental") {
        for (const p of pts) {
          sum += p.value;
          if (p.quality === "partial") anyPartial = true;
        }
      } else {
        const p = latest(pts)!;
        sum += p.value;
        if (p.quality === "partial") anyPartial = true;
      }
    }
    out.push({
      day,
      value: reported === 0 ? null : sum,
      complete: reported === expectedScopes.length && reported > 0 && !anyPartial,
    });
  }
  return out;
}
