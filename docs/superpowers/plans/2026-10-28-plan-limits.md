# Plan Limits and Plan Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show plan-limit progress bars per service in the cost simulator, add a `/simulator/compare` page that lays every plan side by side for the same workload, and add Firebase (Spark, Blaze) as a fifth priced service.

**Architecture:** Bars are derived from the line items the pure engine already prices (`limits.ts`), so there is one source of truth for limits. The comparison page reruns `simulate()` once per plan with that plan placed in its role (`compare.ts`) and reads only that service's items. Firebase is a new price sheet plus routing (`db` picks the backend) in the existing engine; graduated price tiers are added for Firebase Auth and egress.

**Tech Stack:** Next.js 16 (App Router, client components), React 19, TypeScript, Tailwind, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-plan-limits-design.md`

**Conventions to follow:**
- Engine files under `src/lib/engine/simulate/` are pure and deterministic. Only view components touch the router.
- Tests live in `tests/simulate/`, use `@/` imports, and use the round-number `TEST_CATALOG` from `tests/simulate/fixtures.ts`.
- Comments are sparse and explain why, not what. Match the surrounding style.
- Run a single test file with `npx vitest run tests/simulate/<file>.test.ts`.
- Commit messages: `feat(simulator): …` / `fix(simulator): …` / `docs: …`, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Prices (checked 2026-10-28):**
- Free quotas: https://firebase.google.com/pricing
- Identity Platform MAU tiers (Tier 1 providers): 0–50K free, 50K–100K $0.0055, 100K–1M $0.0046, 1M–10M $0.0032, 10M+ $0.0025 — https://cloud.google.com/identity-platform/pricing
- Firestore Standard, us-central1: reads $0.03 / 100K, writes $0.09 / 100K, storage $0.000205479 per GiB-hour (= $0.15 per GiB-month); internet egress 0–10 GiB free, 10–1,024 GiB $0.12, 1,024–10,240 GiB $0.11, 10,240+ GiB $0.08 — https://cloud.google.com/firestore/pricing
- Cloud Storage Standard, us-central1: $0.000027397 per GiB-hour (= $0.02 per GiB-month); internet egress 0–10 TiB $0.12, 10–150 TiB $0.11, 150+ TiB $0.08 per GiB — https://cloud.google.com/storage/pricing
- Cloud Functions invocations: 2M free, then $0.40 per million — Firebase pricing page

---

## File map

| File | Change |
|---|---|
| `src/lib/engine/cost.ts` | Add `PriceTier` and `graduatedCost()` |
| `src/lib/engine/simulate/catalog.ts` | `tiers` on `PriceItem`; `firebase` service, label, `GB_PER_GIB`, Spark and Blaze sheets |
| `src/lib/engine/simulate/inputs.ts` | `fb` and `db` inputs, `fs = firebase`, direct-host label |
| `src/lib/engine/simulate/stack.ts` | `firebase` and `backend` on `ResolvedStack`; routing rules |
| `src/lib/engine/simulate/workload.ts` | Rename `supabaseEgressGB` → `backendEgressGB` |
| `src/lib/engine/simulate/project.ts` | Compute and verdict follow `stack.backend`; `backend` on `SimulationResult` |
| `src/lib/engine/simulate/price.ts` | Graduated tiers, backend-aware Supabase usage, Firebase usage |
| `src/lib/engine/simulate/index.ts` | Return `backend` |
| `src/lib/engine/simulate/limits.ts` | **New.** `limitBars()` |
| `src/lib/engine/simulate/compare.ts` | **New.** `comparePlans()`, `cheapestThatFits()` |
| `src/app/globals.css`, `src/components/charts.tsx` | Fifth chart colour |
| `src/app/(app)/simulator/use-sim-inputs.ts` | **New.** URL-synced inputs hook, extracted from the view |
| `src/app/(app)/simulator/month-select.tsx` | **New.** Month select |
| `src/app/(app)/simulator/plan-limits.tsx` | **New.** `PlanLimits`, `LimitList`, `LimitBarRow` |
| `src/app/(app)/simulator/simulator-view.tsx` | Use the hook |
| `src/app/(app)/simulator/simulator-results.tsx` | Plan limits card, shared month select, backend-aware KPI and verdict |
| `src/app/(app)/simulator/simulator-form.tsx` | `db` only when both backends are on; `stackFields="routing"` mode |
| `src/app/(app)/simulator/compare/page.tsx`, `compare-view.tsx` | **New.** Comparison page |
| `tests/simulate/*.test.ts` | New `limits.test.ts`, `compare.test.ts`; additions elsewhere |
| `README.md`, the spec | Docs |

---

### Task 1: Graduated price tiers

**Files:**
- Modify: `src/lib/engine/cost.ts` (after `overageCost`, line ~28)
- Modify: `src/lib/engine/simulate/catalog.ts:28-38` (`PriceItem`)
- Modify: `src/lib/engine/simulate/price.ts` (`priceSheet`)
- Test: `tests/simulate/price.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/simulate/price.test.ts` (add `graduatedCost` and `Catalog` imports at the top):

```ts
import { graduatedCost } from "@/lib/engine/cost";
import type { Catalog } from "@/lib/engine/simulate/catalog";

const MAU_TIERS = [
  { upTo: 100_000, unitPrice: 0.0055 },
  { upTo: 1_000_000, unitPrice: 0.0046 },
  { upTo: 10_000_000, unitPrice: 0.0032 },
  { upTo: null, unitPrice: 0.0025 },
];

describe("graduatedCost", () => {
  it("charges nothing within the included quantity", () => {
    expect(graduatedCost(40_000, 50_000, MAU_TIERS)).toBe(0);
  });

  it("charges each tier's price for the units inside it", () => {
    expect(graduatedCost(80_000, 50_000, MAU_TIERS)).toBe(165);
    // Google's own worked examples on the Identity Platform pricing page.
    expect(graduatedCost(131_000, 50_000, MAU_TIERS)).toBe(417.6);
    expect(graduatedCost(225_000, 50_000, MAU_TIERS)).toBe(850);
  });

  it("uses the unbounded last tier", () => {
    expect(graduatedCost(12_000_000, 50_000, MAU_TIERS)).toBe(38_215);
  });

  it("starts billing at the included quantity when it sits above the first boundary", () => {
    expect(graduatedCost(200_000, 150_000, MAU_TIERS)).toBe(230);
  });

  it("prices per unit size", () => {
    expect(graduatedCost(5_000_000, 2_000_000, [{ upTo: null, unitPrice: 0.4 }], 1_000_000)).toBe(1.2);
  });
});

describe("priceMonth with tiers", () => {
  it("prices a tiered item with graduatedCost", () => {
    const catalog: Catalog = {
      ...TEST_CATALOG,
      sheets: TEST_CATALOG.sheets.map((s) =>
        s.service === "supabase" && s.plan === "pro"
          ? {
              ...s,
              items: s.items.map((i) =>
                i.key === "mau" ? { ...i, tiers: [{ upTo: 200_000, unitPrice: 0.00325 }, { upTo: null, unitPrice: 0.001 }] } : i,
              ),
            }
          : s,
      ),
    };
    const items = priceMonth(zeroUsage({ mau: 250_000 }), stackWith(), "micro", catalog);
    expect(items.find((i) => i.service === "supabase" && i.key === "mau")?.cost).toBe(375);
  });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run tests/simulate/price.test.ts`
Expected: FAIL — `graduatedCost` is not exported from `@/lib/engine/cost`.

- [ ] **Step 3: Implement**

In `src/lib/engine/cost.ts`, after `overageCost`:

```ts
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
```

In `src/lib/engine/simulate/catalog.ts`, import the type and extend `PriceItem`:

```ts
import type { PriceTier } from "../cost";
```

```ts
export interface PriceItem {
  key: string;
  label: string;
  unit: string;
  includedQuantity: number;
  /** null: going over the included quantity is a restriction on this plan, not a charge. With `tiers`, the first tier's price. */
  unitPrice: number | null;
  /** Price applies per this many units. */
  unitSize: number;
  billingMode: "per_unit" | "package";
  /** Graduated tiers, ascending; the last has no bound. Replaces the single `unitPrice` rate. */
  tiers?: PriceTier[];
  note?: string;
}
```

In `src/lib/engine/simulate/price.ts`, import `graduatedCost` next to `overageCost` and change the `cost:` line in `priceSheet`:

```ts
import { graduatedCost, overageCost, round2 } from "../cost";
```

```ts
      cost:
        item.unitPrice === null
          ? 0
          : item.tiers
            ? graduatedCost(used, item.includedQuantity, item.tiers, item.unitSize)
            : overageCost(used, { ...item, unitPrice: item.unitPrice }),
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/simulate/price.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/cost.ts src/lib/engine/simulate/catalog.ts src/lib/engine/simulate/price.ts tests/simulate/price.test.ts
git commit -m "feat(simulator): support graduated price tiers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Firebase and database-backend inputs

