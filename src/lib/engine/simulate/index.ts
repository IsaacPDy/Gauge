import { round2 } from "../cost";
import { DAY_MS } from "../time";
import { CATALOG, type Catalog, type Service, sheetFor } from "./catalog";
import type { SimInputs } from "./inputs";
import { enabledPlans, priceMonth } from "./price";
import { cacheVerdict, chooseCompute, collectEvents, type MonthResult, type SimulationResult } from "./project";
import { resolveStack } from "./stack";
import { workloadMonths } from "./workload";

export type { CacheVerdict, EventKind, MonthResult, Provenance, SimEvent, SimulationResult, VerdictKind } from "./project";
export type { LineItem } from "./price";

const STALE_AFTER_DAYS = 90;

export function simulate(inputs: SimInputs, opts: { catalog?: Catalog; now?: Date; months?: number } = {}): SimulationResult {
  const catalog = opts.catalog ?? CATALOG;
  const now = opts.now ?? new Date();
  const horizon = opts.months ?? 12;
  const { stack, notices } = resolveStack(inputs);

  const months: MonthResult[] = workloadMonths(inputs, stack, stack.cache, horizon).map((usage) => {
    const compute = chooseCompute(stack, usage, inputs, catalog);
    const items = priceMonth(usage, stack, compute.key, catalog);
    const totalsByService: Partial<Record<Service, number>> = {};
    for (const it of items) totalsByService[it.service] = round2((totalsByService[it.service] ?? 0) + it.cost);
    return {
      month: usage.month,
      usage,
      items,
      totalsByService,
      total: round2(items.reduce((s, i) => s + i.cost, 0)),
      restricted: items.some((i) => i.restricted),
      computeSize: compute.key,
      computeFits: compute.fits,
    };
  });

  const verdict = cacheVerdict(inputs, stack, catalog, horizon);
  const provenance = enabledPlans(stack).flatMap(({ service, plan }) => {
    const sheet = sheetFor(catalog, service, plan);
    if (!sheet) return [];
    const ageDays = (now.getTime() - Date.parse(`${sheet.verifiedAt}T00:00:00Z`)) / DAY_MS;
    return [{ service, plan, label: sheet.label, version: sheet.version, verifiedAt: sheet.verifiedAt, sourceUrl: sheet.sourceUrl, stale: ageDays > STALE_AFTER_DAYS }];
  });

  return { months, verdict, events: collectEvents(months, verdict, stack, inputs, catalog), notices, provenance };
}
