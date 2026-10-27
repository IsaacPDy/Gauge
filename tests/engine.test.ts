import { describe, expect, it } from "vitest";
import { billingCycle, daysUntil } from "@/lib/engine/time";
import { currentUsage, dailySeries, type UsagePoint } from "@/lib/engine/usage";
import { dailyObservations, forecast } from "@/lib/engine/forecast";
import { estimateCost, overageCost, totalsByCurrency } from "@/lib/engine/cost";
import { evaluateAlerts, highestCrossed, normalizeThresholds, type QuotaStateForAlerts } from "@/lib/engine/alerts";
import { connectionHealth } from "@/lib/engine/health";
import { DEFAULT_THRESHOLDS, type PricingRule } from "@/lib/types";
import { formatBytes, formatValue, parseQuantity } from "@/lib/units";

const d = (s: string) => new Date(s);

function pt(scopeId: string, day: string, value: number, quality: UsagePoint["quality"] = "ok"): UsagePoint {
  const start = d(`${day}T00:00:00Z`);
  return {
    scopeId,
    bucketStart: start,
    bucketEnd: new Date(start.getTime() + 86_400_000),
    value,
    observedAt: d(`${day}T23:00:00Z`),
    quality,
  };
}

describe("billingCycle", () => {
  it("uses the calendar month for anchor day 1", () => {
    const c = billingCycle(d("2026-10-09T12:00:00Z"), 1);
    expect(c.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("rolls back to the previous month before the anchor day", () => {
    const c = billingCycle(d("2026-10-09T12:00:00Z"), 15);
    expect(c.start.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("crosses year boundaries", () => {
    const c = billingCycle(d("2027-01-03T00:00:00Z"), 20);
    expect(c.start.toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2027-01-20T00:00:00.000Z");
  });

  it("starts a new cycle exactly at the anchor instant", () => {
    const c = billingCycle(d("2026-10-15T00:00:00Z"), 15);
    expect(c.start.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("rejects anchor days that do not exist in every month", () => {
    expect(() => billingCycle(new Date(), 31)).toThrow(RangeError);
  });

  it("computes fractional remaining days", () => {
    expect(daysUntil(d("2026-10-30T12:00:00Z"), d("2026-11-01T00:00:00Z"))).toBe(1.5);
  });
});

describe("currentUsage", () => {
  const cycle = billingCycle(d("2026-10-09T12:00:00Z"), 1);

  it("sums incremental buckets inside the cycle only", () => {
    const pts = [pt("a", "2026-09-30", 1000), pt("a", "2026-10-01", 10), pt("a", "2026-10-02", 20)];
    const u = currentUsage("incremental", pts, cycle, ["a"]);
    expect(u.value).toBe(30);
  });

  it("uses the latest cumulative reading inside the cycle (no double counting)", () => {
    const pts = [pt("a", "2026-09-30", 900), pt("a", "2026-10-03", 40), pt("a", "2026-10-05", 70)];
    expect(currentUsage("cumulative", pts, cycle, ["a"]).value).toBe(70);
  });

  it("uses the latest gauge reading, even from before the cycle", () => {
    const pts = [pt("a", "2026-09-28", 5), pt("a", "2026-09-29", 6)];
    expect(currentUsage("gauge", pts, cycle, ["a"]).value).toBe(6);
  });

  it("returns null instead of zero when there is no data", () => {
    const u = currentUsage("incremental", [], cycle, ["a", "b"]);
    expect(u.value).toBeNull();
    expect(u.partial).toBe(false);
  });

  it("sums across scopes and flags partial coverage", () => {
    const pts = [pt("a", "2026-10-02", 100), pt("b", "2026-10-02", 50)];
    const u = currentUsage("gauge", pts, cycle, ["a", "b", "c"]);
    expect(u.value).toBe(150);
    expect(u.partial).toBe(true);
    expect(u.scopesWithData).toBe(2);
  });
});

describe("dailySeries", () => {
  it("marks days complete only when every scope reported", () => {
    const pts = [pt("a", "2026-10-01", 1), pt("b", "2026-10-01", 2), pt("a", "2026-10-02", 3)];
    const s = dailySeries("incremental", pts, ["a", "b"], d("2026-10-01T00:00:00Z"), d("2026-10-04T00:00:00Z"));
    expect(s).toEqual([
      { day: "2026-10-01", value: 3, complete: true },
      { day: "2026-10-02", value: 3, complete: false },
      { day: "2026-10-03", value: null, complete: false },
    ]);
  });
});

describe("forecast", () => {
  const now = d("2026-10-11T12:00:00Z");
  const cycle = billingCycle(now, 1);

  function series(values: Record<string, number>) {
    return dailySeries(
      "incremental",
      Object.entries(values).map(([day, v]) => pt("a", day, v)),
      ["a"],
      cycle.start,
      now,
    );
  }

  it("applies projected = current + avg daily × remaining days", () => {
    const vals: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) vals[`2026-10-${String(i).padStart(2, "0")}`] = 100;
    const daily = series(vals);
    const f = forecast({ aggregation: "incremental", daily, current: 1050, cycle, now, limit: 2500 });
    expect(f.status).toBe("ok");
    expect(f.avgDaily).toBe(100);
    expect(f.observations).toBe(7);
    // 20.5 days remain in October from Oct 11 12:00
    expect(f.remainingDays).toBeCloseTo(20.5);
    expect(f.projected).toBeCloseTo(1050 + 100 * 20.5);
    expect(f.crossingAt).toBe("2026-10-26T00:00:00.000Z");
    expect(f.confidence).toBe("high");
  });

  it("refuses to forecast with too few observations", () => {
    const daily = series({ "2026-10-09": 50, "2026-10-10": 60 });
    const f = forecast({ aggregation: "incremental", daily, current: 120, cycle, now, limit: 1000 });
    expect(f.status).toBe("insufficient_data");
    expect(f.projected).toBeNull();
  });

  it("marks the forecast stale when recent observations are missing", () => {
    const daily = series({ "2026-10-01": 50, "2026-10-02": 60, "2026-10-03": 55, "2026-10-04": 58 });
    const f = forecast({ aggregation: "incremental", daily, current: 223, cycle, now, limit: 1000 });
    expect(f.status).toBe("stale");
    expect(f.projected).toBeNull();
  });

  it("never differences cumulative counters across the cycle reset", () => {
    const pts = [
      pt("a", "2026-09-29", 900),
      pt("a", "2026-09-30", 950),
      pt("a", "2026-10-01", 10),
      pt("a", "2026-10-02", 25),
      pt("a", "2026-10-03", 45),
    ];
    const daily = dailySeries("cumulative", pts, ["a"], d("2026-09-29T00:00:00Z"), d("2026-10-04T00:00:00Z"));
    const obs = dailyObservations("cumulative", daily, billingCycle(d("2026-10-04T00:00:00Z"), 1), d("2026-10-04T06:00:00Z"));
    expect(obs.map((o) => o.amount)).toEqual([10, 15, 20]);
  });

  it("projects gauge growth and reports a crossing beyond the cycle", () => {
    const pts = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"].map((day, i) =>
      pt("a", day, 400 + i * 2),
    );
    const daily = dailySeries("gauge", pts, ["a"], d("2026-10-05T00:00:00Z"), now);
    const f = forecast({ aggregation: "gauge", daily, current: 410, cycle, now, limit: 500 });
    expect(f.status).toBe("ok");
    expect(f.avgDaily).toBe(2);
    expect(f.method).toBe("linear_growth");
    expect(f.crossingAt).not.toBeNull();
    expect(Date.parse(f.crossingAt!)).toBeGreaterThan(cycle.end.getTime());
  });

  it("is reproducible from the same inputs", () => {
    const daily = series({ "2026-10-07": 10, "2026-10-08": 30, "2026-10-09": 20, "2026-10-10": 40 });
    const a = forecast({ aggregation: "incremental", daily, current: 100, cycle, now, limit: 500 });
    const b = forecast({ aggregation: "incremental", daily, current: 100, cycle, now, limit: 500 });
    expect(a).toEqual(b);
  });
});

describe("cost", () => {
  const rule: PricingRule = {
    id: "r",
    provider: "supabase",
    metricKey: "m",
    plan: "pro",
    version: "2026-10",
    currency: "USD",
    includedQuantity: 2_000_000,
    unitPrice: 2,
    unitSize: 1_000_000,
    billingMode: "package",
    verifiedAt: "2026-10-09",
  };

  it("bills whole packages above the allowance", () => {
    expect(overageCost(1_999_999, rule)).toBe(0);
    expect(overageCost(2_000_001, rule)).toBe(2);
    expect(overageCost(3_400_000, rule)).toBe(4);
  });

  it("bills per unit when configured", () => {
    expect(overageCost(160_000, { ...rule, includedQuantity: 100_000, unitPrice: 0.00325, unitSize: 1, billingMode: "per_unit" })).toBe(195);
  });

  it("reports unavailable without a pricing rule instead of zero", () => {
    expect(estimateCost(null, 10, 20).status).toBe("unavailable");
  });

  it("never mixes currencies", () => {
    expect(totalsByCurrency([{ amount: 1, currency: "USD" }, { amount: 2, currency: "EUR" }, { amount: 3, currency: "USD" }])).toEqual({
      USD: 4,
      EUR: 2,
    });
  });
});

describe("alerts", () => {
  const now = d("2026-10-20T12:00:00Z");
  const cycle = billingCycle(now, 1);
  const rules = {
    quota_threshold: { enabled: true },
    forecast_breach: { enabled: true },
    cost_overage: { enabled: true },
    integration_health: { enabled: true },
  };
  const quota = (over: Partial<QuotaStateForAlerts> = {}): QuotaStateForAlerts => ({
    quotaId: "q1",
    metricKey: "supabase.database_size",
    metricName: "Database size",
    unit: "bytes",
    scopeName: "my-project",
    providerLabel: "Supabase",
    connectionId: "c1",
    accountId: null,
    resourceId: "r1",
    applicationId: null,
    applicationName: null,
    limit: 100,
    current: 80,
    percent: 80,
    cycle,
    dataUpdatedAt: now,
    stale: false,
    partialCoverage: false,
    overageEffect: "restriction",
    thresholds: DEFAULT_THRESHOLDS,
    forecast: null,
    cost: null,
    recommendedAction: "Do something",
    ...over,
  });
  const run = (quotas: QuotaStateForAlerts[], connections = []) =>
    evaluateAlerts({ now, staleAfterHours: 24, rules, quotas, connections, format: (v, u) => formatValue(v, u) });

  it("picks the highest crossed threshold", () => {
    expect(highestCrossed(80, DEFAULT_THRESHOLDS)?.percent).toBe(75);
    expect(highestCrossed(49.9, DEFAULT_THRESHOLDS)).toBeNull();
    expect(highestCrossed(100, DEFAULT_THRESHOLDS)?.severity).toBe("limit_reached");
  });

  it("creates one threshold alert keyed by quota, cycle and threshold", () => {
    const { candidates, evaluatedGroups } = run([quota()]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].dedupeKey).toBe(`quota:q1:${cycle.start.toISOString()}:75`);
    expect(candidates[0].severity).toBe("warning");
    expect(evaluatedGroups.has(`quota:q1:${cycle.start.toISOString()}`)).toBe(true);
  });

  it("produces the same dedupe key on repeated evaluation", () => {
    expect(run([quota()]).candidates[0].dedupeKey).toBe(run([quota({ current: 82, percent: 82 })]).candidates[0].dedupeKey);
  });

  it("never alerts on unknown limits or missing data", () => {
    expect(run([quota({ limit: null, percent: null })]).candidates).toHaveLength(0);
    expect(run([quota({ current: null, percent: null })]).candidates).toHaveLength(0);
  });

  it("alerts on a forecasted breach", () => {
    const { candidates } = run([
      quota({
        current: 40,
        percent: 40,
        forecast: {
          status: "ok",
          method: "cycle_run_rate",
          projected: 150,
          projectedPercent: 150,
          avgDaily: 10,
          observations: 7,
          windowDays: 7,
          lastObservationDay: "2026-10-19",
          crossingAt: "2026-10-26T12:00:00.000Z",
          alreadyExceeded: false,
          confidence: "high",
          remainingDays: 11.5,
        },
      }),
    ]);
    expect(candidates.map((c) => c.category)).toEqual(["forecast_breach"]);
    expect(candidates[0].message).toContain("projection");
  });

  it("flags failing and stale connections", () => {
    const { candidates } = run([], [
      {
        id: "c1",
        label: "Prod",
        providerName: "Supabase",
        status: "reauth_required",
        statusDetail: "Token expired",
        statusChangedAt: now,
        lastSuccessAt: null,
        createdAt: now,
      },
      {
        id: "c2",
        label: "Old",
        providerName: "Supabase",
        status: "connected",
        statusDetail: null,
        statusChangedAt: now,
        lastSuccessAt: d("2026-10-18T00:00:00Z"),
        createdAt: d("2026-10-01T00:00:00Z"),
      },
    ] as never);
    expect(candidates.map((c) => [c.connectionId, c.severity])).toEqual([
      ["c1", "critical"],
      ["c2", "warning"],
    ]);
  });

  it("validates custom thresholds", () => {
    expect(normalizeThresholds([{ percent: 80, severity: "warning" }, { percent: -1, severity: "info" }])).toEqual([
      { percent: 80, severity: "warning" },
    ]);
    expect(normalizeThresholds("nope")).toBeNull();
  });
});

describe("connection health", () => {
  const now = d("2026-10-20T12:00:00Z");
  it("treats failures as unreliable, not zero", () => {
    const h = connectionHealth({ status: "error", lastSuccessAt: now, createdAt: now, consecutiveFailures: 3 }, now, 24);
    expect(h.reliable).toBe(false);
  });
  it("detects stale data", () => {
    const h = connectionHealth(
      { status: "connected", lastSuccessAt: d("2026-10-18T00:00:00Z"), createdAt: d("2026-10-01T00:00:00Z"), consecutiveFailures: 0 },
      now,
      24,
    );
    expect(h.state).toBe("stale");
  });
});

describe("units", () => {
  it("formats and parses quantities", () => {
    expect(formatBytes(500 * 1024 ** 2)).toBe("500 MB");
    expect(parseQuantity("8 GB", "bytes")).toBe(8 * 1024 ** 3);
    expect(parseQuantity("100k", "count")).toBe(100_000);
    expect(parseQuantity("abc", "count")).toBeNull();
  });
});

describe("niceTicks", () => {
  it("rounds byte axes in display units", async () => {
    const { niceTicks } = await import("@/lib/units");
    const t = niceTicks(550 * 1024 ** 2, "bytes");
    expect(t.map((v) => v / 1024 ** 2)).toEqual([0, 200, 400, 600]);
    expect(niceTicks(278_000, "count")).toEqual([0, 100_000, 200_000, 300_000]);
  });
});

describe("failure handling", () => {
  it("pauses on auth errors and backs off on transient ones", async () => {
    const { failurePlan } = await import("@/lib/jobs/sync");
    const { ProviderError } = await import("@/lib/providers/types");
    const now = new Date("2026-10-09T00:00:00Z");
    const conn = { status: "connected", consecutive_failures: 0, sync_interval_minutes: 360 };
    expect(failurePlan(conn, new ProviderError("auth_invalid", "x"), now)).toMatchObject({ status: "reauth_required", nextSyncAt: null });
    const t1 = failurePlan(conn, new ProviderError("provider_unavailable", "x"), now);
    expect(t1.status).toBe("connected");
    expect(t1.nextSyncAt!.getTime() - now.getTime()).toBe(5 * 60_000);
    const t3 = failurePlan({ ...conn, consecutive_failures: 2 }, new ProviderError("network", "x"), now);
    expect(t3.status).toBe("error");
    expect(t3.nextSyncAt!.getTime() - now.getTime()).toBe(20 * 60_000);
  });

  it("lets a user quota override the provider quota for the same scope", async () => {
    const { effectiveQuotaIds } = await import("@/lib/jobs/recalc");
    const ids = effectiveQuotaIds([
      { id: "p", metric_key: "m", account_id: "a", resource_id: null, source: "provider" },
      { id: "u", metric_key: "m", account_id: "a", resource_id: null, source: "user" },
      { id: "p2", metric_key: "m", account_id: null, resource_id: "r", source: "provider" },
    ]);
    expect([...ids].sort()).toEqual(["p2", "u"]);
  });
});

describe("safeNext", () => {
  it("only allows same-site relative paths", async () => {
    const { safeNext } = await import("@/lib/urls");
    expect(safeNext("/usage?x=1")).toBe("/usage?x=1");
    expect(safeNext("//evil.com")).toBe("/home");
    expect(safeNext("/\\evil.com")).toBe("/home");
    expect(safeNext("https://evil.com")).toBe("/home");
    expect(safeNext(null)).toBe("/home");
  });
});
