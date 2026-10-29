import { formatMoney } from "../../units";
import { round2 } from "../cost";
import { type Catalog, type ComputeKey, type ComputeSize, computeSize, type Service, sheetFor } from "./catalog";
import { formatAmount, formatQps } from "./format";
import type { Backend, SimInputs } from "./inputs";
import { enabledPlans, type LineItem, priceMonth } from "./price";
import { DIRECT_REASON, FIREBASE_BACKEND_REASON, NO_SUPABASE_REASON, type ResolvedStack } from "./stack";
import { type MonthUsage, workloadMonths } from "./workload";

export type VerdictKind = "add_cache" | "no_cache_needed" | "upgrade_compute" | "no_tier_fits" | "not_applicable";

export interface CacheVerdict {
  kind: VerdictKind;
  message: string;
  /** Month 1 saving, when the verdict is add_cache. */
  monthlySaving: number | null;
  tierWithoutCache: ComputeKey | null;
  tierWithCache: ComputeKey | null;
  cacheFixesIt: boolean | null;
  /** First month (1-based) in which a cache is the better option: cheaper, or needed to keep up with load. */
  paysOffMonth: number | null;
}

export function sizesFor(stack: ResolvedStack, catalog: Catalog): ComputeSize[] {
  if (stack.supabase === null) return [];
  if (stack.supabase === "free") return catalog.compute.filter((s) => s.key === catalog.freeCompute);
  return catalog.compute.filter((s) => s.key !== catalog.freeCompute);
}

function fits(size: ComputeSize, u: MonthUsage, inputs: SimInputs): boolean {
  const capacity = ((inputs.planningQps[size.key] ?? size.planningQps) * inputs.headroomPct) / 100;
  return u.peakDbQps <= capacity && u.peakConnections <= size.maxPoolerConnections;
}

function smallestFit(sizes: ComputeSize[], u: MonthUsage, inputs: SimInputs): ComputeSize | null {
  return sizes.find((s) => fits(s, u, inputs)) ?? null;
}

export function chooseCompute(stack: ResolvedStack, u: MonthUsage, inputs: SimInputs, catalog: Catalog): { key: ComputeKey | null; fits: boolean } {
  const sizes = sizesFor(stack, catalog);
  if (sizes.length === 0) return { key: null, fits: true };
  // Supabase only holds files here, so no database load reaches it.
  if (stack.backend !== "supabase") return { key: sizes[0].key, fits: true };
  if (stack.supabase !== "free" && stack.compute !== "auto") {
    const chosen = sizes.find((s) => s.key === stack.compute) ?? sizes[0];
    return { key: chosen.key, fits: fits(chosen, u, inputs) };
  }
  const pick = smallestFit(sizes, u, inputs);
  return pick ? { key: pick.key, fits: true } : { key: sizes[sizes.length - 1].key, fits: false };
}

function dbSideCost(items: LineItem[]): number {
  return round2(items.filter((i) => i.service === "supabase" || i.service === "upstash").reduce((s, i) => s + i.cost, 0));
}

function egressCost(items: LineItem[]): number {
  return items.filter((i) => i.service === "supabase" && i.key === "egress_gb").reduce((s, i) => s + i.cost, 0);
}

/** How amounts (in USD) appear in messages; callers pass one to show another currency. */
export type MoneyFormat = (usd: number) => string;
const usd: MoneyFormat = (n) => formatMoney(n, "USD");

type MonthVerdict = Omit<CacheVerdict, "paysOffMonth">;

