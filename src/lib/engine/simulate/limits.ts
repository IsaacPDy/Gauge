import type { Service } from "./catalog";
import type { LineItem } from "./price";
import type { MonthResult } from "./project";

/** Same as the alerts' default warning threshold. */
export const NEAR_LIMIT_PCT = 75;

export type LimitState = "ok" | "near" | "paying" | "blocked";

export interface LimitBar {
  service: Service;
  key: string;
  label: string;
  unit: string;
  used: number;
  included: number;
  /** used ÷ included × 100, not capped. 100 for an item the plan doesn't offer. */
  pct: number;
  state: LimitState;
  /** USD for the usage past the included amount; 0 when blocked. */
  overageCost: number;
  /** First month whose usage passes the included amount, or null within the projection. */
  hitsLimitMonth: number | null;
  /** The plan doesn't offer this item at all (nothing included, no price). */
  notOnPlan: boolean;
}

export interface PayFromFirstUnit {
  service: Service;
  key: string;
  label: string;
  unit: string;
  used: number;
  cost: number;
}

const FIXED_KEYS = new Set(["base", "compute", "credit"]);

const over = (i: LineItem) => i.usage > i.included;

/** Usage against each plan allowance in one month, derived from the priced line items. */
export function limitBars(result: { months: Pick<MonthResult, "month" | "items">[] }, month: number): { bars: LimitBar[]; payFromFirst: PayFromFirstUnit[] } {
  const selected = result.months[month - 1] ?? result.months[0];
  const bars: LimitBar[] = [];
  const payFromFirst: PayFromFirstUnit[] = [];
  if (!selected) return { bars, payFromFirst };

  const firstOver = (it: LineItem) =>
    result.months.find((m) => m.items.some((x) => x.service === it.service && x.key === it.key && over(x)))?.month ?? null;

  for (const it of selected.items) {
    if (FIXED_KEYS.has(it.key)) continue;
    const base = { service: it.service, key: it.key, label: it.label, unit: it.unit, used: it.usage, included: it.included };
    if (it.included <= 0) {
      if (it.restricted) bars.push({ ...base, pct: 100, state: "blocked", overageCost: 0, hitsLimitMonth: firstOver(it), notOnPlan: true });
      else if (it.usage > 0) payFromFirst.push({ service: it.service, key: it.key, label: it.label, unit: it.unit, used: it.usage, cost: it.cost });
      continue;
    }
    const pct = (it.usage / it.included) * 100;
    const state: LimitState = it.restricted ? "blocked" : over(it) ? "paying" : pct >= NEAR_LIMIT_PCT ? "near" : "ok";
    bars.push({ ...base, pct, state, overageCost: state === "blocked" ? 0 : it.cost, hitsLimitMonth: firstOver(it), notOnPlan: false });
  }
  return { bars, payFromFirst };
}
