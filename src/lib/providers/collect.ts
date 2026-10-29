import { DAY_MS, startOfUtcDay } from "../engine/time";
import type { MetricDefinition } from "../types";
import { type CollectResult, type MetricOutcome, type Observation, ProviderError, type ScopeRef } from "./types";

export function emptyResult(): CollectResult {
  return { observations: [], outcomes: [], quotas: [], costs: [] };
}

/** Revoked or expired credentials make the whole connection unusable, so they abort a run. */
export function isAuthFailure(e: unknown): boolean {
  return e instanceof ProviderError && (e.code === "auth_invalid" || e.code === "auth_expired");
}

/**
 * Records a failed read for every metric and scope. Missing permission reads as
 * "unavailable", anything else as "error". Authentication failures are rethrown.
 */
export function recordFailure(result: CollectResult, metricKeys: string[], scopes: ScopeRef[], e: unknown): void {
  if (isAuthFailure(e)) throw e;
  const err = e instanceof ProviderError ? e : new ProviderError("unknown", (e as Error)?.message ?? "Unknown error");
  const status: MetricOutcome["status"] = err.code === "permission_denied" ? "unavailable" : "error";
  for (const scope of scopes) {
    for (const metricKey of metricKeys) result.outcomes.push({ metricKey, scope, status, errorCode: err.code, detail: err.message });
  }
}

export function recordOk(result: CollectResult, metricKeys: string[], scopes: ScopeRef[]): void {
  for (const scope of scopes) for (const metricKey of metricKeys) result.outcomes.push({ metricKey, scope, status: "ok" });
}

export function recordUnsupported(result: CollectResult, metrics: MetricDefinition[], scope: ScopeRef): void {
  for (const m of metrics.filter((x) => !x.supported)) {
    result.outcomes.push({ metricKey: m.key, scope, status: "unsupported", detail: m.unsupportedReason });
  }
}

/** A one-day bucket. Today's bucket is still filling, so it defaults to "partial". */
export function dayObservation(
  metricKey: string,
  scope: ScopeRef,
  day: Date,
  value: number,
  now: Date,
  opts: { source?: Observation["source"]; quality?: Observation["quality"]; dimensions?: Record<string, number> } = {},
): Observation {
  const start = startOfUtcDay(day);
  const isToday = start.getTime() === startOfUtcDay(now).getTime();
  return {
    metricKey,
    scope,
    bucketStart: start,
    bucketEnd: new Date(start.getTime() + DAY_MS),
    value,
    observedAt: now,
    quality: opts.quality ?? (isToday ? "partial" : "ok"),
    source: opts.source ?? "provider",
    ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
  };
}

/** UTC day starts from `from` through `to`, inclusive. */
export function utcDays(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let t = startOfUtcDay(from).getTime(); t <= startOfUtcDay(to).getTime(); t += DAY_MS) days.push(new Date(t));
  return days;
}

/** Numbers sometimes arrive as strings; anything unparseable reads as null. */
export function toNumber(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
