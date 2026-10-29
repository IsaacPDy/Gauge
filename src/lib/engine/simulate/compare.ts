import { CATALOG, type Catalog, type Service, sheetFor } from "./catalog";
import { simulate } from "./index";
import type { CloudflareChoice, FirebaseChoice, SimInputs, SupabaseChoice, VercelChoice } from "./inputs";
import { type LimitBar, limitBars, type PayFromFirstUnit } from "./limits";
import { DIRECT_REASON, resolveStack } from "./stack";

export type Role = "backend" | "hosting" | "cache";

export const ROLES: { key: Role; label: string; description: string }[] = [
  { key: "backend", label: "Backend", description: "Database, auth, files, functions and realtime." },
  { key: "hosting", label: "API hosting", description: "Where your API runs." },
  { key: "cache", label: "Cache", description: "In front of a Supabase database." },
];

export const COMPARED_PLANS: { role: Role; service: Service; plan: string }[] = [
  { role: "backend", service: "supabase", plan: "free" },
  { role: "backend", service: "supabase", plan: "pro" },
  { role: "backend", service: "supabase", plan: "team" },
  { role: "backend", service: "firebase", plan: "spark" },
  { role: "backend", service: "firebase", plan: "blaze" },
  { role: "hosting", service: "vercel", plan: "hobby" },
  { role: "hosting", service: "vercel", plan: "pro" },
  { role: "hosting", service: "cloudflare", plan: "free" },
  { role: "hosting", service: "cloudflare", plan: "paid" },
  { role: "cache", service: "upstash", plan: "payg" },
];

export interface PlanVariant {
  role: Role;
  service: Service;
  plan: string;
  label: string;
  /** That service's monthly cost for the selected month. */
  total: number;
  bars: LimitBar[];
  payFromFirst: PayFromFirstUnit[];
  /** Some usage passes a limit this plan doesn't sell past. */
  overLimit: boolean;
  /** Why the plan can't be priced with these inputs, e.g. a cache with no Supabase database. */
  unavailable: string | null;
}

/** The user's inputs with one plan put in its role. A backend takes the files too, unless they live in R2. */
function variantInputs(inputs: SimInputs, service: Service, plan: string): SimInputs {
  const r2 = inputs.fileStore === "r2";
  switch (service) {
    case "supabase":
      return { ...inputs, supabase: plan as SupabaseChoice, firebase: "off", db: "supabase", fileStore: r2 ? "r2" : "supabase" };
    case "firebase":
      return { ...inputs, firebase: plan as FirebaseChoice, supabase: "off", db: "firebase", fileStore: r2 ? "r2" : "firebase" };
    case "vercel":
      return { ...inputs, vercel: plan as VercelChoice, host: "vercel" };
    case "cloudflare":
      return { ...inputs, cloudflare: plan as CloudflareChoice, host: "cloudflare" };
    case "upstash":
      return { ...inputs, cache: "upstash_payg" };
  }
}

/** Every plan of every service against the same workload, each in the role it would play. */
export function comparePlans(inputs: SimInputs, month: number, opts: { catalog?: Catalog; now?: Date } = {}): { variants: PlanVariant[]; notices: string[] } {
  const catalog = opts.catalog ?? CATALOG;
  const variants = COMPARED_PLANS.flatMap(({ role, service, plan }): PlanVariant[] => {
    const sheet = sheetFor(catalog, service, plan);
    if (!sheet) return [];
    const vi = variantInputs(inputs, service, plan);
    const base = { role, service, plan, label: sheet.label };
    if (service === "upstash") {
      const { stack } = resolveStack(vi);
      if (!stack.cache) return [{ ...base, total: 0, bars: [], payFromFirst: [], overLimit: false, unavailable: stack.cacheBlockedReason ?? DIRECT_REASON }];
    }
    const result = simulate(vi, { catalog, now: opts.now });
    const selected = result.months[month - 1] ?? result.months[0];
    const limits = limitBars(result, month);
    const bars = limits.bars.filter((b) => b.service === service);
    return [
      {
        ...base,
        total: selected?.totalsByService[service] ?? 0,
        bars,
        payFromFirst: limits.payFromFirst.filter((p) => p.service === service),
        overLimit: bars.some((b) => b.state === "blocked"),
        unavailable: null,
      },
    ];
  });
  // Each variant's own routing notices describe a stack you didn't pick, so only yours are reported.
  return { variants, notices: resolveStack(inputs).notices };
}

/** The cheapest plan with nothing over a limit; the first one on a tie. */
export function cheapestThatFits(variants: PlanVariant[]): PlanVariant | null {
  return variants.filter((v) => !v.overLimit && v.unavailable === null).reduce<PlanVariant | null>((best, v) => (best === null || v.total < best.total ? v : best), null);
}