**Files:**
- Modify: `src/lib/engine/simulate/inputs.ts`
- Test: `tests/simulate/inputs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("decode", …)` block of `tests/simulate/inputs.test.ts`:

```ts
  it("reads the Firebase plan, database backend and Cloud Storage file store", () => {
    const { inputs, notices } = decode(params("fb=blaze&db=firebase&fs=firebase"));
    expect(inputs).toMatchObject({ firebase: "blaze", db: "firebase", fileStore: "firebase" });
    expect(notices).toEqual([]);
  });

  it("defaults Firebase off with Supabase as the database in every preset", () => {
    for (const p of PRESETS) expect(presetInputs(p)).toMatchObject({ firebase: "off", db: "supabase" });
  });
```

Append inside the `describe("encode", …)` block:

```ts
  it("round-trips the Firebase inputs", () => {
    const edited = { ...presetInputs("small_saas"), firebase: "spark" as const, db: "firebase" as const, fileStore: "firebase" as const };
    const query = encode(edited);
    expect(query).toBe("p=small_saas&fb=spark&db=firebase&fs=firebase");
    expect(decode(params(query)).inputs).toEqual(edited);
  });
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run tests/simulate/inputs.test.ts`
Expected: FAIL — `fb` is reported as an unknown setting, and `firebase` is undefined on presets.

- [ ] **Step 3: Implement**

In `src/lib/engine/simulate/inputs.ts`:

Replace the choice types and host labels at the top:

```ts
export type SupabaseChoice = "off" | "free" | "pro" | "team";
export type FirebaseChoice = "off" | "spark" | "blaze";
export type Backend = "supabase" | "firebase";
export type CacheChoice = "off" | "upstash_payg";
export type VercelChoice = "off" | "hobby" | "pro";
export type CloudflareChoice = "off" | "free" | "paid";
export type Host = "vercel" | "cloudflare" | "direct";
export type FileStore = "supabase" | "r2" | "firebase";

export const HOSTS: Host[] = ["vercel", "cloudflare", "direct"];
export const BACKENDS: Backend[] = ["supabase", "firebase"];
export const HOST_LABELS: Record<Host, string> = {
  vercel: "Vercel",
  cloudflare: "Cloudflare Workers",
  direct: "Client calls the backend directly",
};
```

In `SimInputs`, under `// Stack`, after `compute`:

```ts
  firebase: FirebaseChoice;
  /** Which backend holds the database when Supabase and Firebase are both on. */
  db: Backend;
```

Extend `EnumKey`:

```ts
export type EnumKey = "supabase" | "compute" | "firebase" | "db" | "cache" | "vercel" | "cloudflare" | "host" | "fileStore";
```

Replace `ENUM_FIELDS`:

```ts
export const ENUM_FIELDS: EnumField[] = [
  choice("supabase", "sb", "Supabase", [["off", "Off"], ["free", "Free"], ["pro", "Pro"], ["team", "Team"]]),
  choice("compute", "cmp", "Database compute", [["auto", "Auto (smallest that fits)"], ...CATALOG.compute.map((c): [string, string] => [c.key, c.label])]),
  choice("firebase", "fb", "Firebase", [["off", "Off"], ["spark", "Spark (no cost)"], ["blaze", "Blaze (pay as you go)"]]),
  choice("db", "db", "Database", [["supabase", "Supabase"], ["firebase", "Firebase (Firestore)"]]),
  choice("cache", "ca", "Cache", [["off", "Off"], ["upstash_payg", "Upstash Redis (pay as you go)"]]),
  choice("vercel", "vc", "Vercel", [["off", "Off"], ["hobby", "Hobby"], ["pro", "Pro"]]),
  choice("cloudflare", "cf", "Cloudflare", [["off", "Off"], ["free", "Workers Free"], ["paid", "Workers Paid"]]),
  choice("host", "host", "API runs on", HOSTS.map((h): [string, string] => [h, HOST_LABELS[h]])),
  choice("fileStore", "fs", "File storage", [["supabase", "Supabase Storage"], ["r2", "Cloudflare R2"], ["firebase", "Cloud Storage for Firebase"]]),
];
```

Replace `ROUTING`:

```ts
const ROUTING = { compute: "auto", firebase: "off", db: "supabase", cloudflare: "off", host: "vercel", fileStore: "supabase", dbQueriesOverride: null } as const;
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/simulate/inputs.test.ts`
Expected: PASS. Then `npm run typecheck`. Expected: no errors (the stack doesn't read the new fields yet).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/inputs.ts tests/simulate/inputs.test.ts
git commit -m "feat(simulator): add Firebase, database backend and Cloud Storage inputs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Backend routing, compute and verdict

**Files:**
- Modify: `src/lib/engine/simulate/stack.ts`
- Modify: `src/lib/engine/simulate/workload.ts` (rename field)
- Modify: `src/lib/engine/simulate/price.ts:39` (renamed field)
- Modify: `src/lib/engine/simulate/project.ts` (`chooseCompute`, `cacheVerdict`, `SimulationResult`)
- Modify: `src/lib/engine/simulate/index.ts`
- Test: `tests/simulate/stack.test.ts`, `tests/simulate/project.test.ts`, `tests/simulate/simulate.test.ts`, plus the rename in `tests/simulate/fixtures.ts`, `price.test.ts`, `workload.test.ts`

- [ ] **Step 1: Rename `supabaseEgressGB` to `backendEgressGB` everywhere**

```bash
grep -rl supabaseEgressGB src tests | xargs sed -i '' 's/supabaseEgressGB/backendEgressGB/g'
```

In `src/lib/engine/simulate/workload.ts`, update the field's doc comment:

```ts
  /** DB response egress billed by the backend, Supabase or Firebase (excludes file downloads). */
  backendEgressGB: number;
```

Run: `npx vitest run tests/simulate && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 2: Write the failing tests**

Append to the `describe("resolveStack", …)` block in `tests/simulate/stack.test.ts` (extend the import to `import { DIRECT_REASON, FIREBASE_BACKEND_REASON, NO_SUPABASE_REASON, resolveStack } from "@/lib/engine/simulate/stack";`):

```ts
  it("uses Firebase as the database when it is the only backend, and moves files to it", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze" }));
    expect(stack).toMatchObject({ supabase: null, firebase: "blaze", backend: "firebase", fileStore: "firebase", host: "vercel" });
    expect(notices).toEqual(["Supabase is off, so files are stored in Cloud Storage for Firebase."]);
  });

  it("follows db when both backends are on, keeping the other for files", () => {
    const { stack, notices } = resolveStack(inputsWith({ firebase: "blaze", db: "firebase" }));
    expect(stack).toMatchObject({ supabase: "pro", firebase: "blaze", backend: "firebase", fileStore: "supabase" });
    expect(notices).toEqual([]);
  });

  it("ignores db when it names a backend that is off", () => {
    expect(resolveStack(inputsWith({ db: "firebase" })).stack.backend).toBe("supabase");
    expect(resolveStack(inputsWith({ supabase: "off", firebase: "off" })).stack.backend).toBeNull();
  });

  it("doesn't price a second backend that nothing uses", () => {
    const fb = resolveStack(inputsWith({ firebase: "spark" }));
    expect(fb.stack.firebase).toBeNull();
    expect(fb.notices).toEqual(["Firebase is on, but Supabase is the database and nothing else uses it, so it isn't priced."]);

    const sb = resolveStack(inputsWith({ firebase: "blaze", db: "firebase", fileStore: "firebase" }));
    expect(sb.stack.supabase).toBeNull();
    expect(sb.notices).toEqual(["Supabase is on, but Firebase is the database and nothing else uses it, so it isn't priced."]);
  });

  it("uses Supabase Storage when Cloud Storage for Firebase is picked without Firebase", () => {
    const { stack, notices } = resolveStack(inputsWith({ fileStore: "firebase" }));
    expect(stack.fileStore).toBe("supabase");
    expect(notices).toEqual(["Cloud Storage for Firebase needs Firebase, so Supabase Storage is used."]);
  });

  it("falls back from R2 to the backend's own file storage", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze", fileStore: "r2" }));
    expect(stack.fileStore).toBe("firebase");
    expect(notices).toEqual(["R2 file storage needs Cloudflare, so Cloud Storage for Firebase is used."]);
  });

  it("doesn't price the cache in front of Firebase", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze", fileStore: "firebase", cache: "upstash_payg" }));
    expect(stack.cache).toBe(false);
    expect(stack.cacheBlockedReason).toBe(FIREBASE_BACKEND_REASON);
    expect(notices).toEqual(["The cache is modelled in front of a Supabase database, so it isn't priced while Firebase is the database."]);
  });

  it("names the backend when the client calls it directly", () => {
    const { stack, notices } = resolveStack(inputsWith({ supabase: "off", firebase: "blaze", fileStore: "firebase", vercel: "off" }));
    expect(stack.host).toBe("direct");
    expect(notices).toEqual(["Vercel is turned off, so the client calls Firebase directly."]);
  });
