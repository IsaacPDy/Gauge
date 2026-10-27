# Cost Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/simulator` page where a developer enters workload variables (MAU, traffic shape, DB hits, data sizes, growth), picks a mix of Supabase, Upstash Redis, Vercel and Cloudflare, and gets a 12-month cost projection with a cache-vs-compute verdict.

**Architecture:** A pure, deterministic engine in `src/lib/engine/simulate/` turns inputs into resolved stack → monthly usage → priced line items → projection, verdict and events. The page is a thin server component that decodes URL params, then hands off to a client component that re-runs the engine on every change and mirrors the inputs into the URL. There is no database or server work.

**Tech Stack:** Next.js 16 (app router), React 19, TypeScript, Tailwind 4, Recharts 3, zod 4, Vitest 5, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-27-cost-simulator-design.md`

**Deliberate deviations from the spec (decided while planning):**
- **Graduated `tiers` on price items are dropped.** No line item in the catalog uses them, so they would be dead code (YAGNI). Single-rate items reuse `overageCost()`.
- **`PriceItem` uses `includedQuantity`/`unitPrice`/`unitSize`/`billingMode`**, the same names as the existing `PricingRule`, so it can be passed straight to `overageCost()`.
- **The URL is synced with `window.history.replaceState`**, not `router.replace`. Next.js supports this natively, and it avoids re-running the server component on every keystroke.
- **Tests live in `tests/simulate/*.test.ts`** (one file per module), not a single `tests/simulate.test.ts`.
- **Each `SimEvent` carries a `key`**, its dedupe key, used for React keys and in tests.

**Conventions to follow:**
- Engine files use relative imports (`../cost`, `../../units`). App and test files use `@/…`.
- Comments are sparse. Write one only where the *why* isn't obvious, matching `src/lib/engine/*.ts`.
- Tests use `describe`/`it`/`expect` from `vitest`, as in `tests/engine.test.ts`.
- The dev server runs on port 3100 (`npm run dev`). The test login is in `.env.local` as `TEST_USER_EMAIL`/`TEST_USER_PASSWORD`. Never print these values.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/engine/cost.ts` (modify) | Widen `overageCost` parameter type; export `round2` |
| `src/lib/engine/simulate/catalog.ts` | Types + versioned price sheets + Supabase compute sizes |
| `src/lib/engine/simulate/inputs.ts` | `SimInputs`, field definitions, presets, `decode`/`encode`, `clampField` |
| `src/lib/engine/simulate/stack.ts` | Routing rules → `ResolvedStack` + notices |
| `src/lib/engine/simulate/workload.ts` | Inputs → `MonthUsage[]` |
| `src/lib/engine/simulate/format.ts` | Number formatting shared by engine messages and UI |
| `src/lib/engine/simulate/price.ts` | `MonthUsage` + stack → `LineItem[]` |
| `src/lib/engine/simulate/project.ts` | Compute choice, cache verdict, events, result types |
| `src/lib/engine/simulate/index.ts` | `simulate()` entry point + type re-exports |
| `src/components/charts.tsx` (modify) | Add `CostProjectionChart` |
| `src/components/nav.tsx` (modify) | Add "Simulator" nav item |
| `src/app/(app)/simulator/page.tsx` | Server shell: decode params, render view |
| `src/app/(app)/simulator/simulator-view.tsx` | Client state, URL sync, layout |
| `src/app/(app)/simulator/simulator-form.tsx` | Inputs |
| `src/app/(app)/simulator/simulator-results.tsx` | KPIs, verdict, chart, events, line items, provenance |
| `tests/simulate/fixtures.ts` | Test catalog + input/usage helpers |
| `tests/simulate/*.test.ts` | One test file per engine module |
| `README.md` (modify) | Document the simulator |

---

### Task 0: Decide on version control

The project folder is **not a git repository**, and every task below ends with a commit step.

- [ ] **Step 1: Ask the user**

Ask: "This folder isn't a git repository. Shall I run `git init` and make an initial commit of the current state before starting, so each task gets its own commit?"

- If **yes**: run the commands below, then follow each task's commit step as written.

```bash
cd "/Users/fiona/Documents/Apps/Cloud Watch" && git init && git add -A && git commit -m "chore: initial commit before cost simulator"
```

- If **no**: skip every "Commit" step in this plan.

`.gitignore` already exists. Check that it lists `.env.local` before the first `git add -A`:

```bash
grep -n "env" "/Users/fiona/Documents/Apps/Cloud Watch/.gitignore"
```

Expected: a line matching `.env*.local` or `.env.local`. If it's missing, add `.env*.local` to `.gitignore` first.

---

### Task 1: Prepare `cost.ts` for reuse

**Files:**
- Modify: `src/lib/engine/cost.ts:18-30`

- [ ] **Step 1: Widen `overageCost` and export `round2`**

In `src/lib/engine/cost.ts`, replace:

```ts
/** Cost of `usage` above the rule's included allowance. Never negative. */
export function overageCost(usage: number, rule: PricingRule): number {
```

with:

```ts
/** Cost of `usage` above the rule's included allowance. Never negative. */
export function overageCost(
  usage: number,
  rule: Pick<PricingRule, "includedQuantity" | "unitSize" | "unitPrice" | "billingMode">,
): number {
```

and replace:

```ts
function round2(n: number) {
```

with:

```ts
export function round2(n: number) {
```

- [ ] **Step 2: Run the existing tests and typecheck**

Run: `npm test -- tests/engine.test.ts && npm run typecheck`
Expected: all engine tests PASS, and typecheck reports no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/engine/cost.ts
git commit -m "refactor: let overageCost accept any priced item, export round2"
```

---

### Task 2: Price catalog

**Files:**
- Create: `src/lib/engine/simulate/catalog.ts`
- Test: `tests/simulate/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/simulate/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CATALOG, COMPUTE_KEYS, computeSize, sheetFor } from "@/lib/engine/simulate/catalog";

const PLANS: Record<string, string[]> = {
  supabase: ["free", "pro", "team"],
  upstash: ["payg"],
  vercel: ["hobby", "pro"],
  cloudflare: ["free", "paid"],
};

describe("CATALOG", () => {
  it("has exactly one sheet for every plan the simulator offers", () => {
    for (const [service, plans] of Object.entries(PLANS)) {
      for (const plan of plans) {
        expect(CATALOG.sheets.filter((s) => s.service === service && s.plan === plan)).toHaveLength(1);
      }
    }
    expect(CATALOG.sheets).toHaveLength(Object.values(PLANS).flat().length);
  });

  it("records provenance on every sheet", () => {
    for (const s of CATALOG.sheets) {
      expect(s.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.sourceUrl).toMatch(/^https:\/\//);
      expect(s.version).not.toBe("");
    }
  });

  it("only credits items that exist on the sheet (or compute)", () => {
    for (const s of CATALOG.sheets) {
      const keys = new Set(s.items.map((i) => i.key));
      for (const k of s.credit?.appliesTo ?? []) expect(k === "compute" || keys.has(k)).toBe(true);
    }
  });

  it("uses positive unit sizes and non-negative prices", () => {
    for (const s of CATALOG.sheets) {
      for (const i of s.items) {
        expect(i.unitSize).toBeGreaterThan(0);
        expect(i.includedQuantity).toBeGreaterThanOrEqual(0);
        if (i.unitPrice !== null) expect(i.unitPrice).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("lists compute sizes in COMPUTE_KEYS order, growing in price and capacity", () => {
    expect(CATALOG.compute.map((c) => c.key)).toEqual([...COMPUTE_KEYS]);
    for (let i = 1; i < CATALOG.compute.length; i++) {
      expect(CATALOG.compute[i].monthlyPrice).toBeGreaterThan(CATALOG.compute[i - 1].monthlyPrice);
      expect(CATALOG.compute[i].planningQps).toBeGreaterThanOrEqual(CATALOG.compute[i - 1].planningQps);
    }
    expect(CATALOG.freeCompute).toBe("nano");
  });

  it("looks up sheets and sizes", () => {
    expect(sheetFor(CATALOG, "supabase", "pro")?.label).toBe("Supabase Pro");
    expect(sheetFor(CATALOG, "supabase", "enterprise")).toBeUndefined();
    expect(computeSize(CATALOG, "small").label).toBe("Small");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/catalog.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate/catalog"`.

- [ ] **Step 3: Write the catalog**

Create `src/lib/engine/simulate/catalog.ts`:

```ts
// Published prices for the cost simulator. They come from pricing pages, not APIs, so
// every sheet records its source and the day it was checked. All amounts are USD.

export type Service = "supabase" | "upstash" | "vercel" | "cloudflare";

export const SERVICES: Service[] = ["supabase", "upstash", "vercel", "cloudflare"];

export const SERVICE_LABELS: Record<Service, string> = {
  supabase: "Supabase",
  upstash: "Upstash Redis",
  vercel: "Vercel",
  cloudflare: "Cloudflare",
};

export const COMPUTE_KEYS = ["nano", "micro", "small", "medium", "large", "xl", "2xl", "4xl", "8xl", "12xl", "16xl"] as const;
export type ComputeKey = (typeof COMPUTE_KEYS)[number];

export interface ComputeSize {
  key: ComputeKey;
  label: string;
  monthlyPrice: number;
  cpu: string;
  ramGB: number;
  maxDirectConnections: number;
  maxPoolerConnections: number;
  /** Assumption, not a published figure: Supabase does not publish query throughput. */
  planningQps: number;
}

export interface PriceItem {
  key: string;
  label: string;
  unit: string;
  includedQuantity: number;
  /** null: going over the included quantity is a restriction on this plan, not a charge. */
  unitPrice: number | null;
  /** Price applies per this many units. */
  unitSize: number;
  billingMode: "per_unit" | "package";
  note?: string;
}

export interface PriceSheet {
  service: Service;
  plan: string;
  label: string;
  version: string;
  verifiedAt: string; // YYYY-MM-DD
  sourceUrl: string;
  baseFee: number;
  perSeat?: boolean;
  /** Monthly credit offsetting the listed items (never the base fee). */
  credit?: { amount: number; appliesTo: string[] };
  items: PriceItem[];
}

export interface Catalog {
  sheets: PriceSheet[];
  /** Ascending by price. */
  compute: ComputeSize[];
  /** The only size available on Supabase Free. */
  freeCompute: ComputeKey;
}

function item(key: string, label: string, unit: string, includedQuantity: number, unitPrice: number | null, unitSize = 1, note?: string): PriceItem {
  return { key, label, unit, includedQuantity, unitPrice, unitSize, billingMode: "per_unit", ...(note ? { note } : {}) };
}

const VERSION = "2026-10";
// Set each of these to the day its values were checked against the source (Task 3).
const SUPABASE_VERIFIED = "2026-10-27";
const UPSTASH_VERIFIED = "2026-10-27";
const VERCEL_VERIFIED = "2026-10-27";
const CLOUDFLARE_VERIFIED = "2026-10-27";

const SUPABASE_PAID_ITEMS: PriceItem[] = [
  item("mau", "Monthly active users", "users", 100_000, 0.00325),
  item("db_disk_gb", "Database disk", "GB", 8, 0.125),
  item("storage_gb", "File storage", "GB", 100, 0.021),
  item("egress_gb", "Egress", "GB", 250, 0.09),
  item("fn_invocations", "Edge Function invocations", "calls", 2_000_000, 2, 1_000_000),
  item("rt_peak", "Realtime peak connections", "connections", 500, 10, 1_000),
  item("rt_messages", "Realtime messages", "messages", 5_000_000, 2.5, 1_000_000),
];

const R2_ITEMS: PriceItem[] = [
  item("r2_storage_gb", "R2 storage", "GB", 10, 0.015),
  item("r2_class_a", "R2 Class A operations (writes)", "ops", 1_000_000, 4.5, 1_000_000),
  item("r2_class_b", "R2 Class B operations (reads)", "ops", 10_000_000, 0.36, 1_000_000, "R2 egress is free."),
];

export const CATALOG: Catalog = {
  freeCompute: "nano",
  compute: [
    { key: "nano", label: "Nano", monthlyPrice: 0, cpu: "Shared", ramGB: 0.5, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 50 },
    { key: "micro", label: "Micro", monthlyPrice: 10, cpu: "2-core ARM (shared)", ramGB: 1, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 100 },
    { key: "small", label: "Small", monthlyPrice: 15, cpu: "2-core ARM (shared)", ramGB: 2, maxDirectConnections: 90, maxPoolerConnections: 400, planningQps: 200 },
    { key: "medium", label: "Medium", monthlyPrice: 60, cpu: "2-core ARM (shared)", ramGB: 4, maxDirectConnections: 120, maxPoolerConnections: 600, planningQps: 400 },
    { key: "large", label: "Large", monthlyPrice: 110, cpu: "2-core ARM (dedicated)", ramGB: 8, maxDirectConnections: 160, maxPoolerConnections: 800, planningQps: 800 },
    { key: "xl", label: "XL", monthlyPrice: 210, cpu: "4-core ARM", ramGB: 16, maxDirectConnections: 240, maxPoolerConnections: 1_000, planningQps: 1_500 },
    { key: "2xl", label: "2XL", monthlyPrice: 410, cpu: "8-core ARM", ramGB: 32, maxDirectConnections: 380, maxPoolerConnections: 1_500, planningQps: 3_000 },
    { key: "4xl", label: "4XL", monthlyPrice: 960, cpu: "16-core ARM", ramGB: 64, maxDirectConnections: 480, maxPoolerConnections: 3_000, planningQps: 6_000 },
    { key: "8xl", label: "8XL", monthlyPrice: 1_870, cpu: "32-core ARM", ramGB: 128, maxDirectConnections: 490, maxPoolerConnections: 6_000, planningQps: 12_000 },
    { key: "12xl", label: "12XL", monthlyPrice: 2_800, cpu: "48-core ARM", ramGB: 192, maxDirectConnections: 500, maxPoolerConnections: 9_000, planningQps: 18_000 },
    { key: "16xl", label: "16XL", monthlyPrice: 3_730, cpu: "64-core ARM", ramGB: 256, maxDirectConnections: 500, maxPoolerConnections: 12_000, planningQps: 24_000 },
  ],
  sheets: [
    {
      service: "supabase",
      plan: "free",
      label: "Supabase Free",
      version: VERSION,
      verifiedAt: SUPABASE_VERIFIED,
      sourceUrl: "https://supabase.com/pricing",
      baseFee: 0,
      items: [
        item("mau", "Monthly active users", "users", 50_000, null),
        item("db_disk_gb", "Database size", "GB", 0.5, null, 1, "The database turns read-only above this size."),
        item("storage_gb", "File storage", "GB", 1, null),
        item("egress_gb", "Egress", "GB", 5, null),
        item("fn_invocations", "Edge Function invocations", "calls", 500_000, null),
        item("rt_peak", "Realtime peak connections", "connections", 200, null),
        item("rt_messages", "Realtime messages", "messages", 2_000_000, null),
      ],
    },
    {
      service: "supabase",
      plan: "pro",
      label: "Supabase Pro",
      version: VERSION,
      verifiedAt: SUPABASE_VERIFIED,
      sourceUrl: "https://supabase.com/pricing",
      baseFee: 25,
      credit: { amount: 10, appliesTo: ["compute"] },
      items: SUPABASE_PAID_ITEMS,
    },
    {
      service: "supabase",
      plan: "team",
      label: "Supabase Team",
      version: VERSION,
      verifiedAt: SUPABASE_VERIFIED,
      sourceUrl: "https://supabase.com/pricing",
      baseFee: 599,
      credit: { amount: 10, appliesTo: ["compute"] },
      items: SUPABASE_PAID_ITEMS,
    },
    {
      service: "upstash",
      plan: "payg",
      label: "Upstash Redis pay as you go",
      version: VERSION,
      verifiedAt: UPSTASH_VERIFIED,
      sourceUrl: "https://upstash.com/pricing/redis",
      baseFee: 0,
      items: [item("commands", "Commands", "commands", 0, 0.2, 100_000), item("storage_gb", "Storage", "GB", 0, 0.25)],
    },
    {
      service: "vercel",
      plan: "hobby",
      label: "Vercel Hobby",
      version: VERSION,
      verifiedAt: VERCEL_VERIFIED,
      sourceUrl: "https://vercel.com/pricing",
      baseFee: 0,
      items: [
        item("edge_requests", "Edge requests", "requests", 1_000_000, null, 1, "Hobby is for non-commercial use."),
        item("fn_invocations", "Function invocations", "calls", 1_000_000, null),
        item("cpu_hours", "Active CPU", "hours", 4, null),
        item("transfer_gb", "Fast data transfer", "GB", 100, null),
      ],
    },
    {
      service: "vercel",
      plan: "pro",
      label: "Vercel Pro",
      version: VERSION,
      verifiedAt: VERCEL_VERIFIED,
      sourceUrl: "https://vercel.com/pricing",
      baseFee: 20,
      perSeat: true,
      credit: { amount: 20, appliesTo: ["edge_requests", "fn_invocations", "cpu_hours", "transfer_gb"] },
      items: [
        item("edge_requests", "Edge requests", "requests", 10_000_000, 2, 1_000_000),
        item("fn_invocations", "Function invocations", "calls", 1_000_000, 0.6, 1_000_000),
        item("cpu_hours", "Active CPU", "hours", 0, 0.128),
        item("transfer_gb", "Fast data transfer", "GB", 1_000, 0.15),
      ],
    },
    {
      service: "cloudflare",
      plan: "free",
      label: "Cloudflare Workers Free",
      version: VERSION,
      verifiedAt: CLOUDFLARE_VERIFIED,
      sourceUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
      baseFee: 0,
      items: [
        item("requests", "Workers requests", "requests", 3_000_000, null, 1, "100,000 a day, shown per month. Each request is limited to 10 ms CPU."),
        ...R2_ITEMS,
      ],
    },
    {
      service: "cloudflare",
      plan: "paid",
      label: "Cloudflare Workers Paid",
      version: VERSION,
      verifiedAt: CLOUDFLARE_VERIFIED,
      sourceUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
      baseFee: 5,
      items: [
        item("requests", "Workers requests", "requests", 10_000_000, 0.3, 1_000_000),
        item("cpu_ms", "Workers CPU time", "ms", 30_000_000, 0.02, 1_000_000),
        ...R2_ITEMS,
      ],
    },
  ],
};

export function sheetFor(catalog: Catalog, service: Service, plan: string): PriceSheet | undefined {
  return catalog.sheets.find((s) => s.service === service && s.plan === plan);
}

export function computeSize(catalog: Catalog, key: ComputeKey): ComputeSize {
  const size = catalog.compute.find((c) => c.key === key);
  if (!size) throw new Error(`Unknown compute size ${key}`);
  return size;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/catalog.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/catalog.ts tests/simulate/catalog.test.ts
git commit -m "feat(simulator): add versioned price catalog"
```

---

### Task 3: Verify catalog prices against official sources

The PRD and the spec forbid prices from memory. Every number in `catalog.ts` must be checked against its source before the feature ships. Use WebFetch, or the built-in browser's `get_page_text`.

**Files:**
- Modify: `src/lib/engine/simulate/catalog.ts`

- [ ] **Step 1: Check Supabase**

Fetch `https://supabase.com/pricing` and `https://supabase.com/docs/guides/platform/compute-and-disk`. Confirm or correct:

| Value in catalog | Where |
|---|---|
| Free: 50,000 MAU, 0.5 GB database, 1 GB storage, 5 GB egress, 500,000 function calls, 200 realtime peak, 2M messages | Free plan items |
| Pro $25, Team $599 base fee, $10 compute credit | `baseFee`, `credit` |
| Pro/Team: 100,000 MAU then $0.00325, 8 GB disk then $0.125/GB, 100 GB storage then $0.021/GB, 250 GB egress then $0.09/GB, 2M function calls then $2/M, 500 peak connections then $10/1000, 5M messages then $2.50/M | `SUPABASE_PAID_ITEMS` |
| Compute monthly prices, RAM, CPU, max direct and pooler connections for Nano through 16XL | `CATALOG.compute` |

If Supabase now splits egress into cached and uncached, keep the single `egress_gb` item at the **uncached** price and quota, and add a `note` saying so. Leave `planningQps` alone; it's an assumption.

- [ ] **Step 2: Check Upstash**

Fetch `https://upstash.com/pricing/redis`. Confirm pay-as-you-go: $0.20 per 100K commands and $0.25 per GB storage. If there's a monthly free allowance on pay as you go, set `includedQuantity` to it.

- [ ] **Step 3: Check Vercel**

Fetch `https://vercel.com/pricing` and `https://vercel.com/docs/pricing`. Confirm Hobby's included edge requests, invocations, active CPU hours and data transfer. Confirm Pro's $20/seat fee, $20 usage credit, and the included quantity and on-demand price for edge requests, function invocations, active CPU (per hour, default region) and fast data transfer.

- [ ] **Step 4: Check Cloudflare**

Fetch `https://developers.cloudflare.com/workers/platform/pricing/` and `https://developers.cloudflare.com/r2/pricing/`. Confirm: Free 100,000 requests a day with 10 ms CPU; Paid $5/month, 10M requests then $0.30/M, 30M CPU ms then $0.02/M; R2 10 GB then $0.015/GB-month, Class A 1M then $4.50/M, Class B 10M then $0.36/M.

- [ ] **Step 5: Record what you checked**

Edit every value that differs. Set `SUPABASE_VERIFIED`, `UPSTASH_VERIFIED`, `VERCEL_VERIFIED` and `CLOUDFLARE_VERIFIED` to the date you checked each one, in `YYYY-MM-DD`. If a source couldn't be loaded, leave that service's values as they are, set its `*_VERIFIED` to `"2000-01-01"` so the UI shows it as outdated, and tell the user which one.

- [ ] **Step 6: Run the catalog test**

Run: `npm test -- tests/simulate/catalog.test.ts`
Expected: PASS. If compute prices changed order, the ordering test still has to hold. Fix the data, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/engine/simulate/catalog.ts
git commit -m "chore(simulator): verify catalog prices against official pricing pages"
```

---

### Task 4: Inputs, presets and URL encoding

**Files:**
- Create: `src/lib/engine/simulate/inputs.ts`
- Test: `tests/simulate/inputs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/simulate/inputs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clampField, decode, encode, NUMBER_FIELDS, presetInputs } from "@/lib/engine/simulate/inputs";

const params = (q: string) => Object.fromEntries(new URLSearchParams(q));

describe("presets", () => {
  it("returns independent copies", () => {
    const a = presetInputs("small_saas");
    a.planningQps.small = 5;
    a.mau = 1;
    expect(presetInputs("small_saas").planningQps.small).toBeUndefined();
    expect(presetInputs("small_saas").mau).toBe(10_000);
  });

  it("keeps every preset value inside its field range", () => {
    for (const p of ["side_project", "small_saas", "consumer_app"] as const) {
      const inputs = presetInputs(p);
      for (const f of NUMBER_FIELDS) {
        const v = inputs[f.name];
        if (v === null) continue;
        expect(clampField(f, v)).toBe(v);
      }
    }
  });
});

describe("decode", () => {
  it("defaults to the Small SaaS preset with no notices", () => {
    const { inputs, notices } = decode({});
    expect(inputs).toEqual(presetInputs("small_saas"));
    expect(notices).toEqual([]);
  });

  it("loads the named preset", () => {
    expect(decode({ p: "consumer_app" }).inputs).toEqual(presetInputs("consumer_app"));
  });

  it("falls back on an unknown preset with a notice", () => {
    const { inputs, notices } = decode({ p: "nope" });
    expect(inputs.preset).toBe("small_saas");
    expect(notices).toHaveLength(1);
  });

  it("applies and clamps numbers", () => {
    const { inputs, notices } = decode(params("mau=-5&dau=500&seats=2.7&dbq=1000000"));
    expect(inputs.mau).toBe(0);
    expect(inputs.dauPct).toBe(100);
    expect(inputs.seats).toBe(3);
    expect(inputs.dbQueriesOverride).toBe(1_000_000);
    expect(notices).toEqual([]);
  });

  it("ignores unparsable numbers, unknown keys and bad enum values, with a notice each", () => {
    const { inputs, notices } = decode(params("mau=abc&kb=&zzz=1&sb=enterprise"));
    expect(inputs.mau).toBe(10_000);
    expect(inputs.responseKB).toBe(10);
    expect(inputs.supabase).toBe("pro");
    expect(notices).toHaveLength(4);
  });

  it("reads planning QPS overrides for known sizes only", () => {
    const { inputs, notices } = decode(params("qps.small=999&qps.bogus=5"));
    expect(inputs.planningQps).toEqual({ small: 999 });
    expect(notices).toHaveLength(1);
  });

  it("uses the first value of a repeated key", () => {
    expect(decode({ mau: ["5", "6"] }).inputs.mau).toBe(5);
  });
});

describe("encode", () => {
  it("writes only the preset for unchanged inputs", () => {
    expect(encode(presetInputs("small_saas"))).toBe("p=small_saas");
  });

  it("is stable through decode", () => {
    const q = "p=side_project&mau=1234&g=3";
    expect(encode(decode(params(q)).inputs)).toBe(q);
  });

  it("round-trips edited inputs", () => {
    const inputs = presetInputs("consumer_app");
    inputs.supabase = "team";
    inputs.compute = "large";
    inputs.mau = 777_000;
    inputs.dbQueriesOverride = 5_000_000;
    inputs.hitPct = 92;
    inputs.planningQps.medium = 650;
    expect(decode(params(encode(inputs))).inputs).toEqual(inputs);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/inputs.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate/inputs"`.

- [ ] **Step 3: Implement**

Create `src/lib/engine/simulate/inputs.ts`:

```ts
import { z } from "zod";
import { CATALOG, COMPUTE_KEYS, type ComputeKey } from "./catalog";

export const PRESETS = ["side_project", "small_saas", "consumer_app"] as const;
export type PresetKey = (typeof PRESETS)[number];
export const DEFAULT_PRESET: PresetKey = "small_saas";

export type SupabaseChoice = "off" | "free" | "pro" | "team";
export type CacheChoice = "off" | "upstash_payg";
export type VercelChoice = "off" | "hobby" | "pro";
export type CloudflareChoice = "off" | "free" | "paid";
export type Host = "vercel" | "cloudflare" | "direct";
export type FileStore = "supabase" | "r2";

export const HOSTS: Host[] = ["vercel", "cloudflare", "direct"];
export const HOST_LABELS: Record<Host, string> = {
  vercel: "Vercel",
  cloudflare: "Cloudflare Workers",
  direct: "Client calls Supabase directly",
};

export interface SimInputs {
  preset: PresetKey;
  // Stack
  supabase: SupabaseChoice;
  compute: "auto" | ComputeKey;
  cache: CacheChoice;
  vercel: VercelChoice;
  seats: number;
  cloudflare: CloudflareChoice;
  host: Host;
  fileStore: FileStore;
  // Workload
  mau: number;
  dauPct: number;
  sessionsPerDay: number;
  requestsPerSession: number;
  queriesPerRequest: number;
  dbQueriesOverride: number | null;
  readPct: number;
  hitPct: number;
  peakToAvg: number;
  responseKB: number;
  dbKBPerUser: number;
  fileMBPerUser: number;
  fileDownloadMBPerUser: number;
  functionPct: number;
  realtimePct: number;
  realtimeMsgsPerUserDay: number;
  cpuMs: number;
  growthPct: number;
  // Assumptions
  headroomPct: number;
  queryMs: number;
  cacheValueKB: number;
  cachedKeysPct: number;
  avgFileMB: number;
  planningQps: Partial<Record<ComputeKey, number>>;
}

export type FieldGroup = "stack" | "traffic" | "database" | "data" | "growth" | "assumptions";

export const FIELD_GROUPS: { key: Exclude<FieldGroup, "stack">; label: string }[] = [
  { key: "traffic", label: "Users & traffic" },
  { key: "database", label: "Database" },
  { key: "data", label: "Data & bandwidth" },
  { key: "growth", label: "Growth" },
  { key: "assumptions", label: "Assumptions" },
];

type NumberKey = { [K in keyof SimInputs]-?: SimInputs[K] extends number | null ? K : never }[keyof SimInputs];
export type EnumKey = "supabase" | "compute" | "cache" | "vercel" | "cloudflare" | "host" | "fileStore";

export interface NumberField {
  kind: "number";
  name: NumberKey;
  url: string;
  label: string;
  group: FieldGroup;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  integer?: boolean;
  optional?: boolean;
}

export interface EnumField {
  kind: "enum";
  name: EnumKey;
  url: string;
  label: string;
  options: { value: string; label: string }[];
}

type NumberExtras = Partial<Pick<NumberField, "unit" | "hint" | "integer" | "optional">>;

function num(name: NumberKey, url: string, label: string, group: FieldGroup, min: number, max: number, step: number, extra: NumberExtras = {}): NumberField {
  return { kind: "number", name, url, label, group, min, max, step, ...extra };
}

function choice(name: EnumKey, url: string, label: string, options: [string, string][]): EnumField {
  return { kind: "enum", name, url, label, options: options.map(([value, text]) => ({ value, label: text })) };
}

export const ENUM_FIELDS: EnumField[] = [
  choice("supabase", "sb", "Supabase", [["off", "Off"], ["free", "Free"], ["pro", "Pro"], ["team", "Team"]]),
  choice("compute", "cmp", "Database compute", [["auto", "Auto (smallest that fits)"], ...CATALOG.compute.map((c): [string, string] => [c.key, c.label])]),
  choice("cache", "ca", "Cache", [["off", "Off"], ["upstash_payg", "Upstash Redis (pay as you go)"]]),
  choice("vercel", "vc", "Vercel", [["off", "Off"], ["hobby", "Hobby"], ["pro", "Pro"]]),
  choice("cloudflare", "cf", "Cloudflare", [["off", "Off"], ["free", "Workers Free"], ["paid", "Workers Paid"]]),
  choice("host", "host", "API runs on", HOSTS.map((h): [string, string] => [h, HOST_LABELS[h]])),
  choice("fileStore", "fs", "File storage", [["supabase", "Supabase Storage"], ["r2", "Cloudflare R2"]]),
];

export const NUMBER_FIELDS: NumberField[] = [
  num("seats", "seats", "Vercel seats", "stack", 1, 1_000, 1, { integer: true }),
  num("mau", "mau", "Monthly active users", "traffic", 0, 100_000_000, 100, { integer: true, unit: "users" }),
  num("dauPct", "dau", "Daily active share", "traffic", 1, 100, 1, { unit: "%", hint: "of MAU on a typical day" }),
  num("sessionsPerDay", "spd", "Sessions per day", "traffic", 0.1, 50, 0.1, { hint: "per active user" }),
  num("requestsPerSession", "rps", "Requests per session", "traffic", 1, 1_000, 1),
  num("peakToAvg", "pk", "Peak vs. average", "traffic", 1, 50, 0.5, { unit: "×" }),
  num("functionPct", "fn", "Requests using an Edge Function", "traffic", 0, 100, 1, { unit: "%" }),
  num("realtimePct", "rt", "Daily users on Realtime", "traffic", 0, 100, 1, { unit: "%" }),
  num("realtimeMsgsPerUserDay", "rtm", "Realtime messages", "traffic", 0, 100_000, 1, { hint: "per Realtime user per day" }),
  num("cpuMs", "cpu", "CPU time per request", "traffic", 1, 30_000, 1, { unit: "ms", hint: "server functions" }),
  num("queriesPerRequest", "qpr", "DB queries per request", "database", 0, 50, 0.5),
  num("dbQueriesOverride", "dbq", "DB queries per month", "database", 0, 1e13, 1_000, { integer: true, optional: true, hint: "optional; replaces the derived count" }),
  num("readPct", "rd", "Reads", "database", 0, 100, 1, { unit: "%", hint: "of queries" }),
  num("hitPct", "hit", "Cache hit rate", "database", 0, 99, 1, { unit: "%", hint: "of reads" }),
  num("dbKBPerUser", "dbkb", "Database data per user", "database", 0, 100_000, 1, { unit: "KB" }),
  num("responseKB", "kb", "Response size", "data", 0.1, 10_000, 0.1, { unit: "KB", hint: "per API request" }),
  num("fileMBPerUser", "fmb", "Files stored per user", "data", 0, 100_000, 0.1, { unit: "MB" }),
  num("fileDownloadMBPerUser", "fdl", "File downloads per user", "data", 0, 100_000, 0.1, { unit: "MB/mo" }),
  num("growthPct", "g", "Monthly MAU growth", "growth", -50, 200, 1, { unit: "%" }),
  num("headroomPct", "hr", "Compute headroom", "assumptions", 10, 100, 5, { unit: "%", hint: "highest share of capacity to use" }),
  num("queryMs", "qms", "Average query time", "assumptions", 0.1, 10_000, 0.5, { unit: "ms" }),
  num("cachedKeysPct", "ck", "Data held in cache", "assumptions", 0, 100, 1, { unit: "%" }),
  num("cacheValueKB", "cvk", "Cache value size", "assumptions", 0.01, 100_000, 0.1, { unit: "KB" }),
  num("avgFileMB", "fsz", "Average file size", "assumptions", 0.001, 100_000, 0.1, { unit: "MB" }),
];

const FIELDS = [...ENUM_FIELDS, ...NUMBER_FIELDS];
const FIELD_BY_URL = new Map(FIELDS.map((f) => [f.url, f]));
export const QPS_MAX = 10_000_000;

export const PRESET_INFO: Record<PresetKey, { label: string; description: string }> = {
  side_project: { label: "Side project", description: "A few hundred users on free tiers, growing slowly." },
  small_saas: { label: "Small SaaS", description: "Ten thousand users on paid plans, with uploads and some Realtime." },
  consumer_app: { label: "Consumer app", description: "A quarter of a million users with spiky traffic and a cache." },
};

const ASSUMPTIONS = { headroomPct: 70, queryMs: 5, cacheValueKB: 2, cachedKeysPct: 10, avgFileMB: 0.5 };
const ROUTING = { compute: "auto", cloudflare: "off", host: "vercel", fileStore: "supabase", dbQueriesOverride: null } as const;

const PRESET_VALUES: Record<PresetKey, SimInputs> = {
  side_project: {
    preset: "side_project",
    ...ROUTING,
    supabase: "free",
    cache: "off",
    vercel: "hobby",
    seats: 1,
    mau: 500,
    dauPct: 20,
    sessionsPerDay: 1,
    requestsPerSession: 20,
    queriesPerRequest: 2,
    readPct: 85,
    hitPct: 80,
    peakToAvg: 3,
    responseKB: 5,
    dbKBPerUser: 20,
    fileMBPerUser: 1,
    fileDownloadMBPerUser: 2,
    functionPct: 0,
    realtimePct: 0,
    realtimeMsgsPerUserDay: 0,
    cpuMs: 10,
    growthPct: 10,
    ...ASSUMPTIONS,
    planningQps: {},
  },
  small_saas: {
    preset: "small_saas",
    ...ROUTING,
    supabase: "pro",
    cache: "off",
    vercel: "pro",
    seats: 1,
    mau: 10_000,
    dauPct: 25,
    sessionsPerDay: 2,
    requestsPerSession: 40,
    queriesPerRequest: 3,
    readPct: 80,
    hitPct: 80,
    peakToAvg: 4,
    responseKB: 10,
    dbKBPerUser: 200,
    fileMBPerUser: 20,
    fileDownloadMBPerUser: 30,
    functionPct: 5,
    realtimePct: 10,
    realtimeMsgsPerUserDay: 50,
    cpuMs: 20,
    growthPct: 8,
    ...ASSUMPTIONS,
    planningQps: {},
  },
  consumer_app: {
    preset: "consumer_app",
    ...ROUTING,
    supabase: "pro",
    cache: "upstash_payg",
    vercel: "pro",
    seats: 2,
    mau: 250_000,
    dauPct: 15,
    sessionsPerDay: 3,
    requestsPerSession: 30,
    queriesPerRequest: 2,
    readPct: 90,
    hitPct: 85,
    peakToAvg: 6,
    responseKB: 8,
    dbKBPerUser: 50,
    fileMBPerUser: 5,
    fileDownloadMBPerUser: 20,
    functionPct: 10,
    realtimePct: 20,
    realtimeMsgsPerUserDay: 100,
    cpuMs: 15,
    growthPct: 5,
    ...ASSUMPTIONS,
    planningQps: {},
  },
};

export function presetInputs(preset: PresetKey): SimInputs {
  return structuredClone(PRESET_VALUES[preset]);
}

export function clampField(field: NumberField, n: number): number {
  const v = Math.min(field.max, Math.max(field.min, n));
  return field.integer ? Math.round(v) : v;
}

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = z.coerce.number().safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function setValue(inputs: SimInputs, name: EnumKey | NumberKey, value: unknown) {
  (inputs as unknown as Record<string, unknown>)[name] = value;
}

/** Inputs from URL search params: preset first, then every valid override. */
export function decode(params: Params): { inputs: SimInputs; notices: string[] } {
  const notices: string[] = [];
  const p = first(params.p);
  let preset = DEFAULT_PRESET;
  if (p !== undefined) {
    if ((PRESETS as readonly string[]).includes(p)) preset = p as PresetKey;
    else notices.push(`Unknown preset "${p}", so ${PRESET_INFO[DEFAULT_PRESET].label} is used.`);
  }
  const inputs = presetInputs(preset);

  for (const [key, value] of Object.entries(params)) {
    const raw = first(value);
    if (key === "p" || raw === undefined) continue;

    if (key.startsWith("qps.")) {
      const size = key.slice(4);
      const n = parseNumber(raw);
      if (!(COMPUTE_KEYS as readonly string[]).includes(size) || n === null) {
        notices.push(`Ignored the setting "${key}".`);
        continue;
      }
      inputs.planningQps[size as ComputeKey] = Math.min(QPS_MAX, Math.max(1, n));
      continue;
    }

    const field = FIELD_BY_URL.get(key);
    if (!field) {
      notices.push(`Ignored the unknown setting "${key}".`);
      continue;
    }
    if (field.kind === "enum") {
      if (field.options.some((o) => o.value === raw)) setValue(inputs, field.name, raw);
      else notices.push(`Ignored an invalid value for ${field.label}.`);
      continue;
    }
    const n = parseNumber(raw);
    if (n === null) {
      notices.push(`Ignored an invalid value for ${field.label}.`);
      continue;
    }
    setValue(inputs, field.name, clampField(field, n));
  }
  return { inputs, notices };
}

/** Search params holding the preset plus only the values that differ from it. */
export function encode(inputs: SimInputs): string {
  const base = PRESET_VALUES[inputs.preset];
  const out = new URLSearchParams({ p: inputs.preset });
  for (const f of FIELDS) {
    const v = inputs[f.name];
    if (v !== null && v !== base[f.name]) out.set(f.url, String(v));
  }
  for (const k of COMPUTE_KEYS) {
    const v = inputs.planningQps[k];
    if (v !== undefined && v !== base.planningQps[k]) out.set(`qps.${k}`, String(v));
  }
  return out.toString();
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/inputs.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/inputs.ts tests/simulate/inputs.test.ts
git commit -m "feat(simulator): add inputs, presets and URL encoding"
```

---

### Task 5: Stack routing

**Files:**
- Create: `src/lib/engine/simulate/stack.ts`
- Create: `tests/simulate/fixtures.ts`
- Test: `tests/simulate/stack.test.ts`

- [ ] **Step 1: Write the shared test fixtures**

Create `tests/simulate/fixtures.ts`. Later tasks extend it, and it holds the test catalog so engine tests don't break when real prices change.

```ts
import type { Catalog } from "@/lib/engine/simulate/catalog";
import { presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";
import { resolveStack } from "@/lib/engine/simulate/stack";

/** Small SaaS preset with overrides. */
export function inputsWith(overrides: Partial<SimInputs> = {}): SimInputs {
  return { ...presetInputs("small_saas"), ...overrides };
}

export function stackWith(overrides: Partial<SimInputs> = {}) {
  return resolveStack(inputsWith(overrides)).stack;
}

const sheet = { version: "test", verifiedAt: "2026-10-01" } as const;
const per = (key: string, includedQuantity: number, unitPrice: number | null, unitSize = 1) => ({
  key,
  label: key,
  unit: "",
  includedQuantity,
  unitPrice,
  unitSize,
  billingMode: "per_unit" as const,
});

/** Round numbers, fixed forever, so expected values in tests are easy to check by hand. */
export const TEST_CATALOG: Catalog = {
  freeCompute: "nano",
  compute: [
    { key: "nano", label: "Nano", monthlyPrice: 0, cpu: "", ramGB: 0.5, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 50 },
    { key: "micro", label: "Micro", monthlyPrice: 10, cpu: "", ramGB: 1, maxDirectConnections: 60, maxPoolerConnections: 200, planningQps: 100 },
    { key: "small", label: "Small", monthlyPrice: 15, cpu: "", ramGB: 2, maxDirectConnections: 90, maxPoolerConnections: 400, planningQps: 200 },
    { key: "medium", label: "Medium", monthlyPrice: 60, cpu: "", ramGB: 4, maxDirectConnections: 120, maxPoolerConnections: 600, planningQps: 400 },
  ],
  sheets: [
    { ...sheet, service: "supabase", plan: "free", label: "Supabase Free", sourceUrl: "https://example.test/sb", baseFee: 0, items: [per("mau", 50_000, null), per("egress_gb", 5, null)] },
    {
      ...sheet,
      service: "supabase",
      plan: "pro",
      label: "Supabase Pro",
      sourceUrl: "https://example.test/sb",
      baseFee: 25,
      credit: { amount: 10, appliesTo: ["compute"] },
      items: [per("mau", 100_000, 0.00325), per("egress_gb", 250, 0.09)],
    },
    { ...sheet, service: "upstash", plan: "payg", label: "Upstash", sourceUrl: "https://example.test/up", baseFee: 0, items: [per("commands", 0, 0.2, 100_000), per("storage_gb", 0, 0.25)] },
    {
      ...sheet,
      service: "vercel",
      plan: "pro",
      label: "Vercel Pro",
      sourceUrl: "https://example.test/vc",
      baseFee: 20,
      perSeat: true,
      credit: { amount: 20, appliesTo: ["fn_invocations", "transfer_gb"] },
      items: [per("fn_invocations", 1_000_000, 0.6, 1_000_000), per("transfer_gb", 1_000, 0.15)],
    },
    { ...sheet, service: "cloudflare", plan: "paid", label: "Cloudflare Paid", sourceUrl: "https://example.test/cf", baseFee: 5, items: [per("requests", 10_000_000, 0.3, 1_000_000), per("r2_storage_gb", 10, 0.015)] },
  ],
};

/** TEST_CATALOG with a cache that costs nothing, to isolate compute and egress effects. */
export const FREE_CACHE_CATALOG: Catalog = {
  ...TEST_CATALOG,
  sheets: TEST_CATALOG.sheets.map((s) => (s.service === "upstash" ? { ...s, items: s.items.map((i) => ({ ...i, unitPrice: 0 })) } : s)),
};
```

- [ ] **Step 2: Write the failing test**

Create `tests/simulate/stack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveStack } from "@/lib/engine/simulate/stack";
import { inputsWith } from "./fixtures";

describe("resolveStack", () => {
  it("keeps a valid stack as is", () => {
    const { stack, notices } = resolveStack(inputsWith());
    expect(stack).toMatchObject({ supabase: "pro", vercel: "pro", cloudflare: null, host: "vercel", fileStore: "supabase", cache: false });
    expect(notices).toEqual([]);
  });

  it("moves the API host to the first enabled service", () => {
    const { stack, notices } = resolveStack(inputsWith({ vercel: "off", cloudflare: "paid", host: "vercel" }));
    expect(stack.host).toBe("cloudflare");
    expect(notices).toHaveLength(1);
  });

  it("falls back to direct when no server host is on", () => {
    const { stack, notices } = resolveStack(inputsWith({ vercel: "off", host: "vercel" }));
    expect(stack.host).toBe("direct");
    expect(notices).toHaveLength(1);
  });

  it("uses Supabase Storage when R2 is picked without Cloudflare", () => {
    const { stack, notices } = resolveStack(inputsWith({ fileStore: "r2" }));
    expect(stack.fileStore).toBe("supabase");
    expect(notices).toHaveLength(1);
  });

  it("prices the cache only behind a server host and in front of Supabase", () => {
    expect(resolveStack(inputsWith({ cache: "upstash_payg" })).stack.cache).toBe(true);

    const direct = resolveStack(inputsWith({ cache: "upstash_payg", host: "direct" })).stack;
    expect(direct.cache).toBe(false);
    expect(direct.cacheBlockedReason).toMatch(/server-side/);

    const noDb = resolveStack(inputsWith({ cache: "upstash_payg", supabase: "off" })).stack;
    expect(noDb.cache).toBe(false);
    expect(noDb.cacheBlockedReason).toMatch(/Supabase/);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/stack.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate/stack"`.

- [ ] **Step 4: Implement**

Create `src/lib/engine/simulate/stack.ts`:

```ts
import type { ComputeKey } from "./catalog";
import { type FileStore, type Host, HOST_LABELS, HOSTS, type SimInputs } from "./inputs";

export interface ResolvedStack {
  supabase: "free" | "pro" | "team" | null;
  compute: "auto" | ComputeKey;
  /** Whether the cache is priced. */
  cache: boolean;
  cacheBlockedReason: string | null;
  vercel: "hobby" | "pro" | null;
  seats: number;
  cloudflare: "free" | "paid" | null;
  host: Host;
  fileStore: FileStore;
}

export const DIRECT_REASON =
  "A cache needs a server-side API host (Vercel or Cloudflare). With the client calling Supabase directly there is nowhere to put one.";
export const NO_SUPABASE_REASON = "The cache is modelled in front of a Supabase database. Turn on Supabase to price it.";

/** Applies the routing rules so every mix of services is coherent. */
export function resolveStack(inputs: SimInputs): { stack: ResolvedStack; notices: string[] } {
  const notices: string[] = [];
  const supabase = inputs.supabase === "off" ? null : inputs.supabase;
  const vercel = inputs.vercel === "off" ? null : inputs.vercel;
  const cloudflare = inputs.cloudflare === "off" ? null : inputs.cloudflare;

  const hostOn: Record<Host, boolean> = { vercel: vercel !== null, cloudflare: cloudflare !== null, direct: supabase !== null };
  let host = inputs.host;
  if (!hostOn[host]) {
    host = HOSTS.find((h) => hostOn[h]) ?? "direct";
    if (host !== inputs.host) notices.push(`${HOST_LABELS[inputs.host]} is turned off, so the API host is ${HOST_LABELS[host]}.`);
  }

  let fileStore = inputs.fileStore;
  if (fileStore === "r2" && cloudflare === null) {
    fileStore = "supabase";
    notices.push("R2 file storage needs Cloudflare, so Supabase Storage is used.");
  }

  let cache = inputs.cache !== "off";
  let cacheBlockedReason: string | null = null;
  if (cache && supabase === null) {
    cache = false;
    cacheBlockedReason = NO_SUPABASE_REASON;
  } else if (cache && host === "direct") {
    cache = false;
    cacheBlockedReason = DIRECT_REASON;
  }

  return {
    stack: { supabase, compute: inputs.compute, cache, cacheBlockedReason, vercel, seats: inputs.seats, cloudflare, host, fileStore },
    notices,
  };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/stack.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/engine/simulate/stack.ts tests/simulate/stack.test.ts tests/simulate/fixtures.ts
git commit -m "feat(simulator): resolve stack routing rules"
```

---

### Task 6: Workload model

**Files:**
- Create: `src/lib/engine/simulate/workload.ts`
- Test: `tests/simulate/workload.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/simulate/workload.test.ts`. The expected values are worked out by hand from the Small SaaS preset in the spec's workload model.

```ts
import { describe, expect, it } from "vitest";
import { workloadMonths } from "@/lib/engine/simulate/workload";
import { inputsWith, stackWith } from "./fixtures";

describe("workloadMonths", () => {
  it("derives month 1 usage from the Small SaaS preset with a cache", () => {
    const [m1] = workloadMonths(inputsWith(), stackWith(), true, 1);
    expect(m1.mau).toBe(10_000);
    expect(m1.dau).toBe(2_500);
    expect(m1.requests).toBe(6_000_000);
    expect(m1.dbQueries).toBe(18_000_000);
    expect(m1.reads).toBeCloseTo(14_400_000);
    expect(m1.writes).toBeCloseTo(3_600_000);
    expect(m1.cacheHits).toBeCloseTo(11_520_000);
    expect(m1.dbHits).toBeCloseTo(6_480_000);
    expect(m1.avgDbQps).toBeCloseTo(2.5);
    expect(m1.peakDbQps).toBeCloseTo(10);
    expect(m1.peakConnections).toBeCloseTo(0.05);
    expect(m1.apiEgressGB).toBeCloseTo(60);
    expect(m1.hostEgressGB).toBeCloseTo(60);
    expect(m1.supabaseEgressGB).toBeCloseTo(21.6);
    expect(m1.fileEgressGB).toBeCloseTo(300);
    expect(m1.dbSizeGB).toBeCloseTo(2);
    expect(m1.storageGB).toBeCloseTo(200);
    expect(m1.storageAddedGB).toBeCloseTo(200);
    expect(m1.fnInvocations).toBeCloseTo(300_000);
    expect(m1.rtPeakConnections).toBeCloseTo(41.667, 2);
    expect(m1.rtMessages).toBeCloseTo(375_000);
    expect(m1.serverRequests).toBe(6_000_000);
    expect(m1.cpuMs).toBeCloseTo(120_000_000);
    expect(m1.cacheCommands).toBeCloseTo(20_880_000);
    expect(m1.cacheStorageGB).toBeCloseTo(0.2);
    expect(m1.cacheKeys).toBeCloseTo(100_000);
    expect(m1.fileWrites).toBeCloseTo(400_000);
    expect(m1.fileReads).toBeCloseTo(600_000);
  });

  it("has no cache traffic when the cache is off", () => {
    const [m1] = workloadMonths(inputsWith(), stackWith(), false, 1);
    expect(m1.cacheHits).toBe(0);
    expect(m1.dbHits).toBe(m1.dbQueries);
    expect(m1.cacheCommands).toBe(0);
    expect(m1.cacheStorageGB).toBe(0);
    expect(m1.supabaseEgressGB).toBeCloseTo(60);
  });

  it("compounds growth and accumulates stored data", () => {
    const months = workloadMonths(inputsWith(), stackWith(), false, 2);
    expect(months[1].month).toBe(2);
    expect(months[1].mau).toBeCloseTo(10_800);
    expect(months[1].dbSizeGB).toBeCloseTo(2.16);
    expect(months[1].storageAddedGB).toBeCloseTo(16);
  });

  it("never shrinks stored data when MAU falls", () => {
    const months = workloadMonths(inputsWith({ mau: 1_000, growthPct: -50 }), stackWith(), false, 2);
    expect(months[1].mau).toBe(500);
    expect(months[1].dbSizeGB).toBeCloseTo(months[0].dbSizeGB);
    expect(months[1].storageAddedGB).toBe(0);
  });

  it("uses the DB queries override and grows it", () => {
    const months = workloadMonths(inputsWith({ dbQueriesOverride: 1_000_000, growthPct: 10 }), stackWith(), false, 2);
    expect(months[0].dbQueries).toBe(1_000_000);
    expect(months[1].dbQueries).toBeCloseTo(1_100_000);
  });

  it("bills all API egress to Supabase when the client calls it directly", () => {
    const inputs = inputsWith({ host: "direct" });
    const [m1] = workloadMonths(inputs, stackWith({ host: "direct" }), false, 1);
    expect(m1.supabaseEgressGB).toBeCloseTo(60);
    expect(m1.hostEgressGB).toBe(0);
    expect(m1.serverRequests).toBe(0);
    expect(m1.cpuMs).toBe(0);
  });

  it("returns zero egress share, never NaN, without DB queries", () => {
    const [m1] = workloadMonths(inputsWith({ queriesPerRequest: 0 }), stackWith(), false, 1);
    expect(m1.supabaseEgressGB).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/workload.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate/workload"`.

- [ ] **Step 3: Implement**

Create `src/lib/engine/simulate/workload.ts`:

```ts
import type { SimInputs } from "./inputs";
import type { ResolvedStack } from "./stack";

const DAYS_PER_MONTH = 30;
const SECONDS_PER_MONTH = DAYS_PER_MONTH * 86_400;

export interface MonthUsage {
  month: number;
  mau: number;
  dau: number;
  requests: number;
  dbQueries: number;
  reads: number;
  writes: number;
  cacheHits: number;
  dbHits: number;
  avgDbQps: number;
  peakDbQps: number;
  /** Concurrent queries at peak (Little's law). */
  peakConnections: number;
  apiEgressGB: number;
  /** API response egress billed by Vercel or Cloudflare. */
  hostEgressGB: number;
  /** DB response egress billed by Supabase (excludes file downloads). */
  supabaseEgressGB: number;
  fileEgressGB: number;
  dbSizeGB: number;
  storageGB: number;
  storageAddedGB: number;
  fnInvocations: number;
  rtPeakConnections: number;
  rtMessages: number;
  serverRequests: number;
  cpuMs: number;
  cacheCommands: number;
  cacheStorageGB: number;
  cacheKeys: number;
  fileWrites: number;
  fileReads: number;
}

/** Monthly usage implied by the inputs. `cacheOn` decides whether reads can hit a cache. */
export function workloadMonths(inputs: SimInputs, stack: ResolvedStack, cacheOn: boolean, months = 12): MonthUsage[] {
  const growth = 1 + inputs.growthPct / 100;
  const server = stack.host !== "direct";
  const out: MonthUsage[] = [];
  let usersSoFar = 0;
  let prevMau = 0;

  for (let month = 1; month <= months; month++) {
    const factor = growth ** (month - 1);
    const mau = inputs.mau * factor;
    // Stored data follows everyone who ever joined, so a falling MAU never shrinks it.
    const newUsers = month === 1 ? mau : Math.max(0, mau - prevMau);
    usersSoFar += newUsers;
    prevMau = mau;

    const dau = mau * (inputs.dauPct / 100);
    const requests = dau * inputs.sessionsPerDay * inputs.requestsPerSession * DAYS_PER_MONTH;
    const dbQueries = inputs.dbQueriesOverride !== null ? inputs.dbQueriesOverride * factor : requests * inputs.queriesPerRequest;
    const reads = dbQueries * (inputs.readPct / 100);
    const writes = dbQueries - reads;
    const cacheHits = cacheOn ? reads * (inputs.hitPct / 100) : 0;
    const dbHits = dbQueries - cacheHits;
    const avgDbQps = dbHits / SECONDS_PER_MONTH;
    const peakDbQps = avgDbQps * inputs.peakToAvg;

    const apiEgressGB = (requests * inputs.responseKB) / 1e6;
    const dbSizeGB = (usersSoFar * inputs.dbKBPerUser) / 1e6;
    const storageGB = (usersSoFar * inputs.fileMBPerUser) / 1e3;
    const storageAddedGB = (newUsers * inputs.fileMBPerUser) / 1e3;
    const fileEgressGB = (mau * inputs.fileDownloadMBPerUser) / 1e3;
    const realtimeUsers = dau * (inputs.realtimePct / 100);
    const serverRequests = server ? requests : 0;
    const cacheStorageGB = cacheOn ? dbSizeGB * (inputs.cachedKeysPct / 100) : 0;

    out.push({
      month,
      mau,
      dau,
      requests,
      dbQueries,
      reads,
      writes,
      cacheHits,
      dbHits,
      avgDbQps,
      peakDbQps,
      peakConnections: (peakDbQps * inputs.queryMs) / 1000,
      apiEgressGB,
      hostEgressGB: server ? apiEgressGB : 0,
      supabaseEgressGB: server ? (dbQueries > 0 ? (apiEgressGB * dbHits) / dbQueries : 0) : apiEgressGB,
      fileEgressGB,
      dbSizeGB,
      storageGB,
      storageAddedGB,
      fnInvocations: requests * (inputs.functionPct / 100),
      rtPeakConnections: (realtimeUsers * inputs.peakToAvg) / 24,
      rtMessages: realtimeUsers * inputs.realtimeMsgsPerUserDay * DAYS_PER_MONTH,
      serverRequests,
      cpuMs: serverRequests * inputs.cpuMs,
      cacheCommands: cacheOn ? reads + (reads - cacheHits) + writes : 0,
      cacheStorageGB,
      cacheKeys: cacheOn ? (cacheStorageGB * 1e6) / inputs.cacheValueKB : 0,
      fileWrites: (storageAddedGB * 1e3) / inputs.avgFileMB,
      fileReads: (fileEgressGB * 1e3) / inputs.avgFileMB,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/workload.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/workload.ts tests/simulate/workload.test.ts
git commit -m "feat(simulator): derive monthly usage from workload inputs"
```

---

### Task 7: Formatting helpers and pricing

**Files:**
- Create: `src/lib/engine/simulate/format.ts`
- Create: `src/lib/engine/simulate/price.ts`
- Modify: `tests/simulate/fixtures.ts` (add `zeroUsage`)
- Test: `tests/simulate/price.test.ts`

- [ ] **Step 1: Add the `zeroUsage` fixture**

Append to `tests/simulate/fixtures.ts`:

```ts
import type { MonthUsage } from "@/lib/engine/simulate/workload";

export function zeroUsage(overrides: Partial<MonthUsage> = {}): MonthUsage {
  return {
    month: 1, mau: 0, dau: 0, requests: 0, dbQueries: 0, reads: 0, writes: 0, cacheHits: 0, dbHits: 0,
    avgDbQps: 0, peakDbQps: 0, peakConnections: 0, apiEgressGB: 0, hostEgressGB: 0, supabaseEgressGB: 0,
    fileEgressGB: 0, dbSizeGB: 0, storageGB: 0, storageAddedGB: 0, fnInvocations: 0, rtPeakConnections: 0,
    rtMessages: 0, serverRequests: 0, cpuMs: 0, cacheCommands: 0, cacheStorageGB: 0, cacheKeys: 0,
    fileWrites: 0, fileReads: 0,
    ...overrides,
  };
}
```

Then move that `import type` line up, next to the other imports at the top of the file.

- [ ] **Step 2: Write the failing test**

Create `tests/simulate/price.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { priceMonth } from "@/lib/engine/simulate/price";
import { stackWith, TEST_CATALOG, zeroUsage } from "./fixtures";

const sum = (items: { cost: number }[]) => Math.round(items.reduce((s, i) => s + i.cost, 0) * 100) / 100;
const of = (items: { service: string }[], service: string) => items.filter((i) => i.service === service);

describe("priceMonth", () => {
  it("prices Supabase Pro overage, compute and the compute credit", () => {
    const items = priceMonth(zeroUsage({ mau: 120_000, supabaseEgressGB: 200, fileEgressGB: 100 }), stackWith(), "micro", TEST_CATALOG);
    const sb = of(items, "supabase");
    expect(sb.find((i) => i.key === "base")?.cost).toBe(25);
    expect(sb.find((i) => i.key === "compute")?.cost).toBe(10);
    expect(sb.find((i) => i.key === "mau")).toMatchObject({ usage: 120_000, included: 100_000, billable: 20_000, cost: 65 });
    expect(sb.find((i) => i.key === "egress_gb")).toMatchObject({ usage: 300, billable: 50, cost: 4.5 });
    expect(sb.find((i) => i.key === "credit")?.cost).toBe(-10);
    expect(sum(sb)).toBe(94.5);
  });

  it("leaves file egress out of Supabase when files live in R2", () => {
    const stack = stackWith({ cloudflare: "paid", fileStore: "r2" });
    const items = priceMonth(zeroUsage({ supabaseEgressGB: 200, fileEgressGB: 100 }), stack, "micro", TEST_CATALOG);
    expect(items.find((i) => i.service === "supabase" && i.key === "egress_gb")?.usage).toBe(200);
  });

  it("flags usage above a free limit as restricted, never as a charge", () => {
    const items = priceMonth(zeroUsage({ mau: 60_000 }), stackWith({ supabase: "free" }), "nano", TEST_CATALOG);
    const mau = items.find((i) => i.service === "supabase" && i.key === "mau")!;
    expect(mau.restricted).toBe(true);
    expect(mau.cost).toBe(0);
    expect(sum(of(items, "supabase"))).toBe(0);
  });

  it("charges the base fee per seat and caps the usage credit", () => {
    const stack = stackWith({ supabase: "off", seats: 3 });
    const heavy = priceMonth(zeroUsage({ serverRequests: 3_000_000, hostEgressGB: 1_200 }), stack, null, TEST_CATALOG);
    expect(heavy.find((i) => i.key === "base")).toMatchObject({ cost: 60, label: "Vercel Pro plan (3 seats)" });
    expect(heavy.find((i) => i.key === "credit")?.cost).toBe(-20);
    expect(sum(heavy)).toBe(71.2);

    const light = priceMonth(zeroUsage({ serverRequests: 1_500_000, hostEgressGB: 1_000 }), stack, null, TEST_CATALOG);
    expect(light.find((i) => i.key === "credit")?.cost).toBe(-0.3);
    expect(sum(light)).toBe(60);
  });

  it("prices the cache and notes its key count", () => {
    const items = priceMonth(zeroUsage({ cacheCommands: 20_880_000, cacheStorageGB: 0.2, cacheKeys: 100_000 }), stackWith({ cache: "upstash_payg" }), "micro", TEST_CATALOG);
    const up = of(items, "upstash");
    expect(up.find((i) => i.key === "commands")?.cost).toBe(41.76);
    expect(up.find((i) => i.key === "storage_gb")).toMatchObject({ cost: 0.05, note: "About 100K keys." });
  });

  it("prices Cloudflare Workers and R2 when they host the API and files", () => {
    const stack = stackWith({ cloudflare: "paid", host: "cloudflare", fileStore: "r2", supabase: "off", vercel: "off" });
    const items = priceMonth(zeroUsage({ serverRequests: 12_000_000, storageGB: 30 }), stack, null, TEST_CATALOG);
    expect(items.every((i) => i.service === "cloudflare")).toBe(true);
    expect(sum(items)).toBe(5.9);
  });

  it("produces no items for services that are off", () => {
    const items = priceMonth(zeroUsage(), stackWith({ supabase: "off", vercel: "off" }), null, TEST_CATALOG);
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/price.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate/price"`.

- [ ] **Step 4: Implement `format.ts`**

Create `src/lib/engine/simulate/format.ts`:

```ts
import { formatCount } from "../../units";

/** "21.60 GB", "350 GB", "50.0K users". Fractions are kept for small amounts. */
export function formatAmount(n: number, unit: string): string {
  const abs = Math.abs(n);
  const num = abs < 100 && !Number.isInteger(n) ? n.toFixed(abs < 10 ? 2 : 1) : formatCount(n);
  return unit ? `${num} ${unit}` : num;
}

export function formatQps(n: number): string {
  return Math.abs(n) < 10 ? n.toFixed(1) : formatCount(n);
}

/** Small per-user amounts such as $0.0012, which cents rounding would hide. */
export function formatPerUser(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 3 }).format(n);
}
```

- [ ] **Step 5: Implement `price.ts`**

Create `src/lib/engine/simulate/price.ts`:

```ts
import { formatCount } from "../../units";
import { overageCost, round2 } from "../cost";
import { type Catalog, type ComputeKey, computeSize, type PriceSheet, type Service, sheetFor } from "./catalog";
import type { ResolvedStack } from "./stack";
import type { MonthUsage } from "./workload";

export interface LineItem {
  service: Service;
  key: string;
  label: string;
  unit: string;
  usage: number;
  included: number;
  billable: number;
  /** USD, rounded to cents. Credits are negative. */
  cost: number;
  restricted: boolean;
  note?: string;
}

export function enabledPlans(stack: ResolvedStack): { service: Service; plan: string }[] {
  const plans: [Service, string | null][] = [
    ["supabase", stack.supabase],
    ["upstash", stack.cache ? "payg" : null],
    ["vercel", stack.vercel],
    ["cloudflare", stack.cloudflare],
  ];
  return plans.flatMap(([service, plan]) => (plan === null ? [] : [{ service, plan }]));
}

function usageFor(service: Service, u: MonthUsage, stack: ResolvedStack): Record<string, number> {
  switch (service) {
    case "supabase": {
      const files = stack.fileStore === "supabase";
      return {
        mau: u.mau,
        db_disk_gb: u.dbSizeGB,
        storage_gb: files ? u.storageGB : 0,
        egress_gb: u.supabaseEgressGB + (files ? u.fileEgressGB : 0),
        fn_invocations: u.fnInvocations,
        rt_peak: u.rtPeakConnections,
        rt_messages: u.rtMessages,
      };
    }
    case "upstash":
      return { commands: u.cacheCommands, storage_gb: u.cacheStorageGB };
    case "vercel": {
      const host = stack.host === "vercel";
      return {
        edge_requests: host ? u.requests : 0,
        fn_invocations: host ? u.serverRequests : 0,
        cpu_hours: host ? u.cpuMs / 3_600_000 : 0,
        transfer_gb: host ? u.hostEgressGB : 0,
      };
    }
    case "cloudflare": {
      const host = stack.host === "cloudflare";
      const r2 = stack.fileStore === "r2";
      return {
        requests: host ? u.serverRequests : 0,
        cpu_ms: host ? u.cpuMs : 0,
        r2_storage_gb: r2 ? u.storageGB : 0,
        r2_class_a: r2 ? u.fileWrites : 0,
        r2_class_b: r2 ? u.fileReads : 0,
      };
    }
  }
}

function fixed(service: Service, key: string, label: string, cost: number): LineItem {
  return { service, key, label, unit: "", usage: 1, included: 0, billable: 1, cost, restricted: false };
}

function priceSheet(sheet: PriceSheet, usage: Record<string, number>, compute: ComputeKey | null, seats: number, catalog: Catalog, u: MonthUsage): LineItem[] {
  const items: LineItem[] = [];
  if (sheet.baseFee > 0) {
    const label = sheet.perSeat ? `${sheet.label} plan (${seats} seat${seats === 1 ? "" : "s"})` : `${sheet.label} plan`;
    items.push(fixed(sheet.service, "base", label, round2(sheet.baseFee * (sheet.perSeat ? seats : 1))));
  }
  if (compute) {
    const size = computeSize(catalog, compute);
    items.push(fixed(sheet.service, "compute", `${size.label} compute`, size.monthlyPrice));
  }
  for (const item of sheet.items) {
    const used = usage[item.key] ?? 0;
    const billable = Math.max(0, used - item.includedQuantity);
    items.push({
      service: sheet.service,
      key: item.key,
      label: item.label,
      unit: item.unit,
      usage: used,
      included: item.includedQuantity,
      billable,
      cost: item.unitPrice === null ? 0 : overageCost(used, { ...item, unitPrice: item.unitPrice }),
      restricted: item.unitPrice === null && billable > 0,
      note: sheet.service === "upstash" && item.key === "storage_gb" ? `About ${formatCount(u.cacheKeys)} keys.` : item.note,
    });
  }
  if (sheet.credit) {
    const applies = new Set(sheet.credit.appliesTo);
    const eligible = items.filter((i) => applies.has(i.key)).reduce((s, i) => s + i.cost, 0);
    const credit = round2(Math.min(sheet.credit.amount, eligible));
    if (credit > 0) items.push(fixed(sheet.service, "credit", "Included usage credit", -credit));
  }
  return items;
}

/** Line items for one month. `compute` is the Supabase compute size, when Supabase is on. */
export function priceMonth(u: MonthUsage, stack: ResolvedStack, compute: ComputeKey | null, catalog: Catalog): LineItem[] {
  return enabledPlans(stack).flatMap(({ service, plan }) => {
    const sheet = sheetFor(catalog, service, plan);
    if (!sheet) throw new Error(`No price sheet for ${service} ${plan}`);
    return priceSheet(sheet, usageFor(service, u, stack), service === "supabase" ? compute : null, stack.seats, catalog, u);
  });
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/price.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/engine/simulate/format.ts src/lib/engine/simulate/price.ts tests/simulate/price.test.ts tests/simulate/fixtures.ts
git commit -m "feat(simulator): price monthly usage into line items"
```

---

### Task 8: Compute choice and cache verdict

**Files:**
- Create: `src/lib/engine/simulate/project.ts`
- Test: `tests/simulate/project.test.ts`

The tests use `TEST_CATALOG` (planning QPS: micro 100, small 200, medium 400) with 70% headroom, so the usable capacities are micro 70, small 140 and medium 280 queries/sec. A month has 2,592,000 seconds, so `dbQueriesOverride = qps × 2_592_000` with `peakToAvg: 1` sets the peak exactly.

- [ ] **Step 1: Write the failing test**

Create `tests/simulate/project.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cacheVerdict, chooseCompute } from "@/lib/engine/simulate/project";
import { resolveStack } from "@/lib/engine/simulate/stack";
import { workloadMonths } from "@/lib/engine/simulate/workload";
import { FREE_CACHE_CATALOG, inputsWith, TEST_CATALOG } from "./fixtures";
import type { SimInputs } from "@/lib/engine/simulate/inputs";

const MONTH = 2_592_000;
const atQps = (qps: number, extra: Partial<SimInputs> = {}) => inputsWith({ dbQueriesOverride: qps * MONTH, peakToAvg: 1, growthPct: 0, ...extra });

function verdict(inputs: SimInputs, catalog = TEST_CATALOG) {
  return cacheVerdict(inputs, resolveStack(inputs).stack, catalog, 12);
}

function compute(inputs: SimInputs) {
  const { stack } = resolveStack(inputs);
  const [u] = workloadMonths(inputs, stack, stack.cache, 1);
  return chooseCompute(stack, u, inputs, TEST_CATALOG);
}

describe("chooseCompute", () => {
  it("picks the smallest paid size that fits", () => {
    expect(compute(atQps(50))).toEqual({ key: "micro", fits: true });
    expect(compute(atQps(120))).toEqual({ key: "small", fits: true });
  });

  it("returns the largest size, marked as not fitting, when nothing fits", () => {
    expect(compute(atQps(500))).toEqual({ key: "medium", fits: false });
  });

  it("keeps a fixed size and reports saturation", () => {
    expect(compute(atQps(120, { compute: "micro" }))).toEqual({ key: "micro", fits: false });
  });

  it("ignores the compute choice on Supabase Free", () => {
    expect(compute(atQps(10, { supabase: "free", compute: "small" }))).toEqual({ key: "nano", fits: true });
  });

  it("has no compute without Supabase", () => {
    expect(compute(inputsWith({ supabase: "off" }))).toEqual({ key: null, fits: true });
  });

  it("respects planning QPS overrides", () => {
    expect(compute(atQps(120, { planningQps: { micro: 200 } }))).toEqual({ key: "micro", fits: true });
  });
});

describe("cacheVerdict", () => {
  it("says no cache is needed when the smallest size fits anyway", () => {
    const v = verdict(atQps(50));
    expect(v.kind).toBe("no_cache_needed");
    expect(v.tierWithoutCache).toBe("micro");
  });

  it("recommends upgrading compute when the cache costs more", () => {
    const v = verdict(atQps(120));
    expect(v).toMatchObject({ kind: "upgrade_compute", tierWithoutCache: "small", tierWithCache: "micro" });
  });

  it("recommends a cache when it is cheaper than the larger size", () => {
    const v = verdict(atQps(120), FREE_CACHE_CATALOG);
    expect(v).toMatchObject({ kind: "add_cache", monthlySaving: 5, tierWithoutCache: "small", tierWithCache: "micro", paysOffMonth: 1 });
  });

  it("recommends a cache that pays for itself in egress alone", () => {
    const v = verdict(inputsWith({ responseKB: 100, fileDownloadMBPerUser: 0 }), FREE_CACHE_CATALOG);
    expect(v).toMatchObject({ kind: "add_cache", monthlySaving: 31.5, tierWithoutCache: "micro", tierWithCache: "micro" });
  });

  it("reports when no size fits, and whether a cache fixes it", () => {
    const v = verdict(atQps(500));
    expect(v).toMatchObject({ kind: "no_tier_fits", tierWithoutCache: null, tierWithCache: "medium", cacheFixesIt: true });
  });

  it("finds the month the cache starts paying off", () => {
    const v = verdict(atQps(60, { growthPct: 10 }), FREE_CACHE_CATALOG);
    expect(v.kind).toBe("no_cache_needed");
    expect(v.paysOffMonth).toBe(3);
  });

  it("does not apply without a server host or without Supabase", () => {
    expect(verdict(inputsWith({ host: "direct" })).kind).toBe("not_applicable");
    expect(verdict(inputsWith({ supabase: "off" })).kind).toBe("not_applicable");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/project.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate/project"`.

- [ ] **Step 3: Implement the compute and verdict half of `project.ts`**

Create `src/lib/engine/simulate/project.ts`:

```ts
import { formatMoney } from "../../units";
import { round2 } from "../cost";
import type { Catalog, ComputeKey, ComputeSize } from "./catalog";
import { formatQps } from "./format";
import type { SimInputs } from "./inputs";
import { type LineItem, priceMonth } from "./price";
import { DIRECT_REASON, type ResolvedStack } from "./stack";
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
  const na = stack.supabase === null ? "Turn on Supabase to compare a cache with a larger database compute size." : stack.host === "direct" ? DIRECT_REASON : null;
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/project.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/project.ts tests/simulate/project.test.ts
git commit -m "feat(simulator): choose compute size and compare cache vs compute"
```

---

### Task 9: Events and the `simulate()` entry point

**Files:**
- Modify: `src/lib/engine/simulate/project.ts` (append)
- Create: `src/lib/engine/simulate/index.ts`
- Test: `tests/simulate/simulate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/simulate/simulate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/simulate";
import { PRESETS, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";
import { FREE_CACHE_CATALOG, inputsWith, TEST_CATALOG } from "./fixtures";

const NOW = new Date("2026-10-27T12:00:00Z");
const run = (inputs: SimInputs, catalog = TEST_CATALOG) => simulate(inputs, { catalog, now: NOW });
const atQps = (qps: number, extra: Partial<SimInputs> = {}) => inputsWith({ dbQueriesOverride: qps * 2_592_000, peakToAvg: 1, growthPct: 0, ...extra });

describe("simulate", () => {
  it("produces 12 finite, non-negative months for every preset with the real catalog", () => {
    for (const p of PRESETS) {
      const r = simulate(presetInputs(p), { now: NOW });
      expect(r.months).toHaveLength(12);
      for (const m of r.months) {
        expect(Number.isFinite(m.total)).toBe(true);
        expect(m.total).toBeGreaterThanOrEqual(0);
        const byService = Object.values(m.totalsByService).reduce((s, v) => s + (v ?? 0), 0);
        expect(byService).toBeCloseTo(m.total, 2);
      }
      expect(r.provenance.length).toBeGreaterThan(0);
      expect(r.provenance.every((pr) => pr.sourceUrl.startsWith("https://"))).toBe(true);
    }
  });

  it("passes routing notices through", () => {
    const r = run(inputsWith({ vercel: "off", host: "vercel" }));
    expect(r.notices).toHaveLength(1);
  });

  it("marks restricted months", () => {
    const r = run(inputsWith({ supabase: "free", mau: 60_000 }));
    expect(r.months[0].restricted).toBe(true);
  });

  it("flags price sheets older than 90 days", () => {
    expect(run(inputsWith()).provenance.every((p) => !p.stale)).toBe(true);
    const later = simulate(inputsWith(), { catalog: TEST_CATALOG, now: new Date("2027-02-01T00:00:00Z") });
    expect(later.provenance.every((p) => p.stale)).toBe(true);
  });
});

describe("events", () => {
  it("fires a plan limit once, in the month it is first crossed", () => {
    const r = run(inputsWith({ supabase: "free", mau: 40_000, growthPct: 20 }));
    const mau = r.events.filter((e) => e.key === "limit:supabase:mau");
    expect(mau).toHaveLength(1);
    expect(mau[0]).toMatchObject({ month: 3, kind: "plan_limit", service: "supabase" });
  });

  it("fires when overage charges start on a paid plan", () => {
    const r = run(inputsWith({ mau: 90_000, growthPct: 10 }));
    expect(r.events.find((e) => e.key === "overage:supabase:mau")).toMatchObject({ month: 3, kind: "overage_start" });
  });

  it("fires when auto compute moves up a size", () => {
    const r = run(atQps(60, { growthPct: 10 }));
    expect(r.events.find((e) => e.kind === "compute_upgrade")).toMatchObject({ month: 3 });
    expect(r.months[2].computeSize).toBe("small");
  });

  it("fires once when a fixed size saturates", () => {
    const r = run(atQps(120, { compute: "micro" }));
    const sat = r.events.filter((e) => e.kind === "compute_saturated");
    expect(sat).toHaveLength(1);
    expect(sat[0].month).toBe(1);
  });

  it("fires when a cache starts paying off", () => {
    const r = run(atQps(60, { growthPct: 10 }), FREE_CACHE_CATALOG);
    expect(r.verdict.paysOffMonth).toBe(3);
    expect(r.events.find((e) => e.kind === "cache_pays_off")).toMatchObject({ month: 3 });
  });

  it("lists events in month order", () => {
    const r = run(inputsWith({ supabase: "free", mau: 40_000, growthPct: 20 }));
    const months = r.events.map((e) => e.month);
    expect(months).toEqual([...months].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- tests/simulate/simulate.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/engine/simulate"`.

- [ ] **Step 3: Append events and result types to `project.ts`**

Add these imports at the top of `src/lib/engine/simulate/project.ts`, merging them with the existing import lines:

```ts
import { type Service, sheetFor } from "./catalog";
import { formatAmount } from "./format";
import { enabledPlans } from "./price";
```

The merged import block should read:

```ts
import { formatMoney } from "../../units";
import { round2 } from "../cost";
import { type Catalog, type ComputeKey, type ComputeSize, type Service, sheetFor } from "./catalog";
import { formatAmount, formatQps } from "./format";
import type { SimInputs } from "./inputs";
import { enabledPlans, type LineItem, priceMonth } from "./price";
import { DIRECT_REASON, type ResolvedStack } from "./stack";
import { type MonthUsage, workloadMonths } from "./workload";
```

Then append to the end of the file:

```ts
export type EventKind = "plan_limit" | "overage_start" | "compute_upgrade" | "compute_saturated" | "cache_pays_off";

export interface SimEvent {
  /** Dedupe key: each event fires once. */
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
  verdict: CacheVerdict;
  events: SimEvent[];
  notices: string[];
  provenance: Provenance[];
}

export function collectEvents(months: MonthResult[], verdict: CacheVerdict, stack: ResolvedStack, inputs: SimInputs, catalog: Catalog): SimEvent[] {
  const events: SimEvent[] = [];
  const seen = new Set<string>();
  const once = (e: SimEvent) => {
    if (seen.has(e.key)) return;
    seen.add(e.key);
    events.push(e);
  };
  const planLabel = new Map(enabledPlans(stack).map((p) => [p.service, sheetFor(catalog, p.service, p.plan)?.label ?? p.plan]));
  const sizeIndex = (key: ComputeKey | null) => catalog.compute.findIndex((c) => c.key === key);
  const sizeLabel = (key: ComputeKey | null) => catalog.compute.find((c) => c.key === key)?.label ?? "";

  months.forEach((m, i) => {
    for (const item of m.items) {
      const included = formatAmount(item.included, item.unit);
      if (item.restricted) {
        once({
          key: `limit:${item.service}:${item.key}`,
          month: m.month,
          kind: "plan_limit",
          service: item.service,
          message: `${item.label} passes the ${planLabel.get(item.service)} limit (${included}). A paid plan is required.`,
        });
      } else if (item.included > 0 && item.billable > 0 && item.cost > 0) {
        once({
          key: `overage:${item.service}:${item.key}`,
          month: m.month,
          kind: "overage_start",
          service: item.service,
          message: `${item.label} goes over the included ${included}. Overage charges start.`,
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
      events.push({
        key: `compute_upgrade:${m.month}`,
        month: m.month,
        kind: "compute_upgrade",
        service: "supabase",
        message: `Database load needs ${sizeLabel(m.computeSize)} compute (peak ${formatQps(m.usage.peakDbQps)} queries/sec).`,
      });
    }
  });

  if (verdict.paysOffMonth !== null) {
    events.push({
      key: "cache_pays_off",
      month: verdict.paysOffMonth,
      kind: "cache_pays_off",
      service: "upstash",
      message: "From this month a cache costs less than the compute or egress it saves.",
    });
  }
  return events.sort((a, b) => a.month - b.month);
}
```

`Array.prototype.sort` is stable, so events within the same month keep their insertion order.

- [ ] **Step 4: Create `index.ts`**

Create `src/lib/engine/simulate/index.ts`:

```ts
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
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test -- tests/simulate/simulate.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: every test passes, including the existing 50, and typecheck reports no errors. The RLS tests are skipped if the local Supabase stack isn't running; that's expected.

- [ ] **Step 7: Commit**

```bash
git add src/lib/engine/simulate/project.ts src/lib/engine/simulate/index.ts tests/simulate/simulate.test.ts
git commit -m "feat(simulator): projection events and simulate() entry point"
```

---

### Task 10: Cost projection chart

**Files:**
- Modify: `src/components/charts.tsx`

- [ ] **Step 1: Extend the imports**

In `src/components/charts.tsx`, change the recharts import to add `Cell`:

```ts
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCount, formatMoney, formatValue, niceTicks } from "@/lib/units";
```

- [ ] **Step 2: Append the chart component**

Append to the end of `src/components/charts.tsx`:

```tsx
/** Monthly cost stacked by service. Months that go over a plan limit are hatched. */
export function CostProjectionChart({
  data,
  keys,
  labels,
  height = 260,
}: {
  data: Record<string, number | string | boolean>[];
  keys: string[];
  labels: Record<string, string>;
  height?: number;
}) {
  const money = (v: number) => formatMoney(v, "USD");
  const series = keys.slice(0, 4);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="20%">
          <defs>
            {series.map((k, i) => (
              <pattern key={k} id={`hatch-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={SERIES_COLORS[i]} />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface)" strokeWidth="3" />
              </pattern>
            ))}
          </defs>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="month" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
          <YAxis tickFormatter={(v: number) => `$${formatCount(v)}`} tick={axisTick} tickLine={false} axisLine={false} width={64} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as Record<string, number | string | boolean>;
              const rows: [string, string, string?][] = series.map((k, i) => [labels[k] ?? k, money(Number(row[k] ?? 0)), SERIES_COLORS[i]]);
              rows.push(["Total", money(series.reduce((s, k) => s + Number(row[k] ?? 0), 0))]);
              return <TooltipBox title={row.restricted ? `${label} · over a plan limit` : String(label)} rows={rows} />;
            }}
          />
          <Legend
            iconType="square"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, color: "var(--muted)" }}
            formatter={(v: string) => <span style={{ color: "var(--muted)" }}>{labels[v] ?? v}</span>}
          />
          {series.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              stackId="a"
              fill={SERIES_COLORS[i]}
              stroke="var(--surface)"
              strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={String(d.month)} fill={d.restricted ? `url(#hatch-${k})` : SERIES_COLORS[i]} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/charts.tsx
git commit -m "feat(simulator): add stacked cost projection chart"
```

---

### Task 11: Page shell, view and navigation

**Files:**
- Modify: `src/components/nav.tsx:4,9-16`
- Create: `src/app/(app)/simulator/page.tsx`
- Create: `src/app/(app)/simulator/simulator-view.tsx`

The form and results components come in Tasks 12 and 13. This task ships temporary stand-ins so the page renders, and those tasks replace them.

- [ ] **Step 1: Add the nav item**

In `src/components/nav.tsx`, change the icon import to:

```ts
import { Bell, Boxes, Calculator, Cloud, Gauge, Home, Settings, Siren } from "lucide-react";
```

and insert the Simulator item after Usage:

```ts
const ITEMS = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/applications", label: "Applications", icon: Boxes },
  { href: "/providers", label: "Providers", icon: Cloud },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/simulator", label: "Simulator", icon: Calculator },
  { href: "/alerts", label: "Alerts", icon: Siren },
  { href: "/settings", label: "Settings", icon: Settings },
];
```

- [ ] **Step 2: Create the page**

Create `src/app/(app)/simulator/page.tsx`:

```tsx
import { PageHeader } from "@/components/ui";
import { decode } from "@/lib/engine/simulate/inputs";
import { SimulatorView } from "./simulator-view";

export const metadata = { title: "Cost simulator" };

export default async function SimulatorPage({ searchParams }: PageProps<"/simulator">) {
  const { inputs, notices } = decode(await searchParams);
  return (
    <>
      <PageHeader
        title="Cost simulator"
        description="Estimate what your stack costs for a workload you describe. Nothing here reads your connected accounts."
      />
      <SimulatorView initialInputs={inputs} initialNotices={notices} />
    </>
  );
}
```

- [ ] **Step 3: Create the view with temporary stand-ins**

Create `src/app/(app)/simulator/simulator-view.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { Notice } from "@/components/ui";
import { simulate } from "@/lib/engine/simulate";
import { encode, type PresetKey, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";

export function SimulatorView({ initialInputs, initialNotices }: { initialInputs: SimInputs; initialNotices: string[] }) {
  const [inputs, setInputs] = useState(initialInputs);
  const [urlNotices, setUrlNotices] = useState(initialNotices);
  const [month, setMonth] = useState(1);
  const result = useMemo(() => simulate(inputs), [inputs]);
  const query = encode(inputs);
  const edited = query !== encode(presetInputs(inputs.preset));

  // Mirror inputs into the URL so a scenario can be bookmarked or shared. The native
  // history API avoids re-running the server component on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      const url = `${window.location.pathname}?${query}`;
      if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const change = (next: SimInputs) => {
    setUrlNotices([]);
    setInputs(next);
  };

  const choosePreset = (preset: PresetKey) => {
    if (preset === inputs.preset && !edited) return;
    if (edited && !window.confirm("Switch preset? Your changes to the current one will be lost.")) return;
    change(presetInputs(preset));
  };

  const notices = [...urlNotices, ...result.notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        {/* Replaced by <SimulatorForm> in Task 12. */}
        <pre className="text-xs">{JSON.stringify({ edited, preset: inputs.preset, choosePreset: typeof choosePreset, change: typeof change }, null, 2)}</pre>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {notices.length > 0 ? (
          <Notice tone="warn" title="Some settings were adjusted">
            <ul className="list-disc pl-4">
              {notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {/* Replaced by <SimulatorResults> in Task 13. */}
        <pre className="text-xs">{JSON.stringify({ month, setMonth: typeof setMonth, total: result.months[0]?.total }, null, 2)}</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Generate route types and typecheck**

`PageProps<"/simulator">` is a generated type, so it has to be generated first:

Run: `npx next typegen && npm run typecheck`
Expected: typegen completes, and typecheck reports no errors.

- [ ] **Step 5: Smoke test in the browser**

Start the dev server with `preview_start` (name from `.claude/launch.json`; if there's no config, create one running `npm run dev` on port 3100). Sign in with the test account from `.env.local`, then open `http://localhost:3100/simulator?mau=5000`.
Expected:
- The nav shows "Simulator" as active.
- The page shows the header and the two JSON stand-ins.
- The URL still contains `mau=5000`.
- `read_console_messages` shows no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/nav.tsx "src/app/(app)/simulator/page.tsx" "src/app/(app)/simulator/simulator-view.tsx"
git commit -m "feat(simulator): add page shell, URL sync and nav item"
```

---

### Task 12: Inputs form

**Files:**
- Create: `src/app/(app)/simulator/simulator-form.tsx`
- Modify: `src/app/(app)/simulator/simulator-view.tsx`

- [ ] **Step 1: Create the form**

Create `src/app/(app)/simulator/simulator-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Card, CardBody, CardHeader, Input, Label, Select } from "@/components/ui";
import { CATALOG } from "@/lib/engine/simulate/catalog";
import {
  clampField,
  ENUM_FIELDS,
  type EnumField,
  FIELD_GROUPS,
  NUMBER_FIELDS,
  type NumberField,
  type PresetKey,
  PRESET_INFO,
  PRESETS,
  QPS_MAX,
  type SimInputs,
} from "@/lib/engine/simulate/inputs";

interface NumberInputProps {
  id: string;
  label: string;
  unit?: string;
  hint?: string;
  step: number;
  min: number;
  max: number;
  value: number | null;
  placeholder?: string;
  optional?: boolean;
  normalize: (n: number) => number;
  onChange: (v: number | null) => void;
}

/** Keeps the raw text while focused, so partial input like "1." isn't clobbered by clamping. */
function NumberInput({ id, label, unit, hint, step, min, max, value, placeholder, optional, normalize, onChange }: NumberInputProps) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : value === null ? "" : String(value);
  return (
    <div className="min-w-0">
      <Label htmlFor={id} hint={hint}>
        {label}
        {unit ? <span className="font-normal text-faint"> ({unit})</span> : null}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        value={shown}
        onFocus={() => {
          setText(value === null ? "" : String(value));
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === "") {
            if (optional) onChange(null);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(normalize(n));
        }}
      />
    </div>
  );
}

function FieldInput({ field, inputs, onChange }: { field: NumberField; inputs: SimInputs; onChange: (next: SimInputs) => void }) {
  return (
    <NumberInput
      id={`sim-${field.url}`}
      label={field.label}
      unit={field.unit}
      hint={field.hint}
      step={field.step}
      min={field.min}
      max={field.max}
      value={inputs[field.name]}
      optional={field.optional}
      normalize={(n) => clampField(field, n)}
      onChange={(v) => onChange({ ...inputs, [field.name]: v } as SimInputs)}
    />
  );
}

function EnumInput({ field, inputs, onChange, disabled, hint }: { field: EnumField; inputs: SimInputs; onChange: (next: SimInputs) => void; disabled?: boolean; hint?: string }) {
  const id = `sim-${field.url}`;
  return (
    <div className="min-w-0">
      <Label htmlFor={id} hint={hint}>
        {field.label}
      </Label>
      <Select id={id} value={inputs[field.name]} disabled={disabled} onChange={(e) => onChange({ ...inputs, [field.name]: e.target.value } as SimInputs)}>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function SimulatorForm({
  inputs,
  edited,
  onChange,
  onPreset,
}: {
  inputs: SimInputs;
  edited: boolean;
  onChange: (next: SimInputs) => void;
  onPreset: (preset: PresetKey) => void;
}) {
  const seats = NUMBER_FIELDS.find((f) => f.name === "seats")!;
  const paidSizes = CATALOG.compute.filter((c) => c.key !== CATALOG.freeCompute);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Starting point"
          actions={
            edited ? (
              <button type="button" onClick={() => onPreset(inputs.preset)} className="text-xs font-medium text-accent hover:underline">
                Reset to preset
              </button>
            ) : null
          }
        />
        <CardBody>
          <Label htmlFor="sim-preset">Preset</Label>
          <Select id="sim-preset" value={inputs.preset} onChange={(e) => onPreset(e.target.value as PresetKey)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_INFO[p].label}
              </option>
            ))}
          </Select>
          <p className="mt-1.5 text-xs text-muted">{PRESET_INFO[inputs.preset].description}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Stack" description="Turn on the services you use." />
        <CardBody className="grid grid-cols-2 gap-3">
          {ENUM_FIELDS.map((f) => (
            <EnumInput
              key={f.name}
              field={f}
              inputs={inputs}
              onChange={onChange}
              disabled={f.name === "compute" && inputs.supabase === "free"}
              hint={f.name === "compute" && inputs.supabase === "free" ? "Free uses Nano" : undefined}
            />
          ))}
          {inputs.vercel === "pro" ? <FieldInput field={seats} inputs={inputs} onChange={onChange} /> : null}
        </CardBody>
      </Card>

      {FIELD_GROUPS.filter((g) => g.key !== "assumptions").map((group) => (
        <Card key={group.key}>
          <CardHeader title={group.label} />
          <CardBody className="grid grid-cols-2 gap-3">
            {NUMBER_FIELDS.filter((f) => f.group === group.key).map((f) => (
              <FieldInput key={f.name} field={f} inputs={inputs} onChange={onChange} />
            ))}
          </CardBody>
        </Card>
      ))}

      <Card>
        <details>
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-text">Assumptions</summary>
          <div className="grid grid-cols-2 gap-3 border-t border-border p-4">
            {NUMBER_FIELDS.filter((f) => f.group === "assumptions").map((f) => (
              <FieldInput key={f.name} field={f} inputs={inputs} onChange={onChange} />
            ))}
            <p className="col-span-2 mt-2 text-xs text-muted">
              Planning capacity per compute size, in queries/sec. Supabase doesn&apos;t publish these figures; they&apos;re rules of thumb you can tune to your own queries.
            </p>
            {paidSizes.map((size) => (
              <NumberInput
                key={size.key}
                id={`sim-qps-${size.key}`}
                label={size.label}
                unit="q/s"
                step={10}
                min={1}
                max={QPS_MAX}
                placeholder={String(size.planningQps)}
                value={inputs.planningQps[size.key] ?? null}
                optional
                normalize={(n) => Math.min(QPS_MAX, Math.max(1, n))}
                onChange={(v) => {
                  const planningQps = { ...inputs.planningQps };
                  if (v === null) delete planningQps[size.key];
                  else planningQps[size.key] = v;
                  onChange({ ...inputs, planningQps });
                }}
              />
            ))}
          </div>
        </details>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Wire the form into the view**

In `src/app/(app)/simulator/simulator-view.tsx`, add the import:

```ts
import { SimulatorForm } from "./simulator-form";
```

and replace the left column's stand-in:

```tsx
        {/* Replaced by <SimulatorForm> in Task 12. */}
        <pre className="text-xs">{JSON.stringify({ edited, preset: inputs.preset, choosePreset: typeof choosePreset, change: typeof change }, null, 2)}</pre>
```

with:

```tsx
        <SimulatorForm inputs={inputs} edited={edited} onChange={change} onPreset={choosePreset} />
```

The "Reset to preset" button calls `onPreset(inputs.preset)`. Because `edited` is true, `choosePreset` asks for confirmation before resetting.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Check it in the browser**

Reload `http://localhost:3100/simulator`.
Expected:
- The form shows Starting point, Stack, the four input groups and a collapsed Assumptions section.
- Typing `25000` into "Monthly active users" changes the URL to contain `mau=25000` within about half a second.
- Choosing Supabase "Free" disables "Database compute", with the hint "Free uses Nano".
- Choosing preset "Consumer app" after an edit shows a confirm dialog. Accept it with `browser_batch`, or verify with `find` that the preset changed.
- There are no console errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/simulator/simulator-form.tsx" "src/app/(app)/simulator/simulator-view.tsx"
git commit -m "feat(simulator): add inputs form"
```

---

### Task 13: Results view

**Files:**
- Create: `src/app/(app)/simulator/simulator-results.tsx`
- Modify: `src/app/(app)/simulator/simulator-view.tsx`

- [ ] **Step 1: Create the results component**

Create `src/app/(app)/simulator/simulator-results.tsx`:

```tsx
"use client";

import { Calculator, ExternalLink } from "lucide-react";
import { CostProjectionChart } from "@/components/charts";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, Select, StatCard, Table, Td, Th, type Tone } from "@/components/ui";
import type { SimulationResult, VerdictKind } from "@/lib/engine/simulate";
import { CATALOG, SERVICE_LABELS } from "@/lib/engine/simulate/catalog";
import { formatAmount, formatPerUser, formatQps } from "@/lib/engine/simulate/format";
import { formatCount, formatMoney } from "@/lib/units";

const usd = (n: number) => formatMoney(n, "USD");
const FIXED_KEYS = new Set(["base", "compute", "credit"]);
const VERDICT: Record<VerdictKind, { title: string; tone: Tone }> = {
  add_cache: { title: "Add a cache", tone: "accent" },
  no_cache_needed: { title: "No cache needed", tone: "ok" },
  upgrade_compute: { title: "Upgrade compute instead", tone: "warn" },
  no_tier_fits: { title: "No compute size fits", tone: "crit" },
  not_applicable: { title: "Cache comparison not available", tone: "neutral" },
};

export function SimulatorResults({ result, month, onMonth }: { result: SimulationResult; month: number; onMonth: (m: number) => void }) {
  const services = result.provenance.map((p) => p.service);
  if (services.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Calculator className="size-8" />} title="Pick at least one service">
          Turn on Supabase, Vercel or Cloudflare to see estimated costs.
        </EmptyState>
      </Card>
    );
  }

  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  const selected = result.months[month - 1] ?? first;
  const labels = Object.fromEntries(services.map((s) => [s, SERVICE_LABELS[s]]));
  const chartData = result.months.map((m) => ({
    month: `M${m.month}`,
    restricted: m.restricted,
    ...Object.fromEntries(services.map((s) => [s, m.totalsByService[s] ?? 0])),
  }));
  const verdict = VERDICT[result.verdict.kind];
  const anyRestricted = result.months.some((m) => m.restricted);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Month 1" value={usd(first.total)} hint="per month, estimated" />
        <StatCard label="Month 12" value={usd(last.total)} hint={`${formatCount(last.usage.mau)} MAU`} />
        <StatCard label="Cost per MAU" value={first.usage.mau > 0 ? formatPerUser(first.total / first.usage.mau) : "—"} hint="month 1" />
        <StatCard
          label="Peak DB load"
          value={first.computeSize ? `${formatQps(first.usage.peakDbQps)} q/s` : "—"}
          hint={first.computeSize ? `month 1, ${CATALOG.compute.find((c) => c.key === first.computeSize)?.label} compute` : "Supabase is off"}
        />
      </div>

      <Notice tone={verdict.tone} title={verdict.title}>
        <p>{result.verdict.message}</p>
        {result.verdict.kind !== "add_cache" && result.verdict.paysOffMonth ? (
          <p className="mt-1">A cache starts paying off in month {result.verdict.paysOffMonth}.</p>
        ) : null}
      </Notice>

      <Card>
        <CardHeader title="12-month projection" description="Monthly cost by service. Growth compounds each month." />
        <CardBody>
          <CostProjectionChart data={chartData} keys={services} labels={labels} />
          {anyRestricted ? <p className="mt-2 text-xs text-muted">Hatched months go over a free plan limit, so a paid plan would be needed.</p> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What happens when" />
        <CardBody>
          {result.events.length === 0 ? (
            <p className="text-sm text-muted">No plan limits, overages or compute changes within 12 months.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {result.events.map((e) => (
                <li key={e.key} className="flex items-start gap-3 text-sm">
                  <Badge tone={e.kind === "plan_limit" || e.kind === "compute_saturated" ? "crit" : e.kind === "cache_pays_off" ? "accent" : "warn"} className="mt-0.5 shrink-0">
                    Month {e.month}
                  </Badge>
                  <span>
                    <span className="font-medium text-text">{SERVICE_LABELS[e.service]}:</span> {e.message}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Line items"
          description="Usage, included allowance and estimated cost per service."
          actions={
            <Select aria-label="Month" value={month} onChange={(e) => onMonth(Number(e.target.value))} className="h-7 w-28 text-xs">
              {result.months.map((m) => (
                <option key={m.month} value={m.month}>
                  Month {m.month}
                </option>
              ))}
            </Select>
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th className="text-right">Usage</Th>
              <Th className="text-right">Included</Th>
              <Th className="text-right">Billable</Th>
              <Th className="text-right">Cost</Th>
            </tr>
          </thead>
          {services.map((s) => (
            <tbody key={s}>
              <tr>
                <Td colSpan={5} className="bg-surface-2 text-xs font-semibold text-text">
                  {SERVICE_LABELS[s]}
                </Td>
              </tr>
              {selected.items
                .filter((i) => i.service === s)
                .map((i) => {
                  const fixed = FIXED_KEYS.has(i.key);
                  return (
                    <tr key={i.key}>
                      <Td>
                        {i.label}
                        {i.restricted ? (
                          <Badge tone="crit" className="ml-2">
                            Over plan limit
                          </Badge>
                        ) : null}
                        {i.note ? <p className="text-xs text-muted">{i.note}</p> : null}
                      </Td>
                      <Td className="num text-right">{fixed ? "—" : formatAmount(i.usage, i.unit)}</Td>
                      <Td className="num text-right">{fixed ? "—" : formatAmount(i.included, i.unit)}</Td>
                      <Td className="num text-right">{fixed ? "—" : formatAmount(i.billable, i.unit)}</Td>
                      <Td className="num text-right font-medium">{usd(i.cost)}</Td>
                    </tr>
                  );
                })}
              <tr>
                <Td colSpan={4} className="text-right text-xs text-muted">
                  Subtotal
                </Td>
                <Td className="num text-right font-semibold">{usd(selected.totalsByService[s] ?? 0)}</Td>
              </tr>
            </tbody>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader title="Where the prices come from" />
        <CardBody>
          <ul className="flex flex-col gap-1.5 text-sm">
            {result.provenance.map((p) => (
              <li key={`${p.service}:${p.plan}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text">{p.label}</span>
                <span className="text-xs text-muted">
                  version {p.version}, checked {p.verifiedAt}
                </span>
                {p.stale ? <Badge tone="warn">May be outdated</Badge> : null}
                <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  Source <ExternalLink className="size-3" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Estimates from published prices and your assumptions. Not a bill.</p>
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Wire the results into the view**

In `src/app/(app)/simulator/simulator-view.tsx`, add the import:

```ts
import { SimulatorResults } from "./simulator-results";
```

and replace the right column's stand-in:

```tsx
        {/* Replaced by <SimulatorResults> in Task 13. */}
        <pre className="text-xs">{JSON.stringify({ month, setMonth: typeof setMonth, total: result.months[0]?.total }, null, 2)}</pre>
```

with:

```tsx
        <SimulatorResults result={result} month={month} onMonth={setMonth} />
```

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors, and all tests pass.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/simulator/simulator-results.tsx" "src/app/(app)/simulator/simulator-view.tsx"
git commit -m "feat(simulator): add results view"
```

---

### Task 14: Browser verification and README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Verify each preset in the browser**

With the dev server running and signed in, load `http://localhost:3100/simulator` and use `get_page_text` or `read_page` to check:

1. **Small SaaS (default):** four KPI tiles with dollar amounts, a verdict notice, a 12-bar chart, a "What happens when" section, a line-item table grouped by Supabase and Vercel with subtotals, and a provenance list with source links.
2. **`?p=side_project`:** Supabase Free and Vercel Hobby. If any month goes over a free limit, the chart note about hatched months appears and the timeline shows a "plan limit" event.
3. **`?p=consumer_app`:** the Upstash Redis section appears in the line items, and the verdict is one of the four applicable kinds.
4. **`?p=small_saas&sb=off&vc=off`:** the "Pick at least one service" empty state.
5. **`?mau=abc&zzz=1`:** the "Some settings were adjusted" notice with two items.

`read_console_messages` must show no errors in any of these.

- [ ] **Step 2: Check the URL survives a reload**

Change "Monthly active users" to `42000` and Cache to "Upstash Redis". Wait about a second, then reload. Check that both values are kept, and that the URL contains `mau=42000&` … `ca=upstash_payg` (order follows the field order).

- [ ] **Step 3: Check mobile and dark mode**

Use `resize_window` with preset `mobile`, then take a screenshot. Check that the form stacks above the results, there's no horizontal page scroll (`document.documentElement.scrollWidth <= window.innerWidth` via `javascript_tool`), and the line-item table scrolls inside its card. Switch with `colorScheme: "dark"`, take a screenshot, and check that the chart and badges are legible. Reset with preset `desktop`.

- [ ] **Step 4: Take proof screenshots**

Take a desktop screenshot of the Small SaaS results, to show the user at the end.

- [ ] **Step 5: Document the simulator in the README**

In `README.md`, in the architecture table, change the UI row to:

```markdown
| UI | `src/app/(app)/` | Home, Applications, Providers, Usage explorer, Limits & quotas, Cost simulator, Alerts, Settings |
```

and add this subsection after the "Key behaviours (mapped to the PRD)" list:

```markdown
### Cost simulator

`/simulator` estimates monthly costs for a workload you describe, without reading any connected account. Pick a preset, turn on the services in your stack (Supabase, Upstash Redis, Vercel, Cloudflare), and set where the API runs and where files live. Then adjust users, traffic, database queries, data sizes and growth.

- **Engine.** `src/lib/engine/simulate/` is pure and deterministic: inputs → resolved stack → monthly usage → priced line items → a 12-month projection with events.
- **Cache vs. compute.** Every month is priced both with and without a cache in front of the database. The verdict says whether a cache saves money (in compute size or Supabase egress), or whether a larger compute size is cheaper. Supabase doesn't publish query throughput, so the planning QPS per compute size is an editable assumption.
- **Prices.** Price sheets in `catalog.ts` record their source and verification date. A sheet more than 90 days old is flagged as possibly outdated. Free-plan limits show as restrictions, never as charges.
- **Sharing.** Inputs live in the URL (only values that differ from the preset), so a scenario can be bookmarked or shared.
```

Also change the test count line `npm test` runs 50 tests to the number `npm test` now reports.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document the cost simulator"
```
