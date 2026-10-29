import { describe, expect, it } from "vitest";
import type { LineItem, MonthResult } from "@/lib/engine/simulate";
import { limitBars } from "@/lib/engine/simulate/limits";

function li(key: string, usage: number, included: number, extra: Partial<LineItem> = {}): LineItem {
  return { service: "supabase", key, label: key, unit: "GB", usage, included, billable: Math.max(0, usage - included), cost: 0, restricted: false, ...extra };
}
const result = (...months: LineItem[][]) => ({ months: months.map((items, i) => ({ month: i + 1, items }) as Pick<MonthResult, "month" | "items">) });

describe("limitBars", () => {
  it("returns a bar per item with an included quantity", () => {
    const { bars } = limitBars(result([li("egress_gb", 10, 100)]), 1);
    expect(bars).toEqual([
      { service: "supabase", key: "egress_gb", label: "egress_gb", unit: "GB", used: 10, included: 100, pct: 10, state: "ok", overageCost: 0, hitsLimitMonth: null, notOnPlan: false },
    ]);
  });

  it("is near the limit from 75 % up to and including 100 %", () => {
    const state = (used: number) => limitBars(result([li("x", used, 100)]), 1).bars[0].state;
    expect(state(74.9)).toBe("ok");
    expect(state(75)).toBe("near");
    expect(state(100)).toBe("near");
  });

  it("is paying past the limit on a paid plan, with the overage cost", () => {
    const [bar] = limitBars(result([li("x", 150, 100, { cost: 4.5 })]), 1).bars;
    expect(bar).toMatchObject({ pct: 150, state: "paying", overageCost: 4.5, hitsLimitMonth: 1 });
  });

  it("is blocked past the limit of a free plan", () => {
    const [bar] = limitBars(result([li("x", 150, 100, { restricted: true })]), 1).bars;
    expect(bar).toMatchObject({ state: "blocked", overageCost: 0, notOnPlan: false });
  });

  it("finds the first month the limit is passed", () => {
    const r = result([li("x", 50, 100)], [li("x", 100, 100)], [li("x", 120, 100)]);
    expect(limitBars(r, 1).bars[0].hitsLimitMonth).toBe(3);
    expect(limitBars(result([li("x", 50, 100)], [li("x", 60, 100)]), 1).bars[0].hitsLimitMonth).toBeNull();
  });

  it("leaves out fixed fees, compute and credits", () => {
    const { bars, payFromFirst } = limitBars(result([li("base", 1, 0, { cost: 25 }), li("compute", 1, 0, { cost: 10 }), li("credit", 1, 0, { cost: -10 })]), 1);
    expect(bars).toEqual([]);
    expect(payFromFirst).toEqual([]);
  });

  it("lists items billed from the first unit separately, when used", () => {
    const { bars, payFromFirst } = limitBars(result([li("commands", 2_000_000, 0, { unit: "commands", cost: 4 }), li("storage_gb", 0, 0)]), 1);
    expect(bars).toEqual([]);
    expect(payFromFirst).toEqual([{ service: "supabase", key: "commands", label: "commands", unit: "commands", used: 2_000_000, cost: 4 }]);
  });

  it("shows an item the plan doesn't offer only when it's used", () => {
    const used = limitBars(result([li("fn_invocations", 5, 0, { restricted: true })]), 1).bars;
    expect(used).toEqual([expect.objectContaining({ key: "fn_invocations", state: "blocked", pct: 100, notOnPlan: true, hitsLimitMonth: 1 })]);
    expect(limitBars(result([li("fn_invocations", 0, 0)]), 1).bars).toEqual([]);
  });

  it("reads the requested month and falls back to month 1", () => {
    const r = result([li("x", 10, 100)], [li("x", 80, 100)]);
    expect(limitBars(r, 2).bars[0].used).toBe(80);
    expect(limitBars(r, 9).bars[0].used).toBe(10);
    expect(limitBars({ months: [] }, 1)).toEqual({ bars: [], payFromFirst: [] });
  });
});