```

Append to `tests/simulate/project.test.ts` (extend the stack import with `FIREBASE_BACKEND_REASON`):

```ts
describe("Firebase as the database", () => {
  it("gives the cache verdict as not applicable", () => {
    const v = verdict(inputsWith({ supabase: "off", firebase: "blaze", cache: "upstash_payg" }));
    expect(v.kind).toBe("not_applicable");
    expect(v.message).toBe(FIREBASE_BACKEND_REASON);
  });

  it("puts a files-only Supabase on its smallest paid size, whatever the database load", () => {
    expect(compute(atQps(500, { firebase: "blaze", db: "firebase" }))).toEqual({ key: "micro", fits: true });
  });
});
```

Append inside `describe("simulate", …)` in `tests/simulate/simulate.test.ts`:

```ts
  it("reports which backend holds the database", () => {
    expect(run(inputsWith()).backend).toBe("supabase");
    expect(run(inputsWith({ supabase: "off" })).backend).toBeNull();
  });
```

- [ ] **Step 3: Run the tests and check they fail**

Run: `npx vitest run tests/simulate/stack.test.ts tests/simulate/project.test.ts tests/simulate/simulate.test.ts`
Expected: FAIL — `FIREBASE_BACKEND_REASON` is not exported, `backend` is undefined.

- [ ] **Step 4: Implement `stack.ts`**

Replace `src/lib/engine/simulate/stack.ts` with:

```ts
import {
  type Backend,
  BACKENDS,
  type CloudflareChoice,
  type FileStore,
  type FirebaseChoice,
  type Host,
  HOSTS,
  type SimInputs,
  type SupabaseChoice,
  type VercelChoice,
} from "./inputs";

export interface ResolvedStack {
  /** Priced Supabase plan. Not necessarily the database: see `backend`. */
  supabase: Exclude<SupabaseChoice, "off"> | null;
  firebase: Exclude<FirebaseChoice, "off"> | null;
  /** Which service holds the database, auth, functions and realtime. */
  backend: Backend | null;
  compute: SimInputs["compute"];
  /** Whether the cache is priced. */
  cache: boolean;
  cacheBlockedReason: string | null;
  vercel: Exclude<VercelChoice, "off"> | null;
  seats: number;
  cloudflare: Exclude<CloudflareChoice, "off"> | null;
  host: Host;
  fileStore: FileStore;
}

export const DIRECT_REASON =
  "A cache needs a server-side API host (Vercel or Cloudflare). With the client calling Supabase directly there is nowhere to put one.";
export const NO_SUPABASE_REASON = "The cache is modelled in front of a Supabase database. Turn on Supabase to price it.";
export const FIREBASE_BACKEND_REASON = "The cache is modelled in front of a Supabase database. Firebase is the database, so it isn't priced.";

const BACKEND_LABELS: Record<Backend, string> = { supabase: "Supabase", firebase: "Firebase" };
const STORE_LABELS: Record<FileStore, string> = { supabase: "Supabase Storage", r2: "Cloudflare R2", firebase: "Cloud Storage for Firebase" };

const HOST_OFF: Record<Host, string> = {
  vercel: "Vercel is turned off",
  cloudflare: "Cloudflare is turned off",
  direct: "Supabase is turned off",
};
const HOST_NOW: Record<Exclude<Host, "direct">, string> = {
  vercel: "the API runs on Vercel",
  cloudflare: "the API runs on Cloudflare Workers",
};

/** Applies the routing rules so every mix of services is coherent. */
export function resolveStack(inputs: SimInputs): { stack: ResolvedStack; notices: string[] } {
  const notices: string[] = [];
  let supabase = inputs.supabase === "off" ? null : inputs.supabase;
  let firebase = inputs.firebase === "off" ? null : inputs.firebase;
  const vercel = inputs.vercel === "off" ? null : inputs.vercel;
  const cloudflare = inputs.cloudflare === "off" ? null : inputs.cloudflare;

  // `db` is only offered while both backends are on, so falling back from an off one needs no notice.
  const backendOn: Record<Backend, boolean> = { supabase: supabase !== null, firebase: firebase !== null };
  const backend = backendOn[inputs.db] ? inputs.db : (BACKENDS.find((b) => backendOn[b]) ?? null);

  const hostOn: Record<Host, boolean> = { vercel: vercel !== null, cloudflare: cloudflare !== null, direct: backend !== null };
  const hostNow = (h: Host) => (h === "direct" ? `the client calls ${BACKEND_LABELS[backend ?? "supabase"]} directly` : HOST_NOW[h]);
  let host = inputs.host;
  if (!hostOn[host]) {
    host = HOSTS.find((h) => hostOn[h]) ?? "direct";
    // With nothing on at all the page shows an empty state, so no notice is needed.
    if (hostOn[host]) notices.push(`${HOST_OFF[inputs.host]}, so ${hostNow(host)}.`);
  }

  let fileStore = inputs.fileStore;
  if (fileStore === "r2" && cloudflare === null) {
    fileStore = backend ?? "supabase";
    notices.push(
      backend !== null
        ? `R2 file storage needs Cloudflare, so ${STORE_LABELS[backend]} is used.`
        : "R2 file storage needs Cloudflare, and Supabase is off, so file storage isn't priced.",
    );
  } else if (fileStore === "firebase" && firebase === null) {
    fileStore = "supabase";
    notices.push(
      supabase !== null
        ? "Cloud Storage for Firebase needs Firebase, so Supabase Storage is used."
        : "Cloud Storage for Firebase needs Firebase, and Supabase is off, so file storage isn't priced.",
    );
  } else if (fileStore === "supabase" && supabase === null && firebase !== null) {
    fileStore = "firebase";
    notices.push("Supabase is off, so files are stored in Cloud Storage for Firebase.");
  }

  let cache = inputs.cache !== "off";
  let cacheBlockedReason: string | null = null;
  if (cache && backend !== "supabase") {
    cache = false;
    if (backend === "firebase") {
      cacheBlockedReason = FIREBASE_BACKEND_REASON;
      notices.push("The cache is modelled in front of a Supabase database, so it isn't priced while Firebase is the database.");
    } else {
      cacheBlockedReason = NO_SUPABASE_REASON;
      notices.push("The cache is modelled in front of a Supabase database, so it isn't priced while Supabase is off.");
    }
  } else if (cache && host === "direct") {
    cache = false;
    cacheBlockedReason = DIRECT_REASON;
  }

  // A backend that holds neither the database nor the files would only add its base fee.
  if (supabase !== null && backend !== "supabase" && fileStore !== "supabase") {
    supabase = null;
    notices.push("Supabase is on, but Firebase is the database and nothing else uses it, so it isn't priced.");
  }
  if (firebase !== null && backend !== "firebase" && fileStore !== "firebase") {
    firebase = null;
    notices.push("Firebase is on, but Supabase is the database and nothing else uses it, so it isn't priced.");
  }

  return {
    stack: { supabase, firebase, backend, compute: inputs.compute, cache, cacheBlockedReason, vercel, seats: inputs.seats, cloudflare, host, fileStore },
    notices,
  };
}
```

- [ ] **Step 5: Implement `project.ts` and `index.ts`**

In `src/lib/engine/simulate/project.ts`:

Change the import from `./stack`:

```ts
import { DIRECT_REASON, FIREBASE_BACKEND_REASON, NO_SUPABASE_REASON, type ResolvedStack } from "./stack";
```

Add an import of the `Backend` type:

```ts
import type { Backend, SimInputs } from "./inputs";
```

(replacing the existing `import type { SimInputs } from "./inputs";`)

In `chooseCompute`, after `if (sizes.length === 0) return { key: null, fits: true };`:

```ts
  // Supabase only holds files here, so no database load reaches it.
  if (stack.backend !== "supabase") return { key: sizes[0].key, fits: true };
```

In `cacheVerdict`, replace the `na` line:

```ts
  const na =
    stack.backend === "firebase" ? FIREBASE_BACKEND_REASON : stack.backend === null ? NO_SUPABASE_REASON : stack.host === "direct" ? DIRECT_REASON : null;