/** Compares "bigger compute, no cache" with "cache in front of the database" for each month. */
export function cacheVerdict(inputs: SimInputs, stack: ResolvedStack, catalog: Catalog, months: number, money: MoneyFormat = usd): CacheVerdict {
  const na =
    stack.backend === "firebase" ? FIREBASE_BACKEND_REASON : stack.backend === null ? NO_SUPABASE_REASON : stack.host === "direct" ? DIRECT_REASON : null;
  if (na) {
    return { kind: "not_applicable", message: na, monthlySaving: null, tierWithoutCache: null, tierWithCache: null, cacheFixesIt: null, paysOffMonth: null };
  }

  const sizes = sizesFor(stack, catalog);
  const largest = sizes[sizes.length - 1];
  const noCache = workloadMonths(inputs, stack, false, months);
  const withCache = workloadMonths(inputs, stack, true, months);

  const at = (i: number): MonthVerdict => {
    const tierNo = smallestFit(sizes, noCache[i], inputs);
    const tierWith = smallestFit(sizes, withCache[i], inputs);
    const itemsNo = priceMonth(noCache[i], { ...stack, cache: false }, (tierNo ?? largest).key, catalog);
    const itemsWith = priceMonth(withCache[i], { ...stack, cache: true }, (tierWith ?? largest).key, catalog);
    const costNo = dbSideCost(itemsNo);
    const costWith = dbSideCost(itemsWith);
    const hit = inputs.hitPct;
    const hr = inputs.headroomPct;
    const qps = formatQps(noCache[i].peakDbQps);
    const base = { tierWithoutCache: tierNo?.key ?? null, tierWithCache: tierWith?.key ?? null, monthlySaving: null, cacheFixesIt: null };

    if (tierNo === null) {
      const problem =
        stack.supabase === "free"
          ? `The Free plan's ${sizes[0].label} compute can't handle ${qps} queries/sec at ${hr}% headroom.`
          : `No compute size handles ${qps} queries/sec at ${hr}% headroom.`;
      const fix = tierWith ? ` With a cache, ${tierWith.label} compute is enough.` : ` A cache serving ${hit}% of reads doesn't fix this either.`;
      const upsell = stack.supabase === "free" ? " Supabase Pro unlocks larger compute sizes." : "";
      return { ...base, kind: "no_tier_fits", cacheFixesIt: tierWith !== null, message: `${problem}${fix}${upsell}` };
    }
    if (tierWith !== null && costWith < costNo) {
      const saving = round2(costNo - costWith);
      if (tierWith.key === tierNo.key) {
        return { ...base, kind: "add_cache", monthlySaving: saving, message: `A cache saves about ${money(saving)} a month through lower egress, net of its own cost.` };
      }
      const computeSaved = computeSize(catalog, tierNo.key).monthlyPrice - computeSize(catalog, tierWith.key).monthlyPrice;
      const egressSaved = egressCost(itemsNo) - egressCost(itemsWith);
      const tail = egressSaved > computeSaved ? ", and lower egress accounts for most of the saving." : ".";
      return {
        ...base,
        kind: "add_cache",
        monthlySaving: saving,
        message: `A cache saves about ${money(saving)} a month: it keeps you on ${tierWith.label} instead of ${tierNo.label} compute${tail}`,
      };
    }
    // Upstash's fixed-price plans aren't modelled, so say so when pay-as-you-go commands are why the cache loses to more compute.
    const upstashItems = itemsWith.filter((it) => it.service === "upstash");
    const upstashTotal = upstashItems.reduce((s, it) => s + it.cost, 0);
    const commandsCost = upstashItems.filter((it) => it.key === "commands").reduce((s, it) => s + it.cost, 0);
    const paygNote =
      upstashItems.some((it) => it.key === "commands") && commandsCost > upstashTotal / 2
        ? " Most of the cache cost is pay-as-you-go commands; Upstash's fixed-price plans aren't modelled yet and may be cheaper."
        : "";
    if (tierNo.key === sizes[0].key) {
      return {
        ...base,
        kind: "no_cache_needed",
        message: `${tierNo.label} compute handles your peak of ${qps} queries/sec, so a cache would only add cost.`,
      };
    }
    const message =
      tierWith && tierWith.key !== tierNo.key
        ? `Without a cache you need ${tierNo.label} compute for ${qps} queries/sec. A cache serving ${hit}% of reads would let you use ${tierWith.label}, but it costs about ${money(round2(costWith - costNo))} a month more.`
        : `Without a cache you need ${tierNo.label} compute for ${qps} queries/sec, and a cache serving ${hit}% of reads wouldn't let you use a smaller size.`;
    return { ...base, kind: "upgrade_compute", message: `${message}${paygNote}` };
  };

  const verdicts = noCache.map((_, i) => at(i));
  const paysOff = verdicts.findIndex((v) => v.kind === "add_cache" || (v.kind === "no_tier_fits" && v.cacheFixesIt === true));
  return { ...verdicts[0], paysOffMonth: paysOff === -1 ? null : paysOff + 1 };
}

export type EventKind = "plan_limit" | "overage_start" | "credit_used_up" | "compute_upgrade" | "compute_saturated" | "cache_pays_off";

export interface SimEvent {
  /** Dedupe key. Most events fire once; compute upgrades can fire in several months. */
  key: string;
  month: number;
  kind: EventKind;
  service: Service;
  message: string;
}

export interface MonthResult {
  month: number;
  usage: MonthUsage;
  items: LineItem[];
  totalsByService: Partial<Record<Service, number>>;
  total: number;
  restricted: boolean;
  computeSize: ComputeKey | null;
  computeFits: boolean;
}

export interface Provenance {
  service: Service;
  plan: string;
  label: string;
  version: string;
  verifiedAt: string;
  sourceUrl: string;
  stale: boolean;
}

