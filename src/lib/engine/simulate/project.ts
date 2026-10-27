import { formatMoney } from "../../units";
import { round2 } from "../cost";
import type { Catalog, ComputeKey, ComputeSize } from "./catalog";
import { formatQps } from "./format";
import type { SimInputs } from "./inputs";
import { type LineItem, priceMonth } from "./price";
import { DIRECT_REASON, NO_SUPABASE_REASON, type ResolvedStack } from "./stack";
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
  /** First month (1-based) in which a cache is the cheaper option, if any. */
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

const usd = (n: number) => formatMoney(n, "USD");

type MonthVerdict = Omit<CacheVerdict, "paysOffMonth">;

/** Compares "bigger compute, no cache" with "cache in front of the database" for each month. */
export function cacheVerdict(inputs: SimInputs, stack: ResolvedStack, catalog: Catalog, months: number): CacheVerdict {
  const na = stack.supabase === null ? NO_SUPABASE_REASON : stack.host === "direct" ? DIRECT_REASON : null;
  if (na) {
    return { kind: "not_applicable", message: na, monthlySaving: null, tierWithoutCache: null, tierWithCache: null, cacheFixesIt: null, paysOffMonth: null };
  }

  const sizes = sizesFor(stack, catalog);
  const largest = sizes[sizes.length - 1];
  const label = (s: ComputeSize | null) => s?.label ?? "none";
  const noCache = workloadMonths(inputs, stack, false, months);
  const withCache = workloadMonths(inputs, stack, true, months);

  const at = (i: number): MonthVerdict => {
    const tierNo = smallestFit(sizes, noCache[i], inputs);
    const tierWith = smallestFit(sizes, withCache[i], inputs);
    const costNo = dbSideCost(priceMonth(noCache[i], { ...stack, cache: false }, (tierNo ?? largest).key, catalog));
    const costWith = dbSideCost(priceMonth(withCache[i], { ...stack, cache: true }, (tierWith ?? largest).key, catalog));
    const qps = formatQps(noCache[i].peakDbQps);
    const base = { tierWithoutCache: tierNo?.key ?? null, tierWithCache: tierWith?.key ?? null, monthlySaving: null, cacheFixesIt: null };

    if (tierNo === null) {
      const plan = stack.supabase === "free" ? "Free plan " : "";
      const fix = tierWith
        ? ` With a cache, ${tierWith.label} compute is enough.`
        : ` A cache at a ${inputs.hitPct}% hit rate doesn't fix this either.`;
      return {
        ...base,
        kind: "no_tier_fits",
        cacheFixesIt: tierWith !== null,
        message: `No ${plan}compute size handles ${qps} queries/sec at ${inputs.headroomPct}% headroom.${fix}`,
      };
    }
    if (tierWith !== null && costWith < costNo) {
      const saving = round2(costNo - costWith);
      const keep = tierWith.key !== tierNo.key ? ` and keeps you on ${tierWith.label} instead of ${tierNo.label} compute` : ", mostly in egress";
      return { ...base, kind: "add_cache", monthlySaving: saving, message: `A cache saves about ${usd(saving)} a month${keep}.` };
    }
    if (tierNo.key === sizes[0].key) {
      return { ...base, kind: "no_cache_needed", message: `${label(tierNo)} compute handles your peak of ${qps} queries/sec, so a cache would only add cost.` };
    }
    return {
      ...base,
      kind: "upgrade_compute",
      message: `You need ${label(tierNo)} compute for ${qps} queries/sec. At a ${inputs.hitPct}% hit rate a cache costs more than the larger size.`,
    };
  };

  const verdicts = noCache.map((_, i) => at(i));
  const paysOff = verdicts.findIndex((v) => v.kind === "add_cache");
  return { ...verdicts[0], paysOffMonth: paysOff === -1 ? null : paysOff + 1 };
}