```

In `SimulationResult`, add after `months`:

```ts
  /** Which service holds the database, or null with no backend on. */
  backend: Backend | null;
```

In `src/lib/engine/simulate/index.ts`, change the return:

```ts
  return { months, backend: stack.backend, verdict, events: collectEvents(months, verdict, stack, inputs, catalog), notices, provenance };
```

- [ ] **Step 6: Run the tests and check they pass**

Run: `npx vitest run tests/simulate && npm run typecheck`
Expected: PASS, no type errors. (The simulator UI still compiles: it doesn't read `backend` yet.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/engine/simulate tests/simulate
git commit -m "feat(simulator): route the database to Supabase or Firebase

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Firebase price sheets and pricing

**Files:**
- Modify: `src/lib/engine/simulate/catalog.ts`
- Modify: `src/lib/engine/simulate/price.ts` (`enabledPlans`, `usageFor`)
- Modify: `tests/simulate/fixtures.ts` (`TEST_CATALOG`)
- Test: `tests/simulate/catalog.test.ts`, `tests/simulate/price.test.ts`, `tests/simulate/simulate.test.ts`

- [ ] **Step 1: Add Firebase sheets to the test catalog**

In `tests/simulate/fixtures.ts`, add to the end of `TEST_CATALOG.sheets`:

```ts
    {
      ...sheet,
      service: "firebase",
      plan: "spark",
      label: "Firebase Spark",
      sourceUrl: "https://example.test/fb",
      baseFee: 0,
      items: [per("auth_mau", 50_000, null), per("fs_reads", 1_500_000, null), per("fn_invocations", 0, null), per("storage_gib", 0, null)],
    },
    {
      ...sheet,
      service: "firebase",
      plan: "blaze",
      label: "Firebase Blaze",
      sourceUrl: "https://example.test/fb",
      baseFee: 0,
      items: [
        { ...per("auth_mau", 50_000, 0.0055), tiers: [{ upTo: 100_000, unitPrice: 0.0055 }, { upTo: null, unitPrice: 0.0046 }] },
        per("fs_reads", 1_500_000, 0.03, 100_000),
        per("fs_storage_gib", 1, 0.15),
        per("storage_gib", 5, 0.02),
      ],
    },
```

- [ ] **Step 2: Write the failing tests**

In `tests/simulate/catalog.test.ts`, add `firebase: ["spark", "blaze"]` to `PLANS`, and append inside `describe("CATALOG", …)`:

```ts
  it("keeps graduated tiers ascending, unbounded last, and starting at the item's unit price", () => {
    for (const s of CATALOG.sheets) {
      for (const i of s.items) {
        if (!i.tiers) continue;
        expect(i.unitPrice).toBe(i.tiers[0].unitPrice);
        expect(i.tiers[i.tiers.length - 1].upTo).toBeNull();
        const bounds = i.tiers.slice(0, -1).map((t) => t.upTo as number);
        expect(bounds.every((b, k) => b > i.includedQuantity && (k === 0 || b > bounds[k - 1]))).toBe(true);
      }
    }
  });