export interface SimulationResult {
  months: MonthResult[];
  /** Which service holds the database, or null with no backend on. */
  backend: Backend | null;
  verdict: CacheVerdict;
  events: SimEvent[];
  notices: string[];
  provenance: Provenance[];
}

export function collectEvents(
  months: MonthResult[],
  verdict: CacheVerdict,
  stack: ResolvedStack,
  inputs: SimInputs,
  catalog: Catalog,
  money: MoneyFormat = usd,
): SimEvent[] {
  const events: SimEvent[] = [];
  const seen = new Set<string>();
  const once = (e: SimEvent) => {
    if (seen.has(e.key)) return;
    seen.add(e.key);
    events.push(e);
  };
  const sizeIndex = (key: ComputeKey | null) => catalog.compute.findIndex((c) => c.key === key);
  const sizeOf = (key: ComputeKey | null) => catalog.compute.find((c) => c.key === key);
  const sizeLabel = (key: ComputeKey | null) => sizeOf(key)?.label ?? "";

  // Items a plan's usage credit offsets: their overages surface as one "credit used up" event per service.
  const credits = enabledPlans(stack).flatMap(({ service, plan }) => {
    const credit = sheetFor(catalog, service, plan)?.credit;
    if (!credit) return [];
    const keys = new Set(credit.appliesTo.filter((k) => k !== "compute"));
    return keys.size === 0 ? [] : [{ service, amount: credit.amount, keys }];
  });
  const creditCovers = (service: Service, key: string) => credits.some((c) => c.service === service && c.keys.has(key));

  months.forEach((m, i) => {
    for (const item of m.items) {
      const included = formatAmount(item.included, item.unit);
      if (item.restricted) {
        once({
          key: `limit:${item.service}:${item.key}`,
          month: m.month,
          kind: "plan_limit",
          service: item.service,
          message:
            item.included === 0
              ? `${item.label} aren't available on this plan. A paid plan is required.`
              : `Over the plan limit for ${item.label} (${included} included). A paid plan is required.`,
        });
      } else if (item.included > 0 && item.billable > 0 && item.cost > 0 && !creditCovers(item.service, item.key)) {
        const key = `overage:${item.service}:${item.key}`;
        // Month 1 is the starting state: its overages already show in the line items, so they never become events.
        if (m.month === 1) {
          seen.add(key);
          continue;
        }
        once({
          key,
          month: m.month,
          kind: "overage_start",
          service: item.service,
          message: `Overage charges start for ${item.label} above the included ${included}.`,
        });
      }
    }
    if (!m.computeFits) {
      once({
        key: "compute_saturated",
        month: m.month,
        kind: "compute_saturated",
        service: "supabase",
        message: `${sizeLabel(m.computeSize)} compute can't keep up with ${formatQps(m.usage.peakDbQps)} queries/sec at ${inputs.headroomPct}% headroom.`,
      });
    }
    const prev = months[i - 1];
    if (prev && stack.compute === "auto" && m.computeFits && sizeIndex(m.computeSize) > sizeIndex(prev.computeSize)) {
      const delta = (sizeOf(m.computeSize)?.monthlyPrice ?? 0) - (sizeOf(prev.computeSize)?.monthlyPrice ?? 0);
      events.push({
        key: `compute_upgrade:${m.month}`,
        month: m.month,
        kind: "compute_upgrade",
        service: "supabase",
        message: `Database load needs ${sizeLabel(m.computeSize)} compute (peak ${formatQps(m.usage.peakDbQps)} queries/sec), ${money(delta)} a month more than ${sizeLabel(prev.computeSize)}.`,
      });
    }
  });

  for (const c of credits) {
    const eligible = (m: MonthResult) => m.items.filter((it) => it.service === c.service && c.keys.has(it.key)).reduce((s, it) => s + it.cost, 0);
    // Already above the credit in month 1: that is the starting state, not an event.
    if (months.length === 0 || eligible(months[0]) > c.amount) continue;
    const m = months.find((x) => x.month > 1 && eligible(x) > c.amount);
    if (m) {
      once({
        key: `credit:${c.service}`,
        month: m.month,
        kind: "credit_used_up",
        service: c.service,
        message: `Usage now exceeds the ${money(c.amount)} monthly credit, so the bill rises above the plan fee.`,
      });
    }
  }

  // A month-1 payoff is the verdict card's headline already. Attributed to Supabase: Upstash may not be enabled.
  if (verdict.paysOffMonth !== null && verdict.paysOffMonth !== 1) {
    events.push({
      key: "cache_pays_off",
      month: verdict.paysOffMonth,
      kind: "cache_pays_off",
      service: "supabase",
      message: "From this month a cache is the better option: it costs less than it saves, or it's needed to keep up with load.",
    });
  }
  return events.sort((a, b) => a.month - b.month);
}
