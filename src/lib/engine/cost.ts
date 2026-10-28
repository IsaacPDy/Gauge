import type { PricingRule } from "../types";

export interface CostEstimate {
  status: "estimated" | "unavailable";
  reason?: string;
  currency?: string;
  pricingRuleId?: string;
  pricingVersion?: string;
  verifiedAt?: string;
  includedQuantity?: number;
  /** Overage cost for usage so far this cycle. */
  currentOverageCost?: number;
  /** Overage cost if the forecast holds until the cycle ends. */
  projectedOverageCost?: number;
  notes?: string;
}

/** Cost of `usage` above the rule's included allowance. Never negative. */
export function overageCost(
  usage: number,
  rule: Pick<PricingRule, "includedQuantity" | "unitSize" | "unitPrice" | "billingMode">,
): number {
  const excess = Math.max(0, usage - rule.includedQuantity);
  if (excess === 0) return 0;
  const units = excess / rule.unitSize;
  const billedUnits = rule.billingMode === "package" ? Math.ceil(units) : units;
  return round2(billedUnits * rule.unitPrice);
}

export interface PriceTier {
  /** Upper bound in usage units, counted from zero; null for no bound. */
  upTo: number | null;
  unitPrice: number;
}

/** Graduated pricing: each tier's price applies to the units inside it that are above the included quantity. */
export function graduatedCost(usage: number, includedQuantity: number, tiers: PriceTier[], unitSize = 1): number {
  let total = 0;
  let lower = 0;
  for (const tier of tiers) {
    const upper = tier.upTo ?? Infinity;
    const units = Math.max(0, Math.min(usage, upper) - Math.max(lower, includedQuantity));
    total += (units / unitSize) * tier.unitPrice;
    lower = upper;
  }
  return round2(total);
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function estimateCost(
  rule: PricingRule | null,
  current: number | null,
  projected: number | null,
  context: { unavailableReason?: string } = {},
): CostEstimate {
  if (!rule) {
    return { status: "unavailable", reason: context.unavailableReason ?? "No pricing rule for this metric and plan" };
  }
  if (current === null) return { status: "unavailable", reason: "No usage data" };
  return {
    status: "estimated",
    currency: rule.currency,
    pricingRuleId: rule.id,
    pricingVersion: rule.version,
    verifiedAt: rule.verifiedAt,
    includedQuantity: rule.includedQuantity,
    currentOverageCost: overageCost(current, rule),
    projectedOverageCost: projected === null ? undefined : overageCost(projected, rule),
    notes: rule.notes,
  };
}

/** Sums amounts per currency. Different currencies are never added together. */
export function totalsByCurrency(items: { amount: number; currency: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.currency] = round2((out[it.currency] ?? 0) + it.amount);
  return out;
}