```

Append to `tests/simulate/price.test.ts` (extend the fixtures import with `inputsWith` and add `import { GB_PER_GIB } from "@/lib/engine/simulate/catalog";` and `import { resolveStack } from "@/lib/engine/simulate/stack";`):

```ts
describe("priceMonth with Firebase", () => {
  const firebaseOnly = resolveStack(inputsWith({ supabase: "off", firebase: "blaze" })).stack;

  it("maps database, auth and file usage to Firebase when it is the backend", () => {
    const u = zeroUsage({ mau: 60_000, reads: 2_000_000, rtMessages: 500_000, dbSizeGB: 3 * GB_PER_GIB, storageGB: 10 * GB_PER_GIB });
    const fb = of(priceMonth(u, firebaseOnly, null, TEST_CATALOG), "firebase");
    expect(fb.find((i) => i.key === "auth_mau")).toMatchObject({ usage: 60_000, cost: 55 });
    // Realtime listener updates are billed as document reads.
    expect(fb.find((i) => i.key === "fs_reads")).toMatchObject({ usage: 2_500_000, cost: 0.3 });
    expect(fb.find((i) => i.key === "fs_storage_gib")).toMatchObject({ usage: 3, cost: 0.3 });
    expect(fb.find((i) => i.key === "storage_gib")).toMatchObject({ usage: 10, cost: 0.1 });
  });

  it("prices only files on the backend that doesn't hold the database", () => {
    const u = zeroUsage({ mau: 120_000, backendEgressGB: 200, fileEgressGB: 100, storageGB: 10 * GB_PER_GIB });
    const sbFiles = priceMonth(u, stackWith({ firebase: "blaze", db: "firebase" }), "micro", TEST_CATALOG);
    expect(sbFiles.find((i) => i.service === "supabase" && i.key === "mau")?.usage).toBe(0);
    expect(sbFiles.find((i) => i.service === "supabase" && i.key === "egress_gb")?.usage).toBe(100);
    expect(sbFiles.find((i) => i.service === "firebase" && i.key === "auth_mau")?.usage).toBe(120_000);

    const fbFiles = priceMonth(u, stackWith({ firebase: "blaze", fileStore: "firebase" }), "micro", TEST_CATALOG);
    expect(fbFiles.find((i) => i.service === "firebase" && i.key === "auth_mau")?.usage).toBe(0);
    expect(fbFiles.find((i) => i.service === "firebase" && i.key === "storage_gib")?.usage).toBe(10);
  });

  it("restricts Cloud Functions on Spark as soon as they're used", () => {
    const spark = resolveStack(inputsWith({ supabase: "off", firebase: "spark" })).stack;
    // Vercel Pro has an fn_invocations item too, so match the service.
    const fn = priceMonth(zeroUsage({ fnInvocations: 10 }), spark, null, TEST_CATALOG).find((i) => i.service === "firebase" && i.key === "fn_invocations")!;
    expect(fn).toMatchObject({ service: "firebase", restricted: true, cost: 0 });
  });
});
```

Append inside `describe("simulate", …)` in `tests/simulate/simulate.test.ts`:

```ts
  it("produces finite, non-negative totals for every preset with Firebase as the backend", () => {
    for (const p of PRESETS) {
      for (const firebase of ["spark", "blaze"] as const) {
        const r = simulate({ ...presetInputs(p), firebase, db: "firebase" }, { now: NOW });
        expect(r.backend).toBe("firebase");
        for (const m of r.months) {
          expect(Number.isFinite(m.total)).toBe(true);
          expect(m.total).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
```

- [ ] **Step 3: Run the tests and check they fail**

Run: `npx vitest run tests/simulate`
Expected: FAIL — type `"firebase"` is not a `Service`, `GB_PER_GIB` isn't exported, and no Firebase sheets exist.

- [ ] **Step 4: Implement the catalog**

In `src/lib/engine/simulate/catalog.ts`:

```ts
export type Service = "supabase" | "upstash" | "vercel" | "cloudflare" | "firebase";

export const SERVICE_LABELS: Record<Service, string> = {
  supabase: "Supabase",
  upstash: "Upstash Redis",
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  firebase: "Firebase",
};

/** Google Cloud bills storage and transfer in GiB; the workload model counts GB. */
export const GB_PER_GIB = 1.073741824;
```

Add next to the other `*_VERIFIED` constants:

```ts
const FIREBASE_VERIFIED = "2026-10-28";
```

Add above `export const CATALOG`:

```ts
const AUTH_NOTE = "With Identity Platform (email, phone, anonymous and social sign-in). SAML and OIDC users have their own, smaller quota.";
const DAILY_NOTE = "shown per month. The free quota resets daily, so a busy day can reach it first.";
const READS_NOTE = `50,000 a day, ${DAILY_NOTE} Realtime listener updates count as reads.`;
const WRITES_NOTE = `20,000 a day, ${DAILY_NOTE} Deletes aren't modelled separately.`;
const NEEDS_BLAZE = "Needs the Blaze plan.";
const GCP_EGRESS = "Internet egress to most destinations; Asia and Australia cost more.";
```

Add to the end of `CATALOG.sheets`:

```ts
    {
      service: "firebase",
      plan: "spark",
      label: "Firebase Spark",
      version: VERSION,
      verifiedAt: FIREBASE_VERIFIED,
      sourceUrl: "https://firebase.google.com/pricing",
      baseFee: 0,
      items: [
        item("auth_mau", "Auth monthly active users", "users", 50_000, null, 1, AUTH_NOTE),
        item("fs_reads", "Firestore document reads", "reads", 1_500_000, null, 1, READS_NOTE),
        item("fs_writes", "Firestore document writes", "writes", 600_000, null, 1, WRITES_NOTE),
        item("fs_storage_gib", "Firestore stored data", "GiB", 1, null),
        item("fs_egress_gib", "Firestore network egress", "GiB", 10, null),
        item("fn_invocations", "Cloud Functions invocations", "calls", 0, null, 1, NEEDS_BLAZE),
        item("storage_gib", "Cloud Storage", "GiB", 0, null, 1, NEEDS_BLAZE),
        item("storage_egress_gib", "Cloud Storage downloads", "GiB", 0, null, 1, NEEDS_BLAZE),
      ],
    },
    {
      service: "firebase",
      plan: "blaze",
      label: "Firebase Blaze",
      version: VERSION,
      verifiedAt: FIREBASE_VERIFIED,
      sourceUrl: "https://firebase.google.com/pricing",
      baseFee: 0,
      items: [
        {
          ...item("auth_mau", "Auth monthly active users", "users", 50_000, 0.0055, 1, AUTH_NOTE),
          tiers: [
            { upTo: 100_000, unitPrice: 0.0055 },
            { upTo: 1_000_000, unitPrice: 0.0046 },
            { upTo: 10_000_000, unitPrice: 0.0032 },
            { upTo: null, unitPrice: 0.0025 },
          ],
        },
        item("fs_reads", "Firestore document reads", "reads", 1_500_000, 0.03, 100_000, `Rate in us-central1. ${READS_NOTE}`),
        item("fs_writes", "Firestore document writes", "writes", 600_000, 0.09, 100_000, `Rate in us-central1. ${WRITES_NOTE}`),
        item("fs_storage_gib", "Firestore stored data", "GiB", 1, 0.15, 1, "Rate in us-central1, per GiB-month."),
        {
          ...item("fs_egress_gib", "Firestore network egress", "GiB", 10, 0.12, 1, GCP_EGRESS),
          tiers: [
            { upTo: 1_024, unitPrice: 0.12 },
            { upTo: 10_240, unitPrice: 0.11 },
            { upTo: null, unitPrice: 0.08 },
          ],
        },
        item("fn_invocations", "Cloud Functions invocations", "calls", 2_000_000, 0.4, 1_000_000, "Invocations only. Compute time (GB-seconds, CPU-seconds) isn't modelled."),
        item("storage_gib", "Cloud Storage", "GiB", 5, 0.02, 1, "Standard storage in us-central1. The free 5 GB applies only in us-central1, us-west1 and us-east1."),
        {
          ...item("storage_egress_gib", "Cloud Storage downloads", "GiB", 100, 0.12, 1, GCP_EGRESS),
          tiers: [
            { upTo: 10_240, unitPrice: 0.12 },
            { upTo: 153_600, unitPrice: 0.11 },
            { upTo: null, unitPrice: 0.08 },
          ],
        },
      ],
    },
```

- [ ] **Step 5: Implement pricing**

In `src/lib/engine/simulate/price.ts`, import `GB_PER_GIB` from `./catalog`, then replace `enabledPlans` and the `supabase` case, and add a `firebase` case in `usageFor`:

```ts
import { type Catalog, type ComputeKey, computeSize, GB_PER_GIB, type PriceSheet, type Service, sheetFor } from "./catalog";
```

```ts
export function enabledPlans(stack: ResolvedStack): { service: Service; plan: string }[] {
  const plans: [Service, string | null][] = [
    ["supabase", stack.supabase],
    ["firebase", stack.firebase],
    ["upstash", stack.cache ? "payg" : null],
    ["vercel", stack.vercel],
    ["cloudflare", stack.cloudflare],
  ];
  return plans.flatMap(([service, plan]) => (plan === null ? [] : [{ service, plan }]));
}
```

```ts
    case "supabase": {
      const db = stack.backend === "supabase";
      const files = stack.fileStore === "supabase";
      return {
        mau: db ? u.mau : 0,
        db_disk_gb: db ? u.dbSizeGB : 0,
        storage_gb: files ? u.storageGB : 0,
        egress_gb: (db ? u.backendEgressGB : 0) + (files ? u.fileEgressGB : 0),
        fn_invocations: db ? u.fnInvocations : 0,
        rt_peak: db ? u.rtPeakConnections : 0,
        rt_messages: db ? u.rtMessages : 0,
      };
    }
    case "firebase": {
      const db = stack.backend === "firebase";
      const files = stack.fileStore === "firebase";
      return {
        auth_mau: db ? u.mau : 0,
        // Firestore bills each realtime listener update as a document read.
        fs_reads: db ? u.reads + u.rtMessages : 0,
        fs_writes: db ? u.writes : 0,
        fs_storage_gib: db ? u.dbSizeGB / GB_PER_GIB : 0,
        fs_egress_gib: db ? u.backendEgressGB / GB_PER_GIB : 0,
        fn_invocations: db ? u.fnInvocations : 0,
        storage_gib: files ? u.storageGB / GB_PER_GIB : 0,
        storage_egress_gib: files ? u.fileEgressGB / GB_PER_GIB : 0,
      };
    }
```

- [ ] **Step 6: Run the tests and check they pass**

Run: `npx vitest run tests/simulate && npm run typecheck`
Expected: PASS. Typecheck may flag `src/components/charts.tsx` or the simulator UI only if they exhaustively switch on `Service`; they don't today, so no errors are expected.

- [ ] **Step 7: Commit**

```bash
git add src/lib/engine/simulate tests/simulate
git commit -m "feat(simulator): price Firebase Spark and Blaze

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Plan limit bars engine

**Files:**
- Create: `src/lib/engine/simulate/limits.ts`
- Test: `tests/simulate/limits.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/simulate/limits.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run tests/simulate/limits.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/simulate/limits`.

- [ ] **Step 3: Implement**

Create `src/lib/engine/simulate/limits.ts`:

```ts
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
      else if (it.usage > 0) payFromFirst.push({ ...base, cost: it.cost });
      continue;
    }
    const pct = (it.usage / it.included) * 100;
    const state: LimitState = it.restricted ? "blocked" : over(it) ? "paying" : pct >= NEAR_LIMIT_PCT ? "near" : "ok";
    bars.push({ ...base, pct, state, overageCost: state === "blocked" ? 0 : it.cost, hitsLimitMonth: firstOver(it), notOnPlan: false });
  }
  return { bars, payFromFirst };
}
```

Re-export the types from `src/lib/engine/simulate/index.ts` (next to the other `export type` lines):

```ts
export type { LimitBar, LimitState, PayFromFirstUnit } from "./limits";
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/simulate/limits.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/limits.ts src/lib/engine/simulate/index.ts tests/simulate/limits.test.ts
git commit -m "feat(simulator): derive plan limit bars from line items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Plan comparison engine

**Files:**
- Create: `src/lib/engine/simulate/compare.ts`
- Test: `tests/simulate/compare.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/simulate/compare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { simulate } from "@/lib/engine/simulate";
import { cheapestThatFits, comparePlans, type PlanVariant } from "@/lib/engine/simulate/compare";
import { DIRECT_REASON, NO_SUPABASE_REASON, resolveStack } from "@/lib/engine/simulate/stack";
import { inputsWith, TEST_CATALOG } from "./fixtures";

const NOW = new Date("2026-10-28T12:00:00Z");
const compare = (overrides = {}, month = 1) => comparePlans(inputsWith(overrides), month, { catalog: TEST_CATALOG, now: NOW });
const find = (variants: PlanVariant[], service: string, plan: string) => variants.find((v) => v.service === service && v.plan === plan)!;

describe("comparePlans", () => {
  it("prices every plan of every service in its role", () => {
    const { variants } = comparePlans(inputsWith(), 1, { now: NOW });
    expect(variants.map((v) => `${v.role}:${v.service}:${v.plan}`)).toEqual([
      "backend:supabase:free",
      "backend:supabase:pro",
      "backend:supabase:team",
      "backend:firebase:spark",
      "backend:firebase:blaze",
      "hosting:vercel:hobby",
      "hosting:vercel:pro",
      "hosting:cloudflare:free",
      "hosting:cloudflare:paid",
      "cache:upstash:payg",
    ]);
  });

  it("skips plans the catalog doesn't have", () => {
    expect(compare().variants.some((v) => v.service === "supabase" && v.plan === "team")).toBe(false);
  });

  it("reads only the compared service's costs and bars", () => {
    const v = find(compare().variants, "vercel", "pro");
    const direct = simulate(inputsWith({ host: "vercel" }), { catalog: TEST_CATALOG, now: NOW });
    expect(v.total).toBe(direct.months[0].totalsByService.vercel);
    expect(v.bars.length).toBeGreaterThan(0);
    expect(v.bars.every((b) => b.service === "vercel")).toBe(true);
  });

  it("moves files to the backend being compared, unless they live in R2", () => {
    const storage = (o = {}) => find(compare(o).variants, "firebase", "blaze").bars.find((b) => b.key === "storage_gib")!;
    expect(storage().used).toBeGreaterThan(0);
    expect(storage({ cloudflare: "paid", fileStore: "r2" }).used).toBe(0);
  });

  it("marks a plan over its limit when any bar is blocked", () => {
    const { variants } = compare({ mau: 60_000 });
    expect(find(variants, "supabase", "free").overLimit).toBe(true);
    expect(find(variants, "supabase", "pro").overLimit).toBe(false);
  });

  it("explains why the cache can't be priced", () => {
    expect(find(compare({ host: "direct" }).variants, "upstash", "payg")).toMatchObject({ unavailable: DIRECT_REASON, bars: [] });
    expect(find(compare({ supabase: "off" }).variants, "upstash", "payg").unavailable).toBe(NO_SUPABASE_REASON);
    expect(find(compare().variants, "upstash", "payg").unavailable).toBeNull();
  });

  it("returns the routing notices of your own stack only", () => {
    const inputs = inputsWith({ fileStore: "r2" });
    expect(comparePlans(inputs, 1, { catalog: TEST_CATALOG, now: NOW }).notices).toEqual(resolveStack(inputs).notices);
  });

  it("reads the requested month", () => {
    const m1 = find(compare({ growthPct: 50 }, 1).variants, "supabase", "pro");
    const m6 = find(compare({ growthPct: 50 }, 6).variants, "supabase", "pro");
    expect(m6.bars.find((b) => b.key === "mau")!.used).toBeGreaterThan(m1.bars.find((b) => b.key === "mau")!.used);
  });
});

describe("cheapestThatFits", () => {
  const v = (plan: string, total: number, extra: Partial<PlanVariant> = {}): PlanVariant => ({
    role: "backend", service: "supabase", plan, label: plan, total, bars: [], payFromFirst: [], overLimit: false, unavailable: null, ...extra,
  });

  it("picks the lowest total among plans that fit, the first on a tie", () => {
    const plans = [v("free", 0, { overLimit: true }), v("pro", 25), v("team", 25)];
    expect(cheapestThatFits(plans)?.plan).toBe("pro");
  });

  it("returns null when nothing fits", () => {
    expect(cheapestThatFits([v("free", 0, { overLimit: true }), v("cache", 0, { unavailable: "no" })])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx vitest run tests/simulate/compare.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/simulate/compare`.

- [ ] **Step 3: Implement**

Create `src/lib/engine/simulate/compare.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run tests/simulate/compare.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/simulate/compare.ts tests/simulate/compare.test.ts
git commit -m "feat(simulator): compare every plan against the same workload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: UI groundwork: fifth chart colour, inputs hook, month select

**Files:**
- Modify: `src/app/globals.css` (light block near line 30, dark block near line 62)
- Modify: `src/components/charts.tsx:136` and `:208`
- Create: `src/app/(app)/simulator/use-sim-inputs.ts`
- Create: `src/app/(app)/simulator/month-select.tsx`
- Modify: `src/app/(app)/simulator/simulator-view.tsx`

No unit tests: these are UI moves with no logic change. They are covered by typecheck now and the browser check in Task 11.

- [ ] **Step 1: Add the fifth chart colour**

In `src/app/globals.css`, after `--chart-4: #a64fd1;` (light) add:

```css
  --chart-5: #c2415d;
```

and after `--chart-4: #a774d6;` (dark) add:

```css
    --chart-5: #e0697c;
```

In `src/components/charts.tsx`:

```ts
const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
```

and in `CostProjectionChart`:

```ts
  const series = keys.slice(0, 5);
```

- [ ] **Step 2: Extract the URL-synced inputs hook**

Create `src/app/(app)/simulator/use-sim-inputs.ts` holding the logic now in `simulator-view.tsx`:

```ts
"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { decode, encode, type PresetKey, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";

/**
 * Simulator inputs mirrored into the URL, shared by the simulator and the plan comparison.
 * `onNavigate` runs when the URL changes from outside (a link, Back/Forward).
 */
export function useSimInputs(initialNotices: string[], onNavigate?: () => void) {
  const params = useSearchParams();
  const urlQuery = params.toString();
  // Seed from the live URL rather than server props: on Back, Next.js can restore a cached
  // render whose props describe an older query than the one in the address bar.
  const [inputs, setInputs] = useState(() => decode(Object.fromEntries(params)).inputs);
  const [urlNotices, setUrlNotices] = useState(initialNotices);
  const query = encode(inputs);
  const edited = query !== encode(presetInputs(inputs.preset));

  const navigateRef = useRef(onNavigate);
  useEffect(() => {
    navigateRef.current = onNavigate;
  }, [onNavigate]);

  // The query this hook last wrote, so its own writes aren't read back as navigation.
  const lastWritten = useRef<string | null>(null);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  // A write that was never read back (e.g. the page was hidden first) mustn't mask a later visit.
  useEffect(
    () => () => {
      lastWritten.current = null;
    },
    [],
  );

  // Mirror inputs into the URL so a scenario can be bookmarked or shared. The native
  // history API avoids re-running the server component on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      if (window.location.search.slice(1) === query) return;
      lastWritten.current = query;
      window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  // Follow URL changes this hook didn't make (a nav link, Back/Forward).
  // Our own write is skipped once, even if the user has typed on since it was scheduled.
  useEffect(() => {
    if (urlQuery === lastWritten.current) {
      lastWritten.current = null;
      return;
    }
    if (urlQuery === queryRef.current) return;
    const next = decode(Object.fromEntries(new URLSearchParams(urlQuery)));
    if (encode(next.inputs) === queryRef.current) return;
    setInputs(next.inputs);
    setUrlNotices(next.notices);
    navigateRef.current?.();
  }, [urlQuery]);

  const change = (next: SimInputs) => {
    setUrlNotices([]);
    setInputs(next);
  };

  const choosePreset = (preset: PresetKey) => {
    if (preset === inputs.preset && !edited) return;
    const prompt = preset === inputs.preset ? "Reset to the preset? Your changes will be lost." : "Switch preset? Your changes to the current one will be lost.";
    if (edited && !window.confirm(prompt)) return;
    change(presetInputs(preset));
  };

  return { inputs, query, edited, urlNotices, change, choosePreset };
}
```

- [ ] **Step 3: Use the hook in the simulator view**

Replace `src/app/(app)/simulator/simulator-view.tsx` with:

```tsx
"use client";

import { useMemo, useState } from "react";
import { Notice } from "@/components/ui";
import { simulate } from "@/lib/engine/simulate";
import { SimulatorForm } from "./simulator-form";
import { SimulatorResults } from "./simulator-results";
import { useSimInputs } from "./use-sim-inputs";

export function SimulatorView({ initialNotices, now }: { initialNotices: string[]; now: string }) {
  const [month, setMonth] = useState(1);
  const sim = useSimInputs(initialNotices, () => setMonth(1));
  const result = useMemo(() => simulate(sim.inputs, { now: new Date(now) }), [sim.inputs, now]);
  const notices = [...sim.urlNotices, ...result.notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <SimulatorForm inputs={sim.inputs} edited={sim.edited} onChange={sim.change} onPreset={sim.choosePreset} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {notices.length > 0 ? (
          <Notice tone="warn" title="Some settings were adjusted">
            <ul className="list-disc pl-4">
              {notices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <SimulatorResults result={result} month={month} onMonth={setMonth} query={sim.query} />
      </div>
    </div>
  );
}
```

(`SimulatorResults` gains the `query` prop in Task 8. Until then typecheck reports it as an unknown prop; that is expected between Steps 3 and Task 8.)

- [ ] **Step 4: Add the month select**

Create `src/app/(app)/simulator/month-select.tsx`:

```tsx
"use client";

import { Select } from "@/components/ui";

export function MonthSelect({ months, value, onChange }: { months: number; value: number; onChange: (month: number) => void }) {
  return (
    <Select aria-label="Month" value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-7 w-auto text-xs">
      {Array.from({ length: months }, (_, i) => i + 1).map((m) => (
        <option key={m} value={m}>
          Month {m}
        </option>
      ))}
    </Select>
  );
}
```

- [ ] **Step 5: Commit** (after Task 8's typecheck passes — commit Tasks 7 and 8 together if you prefer a green tree at every commit)

```bash
git add src/app/globals.css src/components/charts.tsx "src/app/(app)/simulator/use-sim-inputs.ts" "src/app/(app)/simulator/month-select.tsx" "src/app/(app)/simulator/simulator-view.tsx"
git commit -m "refactor(simulator): share URL-synced inputs and the month select; fifth chart colour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Plan limits card and Firebase in the simulator UI

**Files:**
- Create: `src/app/(app)/simulator/plan-limits.tsx`
- Modify: `src/app/(app)/simulator/simulator-results.tsx`
- Modify: `src/app/(app)/simulator/simulator-form.tsx`

- [ ] **Step 1: Create the limit components**

Create `src/app/(app)/simulator/plan-limits.tsx`:

```tsx
"use client";

import clsx from "clsx";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, type Tone } from "@/components/ui";
import type { LimitBar, LimitState, PayFromFirstUnit, SimulationResult } from "@/lib/engine/simulate";
import { formatAmount } from "@/lib/engine/simulate/format";
import { limitBars } from "@/lib/engine/simulate/limits";
import { formatMoney, formatPercent } from "@/lib/units";
import { MonthSelect } from "./month-select";

const usd = (n: number) => formatMoney(n, "USD");
const FILL: Record<LimitState, string> = { ok: "bg-ok", near: "bg-warn", paying: "bg-accent", blocked: "bg-crit" };

function badgeFor(bar: LimitBar, month: number): { tone: Tone; text: string } | null {
  const later = bar.hitsLimitMonth !== null && bar.hitsLimitMonth > month ? bar.hitsLimitMonth : null;
  switch (bar.state) {
    case "blocked":
      return { tone: "crit", text: bar.notOnPlan ? "Not on this plan" : "Over the limit: needs a paid plan" };
    case "paying":
      return { tone: "accent", text: `Over by ${formatAmount(bar.used - bar.included, bar.unit)} · ${usd(bar.overageCost)}/mo` };
    case "near":
      return { tone: "warn", text: later ? `Near the limit · passed in month ${later}` : "Near the limit" };
    case "ok":
      return later ? { tone: "neutral", text: `Passes the limit in month ${later}` } : null;
  }
}

export function LimitBarRow({ bar, month }: { bar: LimitBar; month: number }) {
  const width = Math.min(100, bar.pct);
  const usage = bar.notOnPlan ? `${formatAmount(bar.used, bar.unit)} used` : `${formatAmount(bar.used, bar.unit)} of ${formatAmount(bar.included, bar.unit)}`;
  const badge = badgeFor(bar, month);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="font-medium text-text">{bar.label}</span>
        <span className="num text-xs text-muted">{usage}</span>
      </div>
      <div className="flex items-center gap-2">
        <div
          className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-label={bar.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(width)}
          aria-valuetext={bar.notOnPlan ? `Not on this plan, ${usage}` : `${formatPercent(bar.pct)} of the allowance, ${usage}`}
        >
          <div className={clsx("absolute inset-y-0 left-0 rounded-full", FILL[bar.state])} style={{ width: `${width}%` }} />
        </div>
        <span className="num w-14 shrink-0 text-right text-xs font-medium text-text">{bar.notOnPlan ? "—" : formatPercent(bar.pct)}</span>
      </div>
      {badge ? (
        <div>
          <Badge tone={badge.tone}>{badge.text}</Badge>
        </div>
      ) : null}
    </li>
  );
}

export function LimitList({ bars, payFromFirst, month }: { bars: LimitBar[]; payFromFirst: PayFromFirstUnit[]; month: number }) {
  return (
    <>
      {bars.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {bars.map((b) => (
            <LimitBarRow key={b.key} bar={b} month={month} />
          ))}
        </ul>
      ) : null}
      {payFromFirst.length > 0 ? (
        <p className={clsx("text-xs text-muted", bars.length > 0 && "mt-3")}>
          Billed from the first unit: {payFromFirst.map((p) => `${p.label} ${formatAmount(p.used, p.unit)} · ${usd(p.cost)}`).join("; ")}
        </p>
      ) : null}
    </>
  );
}

export function PlanLimits({ result, month, onMonth, compareHref }: { result: SimulationResult; month: number; onMonth: (m: number) => void; compareHref: string }) {
  const { bars, payFromFirst } = limitBars(result, month);
  return (
    <Card>
      <CardHeader
        title="Plan limits"
        description="How close this month's usage is to each plan's allowance, and what you pay past it."
        actions={
          <>
            <MonthSelect months={result.months.length} value={month} onChange={onMonth} />
            <Link href={compareHref} className="text-xs font-medium text-accent hover:underline">
              Compare plans
            </Link>
          </>
        }
      />
      <CardBody className="flex flex-col gap-5">
        {result.provenance.map((p) => {
          const own = bars.filter((b) => b.service === p.service);
          const first = payFromFirst.filter((f) => f.service === p.service);
          if (own.length === 0 && first.length === 0) return null;
          return (
            <section key={p.service}>
              <h3 className="mb-2 text-xs font-semibold text-text">{p.label}</h3>
              <LimitList bars={own} payFromFirst={first} month={month} />
            </section>
          );
        })}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 2: Wire it into the results**

In `src/app/(app)/simulator/simulator-results.tsx`:

Imports: drop `Select` from the `@/components/ui` import, and add:

```ts
import { MonthSelect } from "./month-select";
import { PlanLimits } from "./plan-limits";
```

Signature:

```tsx
export function SimulatorResults({ result, month, onMonth, query }: { result: SimulationResult; month: number; onMonth: (m: number) => void; query: string }) {
```

Empty state text:

```tsx
          Turn on Supabase, Firebase, Vercel or Cloudflare to see estimated costs.
```

Replace the "Peak DB load" `StatCard`:

```tsx
        <StatCard
          label="Peak DB load"
          value={result.backend !== null ? `${formatQps(first.usage.peakDbQps)} q/s` : "—"}
          hint={
            result.backend === "supabase"
              ? `month 1, ${CATALOG.compute.find((c) => c.key === first.computeSize)?.label} compute`
              : result.backend === "firebase"
                ? "month 1, Firestore scales automatically"
                : "No database is on"
          }
        />
```

Replace the verdict condition `{first.computeSize !== null ? (` with:

```tsx
      {result.backend === "supabase" ? (
```

Directly after the verdict block (before the "12-month projection" card), add:

```tsx
      <PlanLimits result={result} month={month} onMonth={onMonth} compareHref={`/simulator/compare?${query}`} />
```

Replace the Line items card's `actions={<Select …>…</Select>}` with:

```tsx
          actions={<MonthSelect months={result.months.length} value={month} onChange={onMonth} />}
```

- [ ] **Step 3: Show `db` only when both backends are on; add the routing-only mode**

In `src/app/(app)/simulator/simulator-form.tsx`, add above `SimulatorForm`:

```ts
/** Stack choices that apply to every plan on the comparison page. */
const ROUTING_FIELDS = new Set<string>(["compute", "host", "fileStore"]);
```

Then extend the props and stack card:

```tsx
export function SimulatorForm({
  inputs,
  edited,
  onChange,
  onPreset,
  stackFields = "all",
}: {
  inputs: SimInputs;
  edited: boolean;
  onChange: (next: SimInputs) => void;
  onPreset: (preset: PresetKey) => void;
  /** "routing": only choices that apply to every plan, for the plan comparison. */
  stackFields?: "all" | "routing";
}) {
  const seats = NUMBER_FIELDS.find((f) => f.name === "seats")!;
  const routing = stackFields === "routing";
  // Compute is pinned only while Supabase Free is the plan being priced; the comparison prices every plan.
  const freeCompute = !routing && inputs.supabase === "free";
  // Only the sizes the current plan can use: Free runs on its single size, everything else on the paid ones.
  const planSizes = CATALOG.compute.filter((c) => (inputs.supabase === "free" ? c.key === CATALOG.freeCompute : c.key !== CATALOG.freeCompute));
  const bothBackends = inputs.supabase !== "off" && inputs.firebase !== "off";
  const stack = ENUM_FIELDS.filter((f) => (routing ? ROUTING_FIELDS.has(f.name) : f.name !== "db" || bothBackends));
```

Replace the Stack card:

```tsx
      <Card>
        <CardHeader
          title={routing ? "Routing" : "Stack"}
          description={routing ? "Every plan is shown on the right. These choices apply to all of them." : "Turn on the services you use."}
        />
        <CardBody className={FIELD_GRID}>
          {stack.map((f) => (
            <EnumInput
              key={f.name}
              field={f}
              inputs={inputs}
              onChange={onChange}
              disabled={f.name === "compute" && freeCompute}
              hint={f.name === "compute" && freeCompute ? "Free uses Nano" : undefined}
              value={f.name === "compute" && freeCompute ? CATALOG.freeCompute : undefined}
            />
          ))}
          {routing || inputs.vercel === "pro" ? <FieldInput field={seats} inputs={inputs} onChange={onChange} /> : null}
        </CardBody>
      </Card>
```

- [ ] **Step 4: Typecheck and run all tests**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass. (The RLS integration tests skip if the local Supabase stack isn't running.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/simulator"
git commit -m "feat(simulator): plan limits card and Firebase in the stack form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Plan comparison page

**Files:**
- Create: `src/app/(app)/simulator/compare/page.tsx`
- Create: `src/app/(app)/simulator/compare/compare-view.tsx`

- [ ] **Step 1: Create the page**

Create `src/app/(app)/simulator/compare/page.tsx`:

```tsx
import { PageHeader } from "@/components/ui";
import { decode } from "@/lib/engine/simulate/inputs";
import { CompareView } from "./compare-view";

export const metadata = { title: "Compare plans" };

export default async function ComparePage({ searchParams }: PageProps<"/simulator/compare">) {
  const { notices } = decode(await searchParams);
  return (
    <>
      <PageHeader
        title="Compare plans"
        description="Every plan of every service against the same workload: how close it gets to each limit, and what it costs. Nothing here reads your connected accounts."
      />
      {/* One clock for server and client, so price staleness can't differ across hydration. */}
      <CompareView initialNotices={notices} now={new Date().toISOString()} />
    </>
  );
}
```

- [ ] **Step 2: Create the view**

Create `src/app/(app)/simulator/compare/compare-view.tsx`:

```tsx
"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Card, CardBody, CardHeader, Notice, type Tone } from "@/components/ui";
import { cheapestThatFits, comparePlans, type PlanVariant, ROLES } from "@/lib/engine/simulate/compare";
import { formatMoney } from "@/lib/units";
import { MonthSelect } from "../month-select";
import { LimitList } from "../plan-limits";
import { SimulatorForm } from "../simulator-form";
import { useSimInputs } from "../use-sim-inputs";

const usd = (n: number) => formatMoney(n, "USD");
const MONTHS = 12;

function PlanCard({ variant: v, best, month }: { variant: PlanVariant; best: boolean; month: number }) {
  const badge: { tone: Tone; text: string } | null = v.unavailable
    ? null
    : v.overLimit
      ? { tone: "crit", text: "Over limit" }
      : best
        ? { tone: "ok", text: "Cheapest that fits" }
        : { tone: "neutral", text: "Fits" };
  return (
    <div className={clsx("flex min-w-0 flex-col gap-3 rounded-md border p-3", best ? "border-ok/40" : "border-border")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{v.label}</h3>
          {v.unavailable ? null : (
            <p className="num text-lg font-semibold text-text">
              {usd(v.total)}
              <span className="text-xs font-normal text-muted"> /mo</span>
            </p>
          )}
        </div>
        {badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : null}
      </div>
      {v.unavailable ? <p className="text-sm text-muted">{v.unavailable}</p> : <LimitList bars={v.bars} payFromFirst={v.payFromFirst} month={month} />}
    </div>
  );
}

export function CompareView({ initialNotices, now }: { initialNotices: string[]; now: string }) {
  const [month, setMonth] = useState(1);
  const sim = useSimInputs(initialNotices, () => setMonth(1));
  const { variants, notices } = useMemo(() => comparePlans(sim.inputs, month, { now: new Date(now) }), [sim.inputs, month, now]);
  const allNotices = [...sim.urlNotices, ...notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <SimulatorForm inputs={sim.inputs} edited={sim.edited} onChange={sim.change} onPreset={sim.choosePreset} stackFields="routing" />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={`/simulator?${sim.query}`} className="text-sm font-medium text-accent hover:underline">
            ← Back to simulator
          </Link>
          <MonthSelect months={MONTHS} value={month} onChange={setMonth} />
        </div>
        {allNotices.length > 0 ? (
          <Notice tone="warn" title="Some settings were adjusted">
            <ul className="list-disc pl-4">
              {allNotices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {ROLES.map((role) => {
          const own = variants.filter((v) => v.role === role.key);
          // A badge for the only plan in a role compares it with nothing.
          const best = own.length > 1 ? cheapestThatFits(own) : null;
          return (
            <Card key={role.key}>
              <CardHeader title={role.label} description={role.description} />
              <CardBody className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {own.map((v) => (
                  <PlanCard key={`${v.service}:${v.plan}`} variant={v} best={v === best} month={month} />
                ))}
              </CardBody>
            </Card>
          );
        })}
        <p className="text-xs text-muted">Estimates from published prices and your assumptions. Not a bill.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Regenerate route types and typecheck**

Run: `npx next typegen && npm run typecheck`
Expected: no errors (`PageProps<"/simulator/compare">` resolves once the route types are generated).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/simulator/compare"
git commit -m "feat(simulator): add the plan comparison page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs

**Files:**
- Modify: `README.md` (Cost simulator section, line ~84, and the testing bullet, line ~123)
- Modify: `docs/superpowers/specs/2026-10-28-plan-limits-design.md`

- [ ] **Step 1: README**

In the "Cost simulator" section, add a paragraph after its existing description:

```markdown
The **Plan limits** card shows, for each service you turn on, how close the simulated month is to every plan allowance, the month you pass it, and what you pay beyond it. **Compare plans** (`/simulator/compare`) uses the same inputs and URL to lay out every plan side by side by role (backend: Supabase or Firebase; API hosting: Vercel or Cloudflare; cache: Upstash), marking the cheapest plan that fits. Firebase Spark and Blaze are priced: Auth MAU, Firestore reads, writes, storage and egress, Cloud Functions invocations and Cloud Storage.
```

Change the testing bullet to:

```markdown
- **Cost simulator**: price catalog structure, URL encoding and presets, stack routing (including the Supabase/Firebase backend), the workload model, pricing, graduated tiers and unit conversions, compute choice and the cache verdict, events, plan limit bars, the plan comparison, and every preset against the real catalog.
```

- [ ] **Step 2: Bring the spec in line with the implementation**

Edit `docs/superpowers/specs/2026-10-28-plan-limits-design.md`:
- §1: `LimitBar` has `notOnPlan: boolean` and no `note`; `limitBars` takes `{ months: Pick<MonthResult, "month" | "items">[] }`.
- §3: `PlanVariant` uses `overLimit` and `unavailable` instead of `blocked` / `blockedReason`. A backend variant turns the other backend off and moves files to itself unless they live in R2. `notices` are the user's own stack's notices, not the variants' (remove the de-duplication edge case).
- §4 Routing: falling back from a `db` that names an off backend is silent (the select is hidden then). `fs = supabase` with Supabase off and Firebase on moves files to Cloud Storage for Firebase, with a notice.
- §4 Price sheets: keys are `fs_storage_gib`, `fs_egress_gib`, `storage_gib`, `storage_egress_gib`; Firebase items are in GiB, and usage is converted from GB with `GB_PER_GIB`. List the verified Blaze prices from this plan's header.
- Status line: "Implemented".

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-28-plan-limits-design.md
git commit -m "docs: document plan limits, plan comparison and Firebase

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Verification

- [ ] **Step 1: Full test run and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, no errors.

- [ ] **Step 2: Browser check on port 3100** (dev server via the preview tool, `.claude/launch.json`)

Check each of these, taking a screenshot of the first two:
1. `/simulator` (Small SaaS): the Plan limits card shows Supabase Pro and Vercel Pro bars. Change its month select to 12: the bars and the Line items table both move to month 12.
2. `/simulator?p=side_project&mau=60000`: Supabase Free's MAU bar is red with "Over the limit: needs a paid plan".
3. Turn Firebase on (Blaze) and pick Database → Firebase: Firebase appears in the chart (fifth colour), line items, and Plan limits; the cache verdict card is hidden; the Peak DB load hint says Firestore scales automatically.
4. Click "Compare plans": the comparison page opens with the same query. Edit MAU there, click "← Back to simulator", and confirm the new MAU carried across.
5. On `/simulator/compare` with each preset: Backend has five plan cards, API hosting four, and Cache one. Exactly one card per multi-plan role has "Cheapest that fits", unless every plan is over its limit.
6. `/simulator/compare?host=direct`: the Cache card shows the "server-side API host" reason.
7. Mobile (375 × 812) on both pages: no horizontal scroll, the bars wrap cleanly, and the plan cards stack.
8. Dark mode on both pages: bar fills and badges are readable.

- [ ] **Step 3: Fix anything found, re-run Step 1, commit any fixes**

```bash
git add -A
git commit -m "fix(simulator): <what the browser check found>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
