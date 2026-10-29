# Plan Limits and Plan Comparison — Design

Date: 2026-10-28
Status: Implemented
Builds on: `2026-10-27-cost-simulator-design.md`

## Goal

Show, for each service in the cost simulator, the limits of its plan and how close
the simulated workload is to each one: a progress bar per limit, the month it is
reached, and what you pay once you are past it. Add a page that compares every plan
of every service against the same workload, so you can see which plan fits and what
it costs. Add Firebase as a fifth priced service.

## Decisions

| Topic | Decision |
|---|---|
| Where | A "Plan limits" card on `/simulator`, and a new page `/simulator/compare` |
| Source of the bars | The line items the engine already prices. No second list of limits |
| Comparison input | The simulator's inputs and URL params, shared both ways |
| Comparison grouping | By role: Backend (Supabase vs Firebase), API hosting (Vercel vs Cloudflare), Cache (Upstash) |
| Firebase | Fully priced: Spark and Blaze plans, in the chart, line items, events, bars and comparison |
| Tiers | Graduated price tiers are added to the engine, because Firebase Auth and egress use them |
| Currency | Engine figures are USD; the UI shows them in the user's display currency (USD or PHP) through the existing currency feature |

## Non-goals

- Live usage from connected accounts. The Limits & quotas page is unchanged.
- Firebase Hosting, Realtime Database, Data Connect, Phone Auth SMS, Cloud Functions
  compute (GB-seconds, CPU-seconds) and Cloud Build. Only the items listed below are priced.
- Firestore Enterprise edition. Only Standard edition is priced.
- A recommendation engine. The comparison page marks the cheapest plan that fits; it
  does not change your stack.

## 1. Plan limit bars (`src/lib/engine/simulate/limits.ts`)

Pure, deterministic, unit-tested.

```ts
type LimitState = "ok" | "near" | "paying" | "blocked";

interface LimitBar {
  service: Service;
  key: string;            // the line item key
  label: string;
  unit: string;
  used: number;
  included: number;
  /** used ÷ included × 100. Not capped; the UI caps the fill at 100 %. 100 for an item the plan doesn't offer. */
  pct: number;
  state: LimitState;
  /** USD for usage past the included amount (the line item's cost). 0 when blocked. */
  overageCost: number;
  /** First month in the projection where used > included, or null within the horizon. */
  hitsLimitMonth: number | null;
  /** The plan doesn't offer this item at all (nothing included, no price). */
  notOnPlan: boolean;
}

interface PayFromFirstUnit { service: Service; key: string; label: string; unit: string; used: number; cost: number }

function limitBars(
  result: { months: Pick<MonthResult, "month" | "items">[] },
  month: number,
): { bars: LimitBar[]; payFromFirst: PayFromFirstUnit[] };
```

Rules:
- One bar per priced line item with `included > 0`. Fixed items (`base`, `compute`,
  `credit`) never get a bar.
- Items with `included = 0` and a unit price (Upstash commands, Vercel Pro
  invocations, Vercel Pro active CPU) go in `payFromFirst` instead, with their usage
  and cost.
- Items with `included = 0` and no unit price (Firebase Spark Cloud Functions and
  Cloud Storage) get a bar only when used (the line item is `restricted`), in state
  `blocked` with `pct = 100` and `notOnPlan: true`. When unused they are omitted.
- `state`:
  - `blocked`: the line item is `restricted` (over a limit the plan does not sell past).
  - `paying`: `used > included` and the item has a unit price.
  - `near`: `pct ≥ 75`.
  - `ok`: otherwise.
- `hitsLimitMonth` scans every month of `result.months` for the same service and key.
  If the limit is already passed in month 1, it is 1.
- The 75 % threshold is a named constant (`NEAR_LIMIT_PCT`), matching the alerts'
  default warning threshold.
- Bars are returned in the line items' order, grouped by service.
- A `month` outside the projection falls back to month 1.

## 2. Simulator: "Plan limits" card

On `/simulator`, placed after the cache verdict and before the projection chart.

- One section per enabled service, headed by the plan name (e.g. "Supabase Pro").
- Each bar shows: label, "used of included unit" (via `formatAmount`; "used" alone
  for a `notOnPlan` item), the percentage ("—" when not on the plan), and a badge:
  - `ok`: "Passes the limit in month N" when that month is later than the selected
    one, else no badge.
  - `near`: warn tone, "Near the limit", plus " · passed in month N" when it is later.
  - `paying`: accent tone, "Over by X · {cost}/mo".
  - `blocked`: crit tone, "Over the limit: needs a paid plan" (or "Not on this plan"
    for `notOnPlan` items).
- Costs are formatted in the user's display currency (USD or PHP).
- Fill colour follows the state (ok, warn, accent, crit tokens already in `ui.tsx`).
  The bar is an accessible `role="progressbar"` with `aria-valuenow` capped at 100
  and an `aria-valuetext` that states the real usage.
- Under the bars, `payFromFirst` items are listed as "Billed from the first unit:
  Commands 2.1M · $4.20", separated by semicolons.
- The card follows the selected month. The month select moves from the Line items
  card header into shared state in `simulator-view.tsx`, and both cards render it
  (`month-select.tsx`), labelled "Month for plan limits" and "Month for line items"
  for screen readers.
- A "Compare plans" link in the card header opens `/simulator/compare` with the
  current query string.

New component: `src/app/(app)/simulator/plan-limits.tsx` (`PlanLimits`, `LimitList`,
`LimitBarRow`). `LimitList` (bars plus the `payFromFirst` line) is shared with the
comparison page.

## 3. Comparison page (`/simulator/compare`)

### Layout

Inputs on the left, plans on the right (stacked on mobile), the same frame as the
simulator. The form (`SimulatorForm` with `stackFields="routing"`) shows the workload
groups and the selects that apply to every plan: compute size, cache, API host and
file storage. The per-service on/off and plan selects are hidden, because every plan
is shown. Compute is never pinned here, and the Assumptions list planning capacity
for every compute size, because the comparison prices both Free (Nano) and the paid
sizes. A month select (1–12, default 1) sits above the plans. A "Back to simulator"
link keeps the query string.

Three role sections:

| Role | Plans |
|---|---|
| Backend: database, auth, files, functions and realtime | Supabase Free, Pro, Team · Firebase Spark, Blaze |
| API hosting: where your API runs. R2 file storage isn't counted here | Vercel Hobby, Pro · Cloudflare Workers Free, Paid |
| Cache: in front of a Supabase database | Upstash Redis pay as you go |

Each plan card shows: plan name, the service's monthly total for that plan in the
selected month (in the display currency), the limit bars and `payFromFirst` list
(`LimitList`), and one badge:
- "Over limit" (crit) when `overLimit` is set. When the plan's largest compute size
  can't carry the load, the card also says "Database compute can't keep up with this
  load on this plan."
- "Cheapest that fits" (ok) on the lowest total in its role among plans that are
  neither over a limit nor unavailable. Ties go to the first plan in table order. A
  role with a single plan (Cache) gets no such badge, since there is nothing to compare.
- "Fits" otherwise.

When the cache can't be priced (no Supabase backend, or `host = direct`), the Cache
card shows the reason instead of a total and bars, using the existing reason strings.
When the user's cache is on, the Backend section notes that Supabase plans include the
cache's effect on database load, and that the cache itself is priced under Cache.

### How each plan is priced (`src/lib/engine/simulate/compare.ts`)

```ts
interface PlanVariant {
  role: "backend" | "hosting" | "cache";
  service: Service;
  plan: string;
  label: string;
  total: number;                 // the counted items' cost for the month (USD)
  bars: LimitBar[];
  payFromFirst: PayFromFirstUnit[];
  /** The largest compute size this plan offers carries the load; true where there's no compute to size. */
  computeFits: boolean;
  /** Some bar is `blocked`, or `computeFits` is false. */
  overLimit: boolean;
  /** Why the plan can't be priced with these inputs (cache only), else null. */
  unavailable: string | null;
}
function comparePlans(inputs: SimInputs, month: number, opts?: { catalog?: Catalog; now?: Date }): { variants: PlanVariant[]; notices: string[] };
function cheapestThatFits(variants: PlanVariant[]): PlanVariant | null;
```

For each plan, the user's inputs are copied and the plan is put in its role, then
`simulate()` runs and only that service's line items are read:
- Backend variant: set that service to the plan, `db` to that service, and turn the
  other backend off. Files move to the compared backend (Supabase Storage or Cloud
  Storage for Firebase) unless they live in R2.
- Hosting variant: set that service to the plan and `host` to that service. Cloudflare
  R2 items (`r2_*`) are left out of the variant's total, bars and `payFromFirst`: R2 is
  file storage billed on the Cloudflare account, not part of what hosting the API costs.
- Cache variant: set `cache = upstash_payg`. If the resolved stack blocks the cache,
  return `unavailable` with the stack's `cacheBlockedReason`, a zero total and no bars.
- Everything else (workload, compute choice, seats, and file storage apart from the
  backend rule above) comes from the user's inputs, so the numbers match the simulator
  for the plans the user picked.
- `month` is clamped to the projection (1 to its length).
- `notices` are the routing notices of the user's own stack. Each variant's notices
  describe a stack the user didn't pick, so they are not reported.
- Plans the catalog doesn't have are skipped.

There are 10 variants, each a 12-month `simulate()` call: cheap enough to run in the
browser on every change (memoised on the inputs and month).

### Shared URL state

The URL-sync logic in `simulator-view.tsx` (debounced `history.replaceState`,
following Back and Forward, preset confirm) moves into a hook,
`src/app/(app)/simulator/use-sim-inputs.ts`, used by both views. Both pages use
`decode`/`encode` from `inputs.ts`, so one query string works on both.

## 4. Firebase

### Inputs

| Input [key] | Values | Default in every preset |
|---|---|---|
| Firebase [`fb`] | `off`, `spark`, `blaze` | `off` |
| Database backend [`db`] | `supabase`, `firebase` | `supabase` |
| File storage [`fs`] | adds `firebase` (Cloud Storage) | unchanged |

`HOST_LABELS.direct` becomes "Client calls the backend directly". Presets are
unchanged apart from the new defaults, so existing URLs decode to the same inputs.

### Routing rules (`stack.ts`)

- `db` must name an enabled backend. If it doesn't, the other backend is used when
  it is on. This fallback is silent, because the `db` select is hidden unless both
  backends are on. With neither on, there is no backend: database, auth, functions
  and realtime are not priced (as today with Supabase off).
- The backend chosen by `db` receives MAU/auth, database queries and size, Edge or
  Cloud Functions, realtime, and the DB response egress.
- The other backend, when on, is priced only if file storage routes to it (its base
  fee, plus compute for Supabase, plus its file items). Otherwise it is not priced and
  a notice says "Supabase is on, but Firebase is the database and nothing else uses
  it, so it isn't priced." (and the mirror message).
- `fs = firebase` requires Firebase. Otherwise it falls back to Supabase if Supabase is
  on, else file storage isn't priced, with a notice (like `fs = r2`).
- `fs = supabase` with Supabase off and Firebase on moves files to Cloud Storage for
  Firebase, with the notice "Supabase is off, so files are stored in Cloud Storage for
  Firebase."
- `host = direct` requires a backend. The fallback order stays vercel → cloudflare →
  direct.
- The cache, the compute choice and the cache verdict require Supabase to be the
  `db` backend. With Firebase as the backend, the cache is not priced, its blocked
  reason is "The cache is modelled in front of a Supabase database. Firebase is the
  database, so it isn't priced.", and the verdict is `not_applicable`. The "Peak DB
  load" KPI shows the QPS with the hint "Firestore scales automatically".

`ResolvedStack` gains `firebase: "spark" | "blaze" | null` and
`backend: "supabase" | "firebase" | null`. `MonthUsage.supabaseEgressGB` is renamed
`backendEgressGB`; the formula is unchanged.

### Usage mapping (`price.ts` `usageFor("firebase")`)

| Line item key | Usage when Firebase is the backend | When only files route to it |
|---|---|---|
| `auth_mau` | `mau` | 0 |
| `fs_reads` | `reads + rtMessages` (no cache is priced in front of Firestore) | 0 |
| `fs_writes` | `writes` | 0 |
| `fs_storage_gib` | `dbSizeGB ÷ GB_PER_GIB` | 0 |
| `fs_egress_gib` | `backendEgressGB ÷ GB_PER_GIB` | 0 |
| `fn_invocations` | `fnInvocations` | 0 |
| `storage_gib` | `storageGB ÷ GB_PER_GIB` if `fs = firebase` | same |
| `storage_egress_gib` | `fileEgressGB ÷ GB_PER_GIB` if `fs = firebase` | same |

Firebase's GiB-denominated items stay in GiB, and the workload's GB figures are
converted with `GB_PER_GIB = 1.073741824` (exported from `catalog.ts`).

Firestore realtime listeners are billed as one document read per update delivered,
so realtime messages count as reads. Deletes are not modelled; writes include them.
These are stated assumptions in the line item notes.

### Price sheets (`catalog.ts`)

Free quotas below are from https://firebase.google.com/pricing; all Firebase prices
were verified on 2026-10-28 (`verifiedAt`), with `sourceUrl` recorded per the existing
rule (prices are never taken from memory). Daily quotas are shown per month (× 30), as
Cloudflare's are.

| Key | Label | Unit | Spark included | Spark price | Blaze included | Blaze price |
|---|---|---|---|---|---|---|
| `auth_mau` | Auth monthly active users | users | 50 000 | restricted | 50 000 | Graduated: to 100K $0.0055, to 1M $0.0046, to 10M $0.0032, above $0.0025 per MAU |
| `fs_reads` | Firestore document reads | reads | 1 500 000 (50K/day) | restricted | 1 500 000 | $0.03 per 100 000 |
| `fs_writes` | Firestore document writes | writes | 600 000 (20K/day) | restricted | 600 000 | $0.09 per 100 000 |
| `fs_storage_gib` | Firestore stored data | GiB | 1 | restricted | 1 | $0.15 per GiB-month ($0.000205479 per GiB-hour) |
| `fs_egress_gib` | Firestore network egress | GiB | 10 | restricted | 10 | Graduated: to 1 024 GiB $0.12, to 10 240 GiB $0.11, above $0.08 per GiB |
| `fn_invocations` | Cloud Functions invocations | calls | 0 (not on Spark) | restricted | 2 000 000 | $0.40 per million |
| `storage_gib` | Cloud Storage | GiB | 0 (not on Spark) | restricted | 5 | $0.02 per GiB-month ($0.000027397 per GiB-hour) |
| `storage_egress_gib` | Cloud Storage downloads | GiB | 0 (not on Spark) | restricted | 100 | Graduated: to 10 TiB $0.12, to 150 TiB $0.11, above $0.08 per GiB |

Price sources: Identity Platform (https://cloud.google.com/identity-platform/pricing,
Tier 1 providers), Firestore Standard edition in us-central1
(https://cloud.google.com/firestore/pricing), Cloud Storage Standard in us-central1
(https://cloud.google.com/storage/pricing), and the Firebase pricing page for Cloud
Functions invocations.

Region for location-priced items: `us-central1` (single region, for Firestore and
Cloud Storage alike), stated in each item's note. Notes state that Auth's MAU quota applies with Identity Platform,
that Spark's daily quotas reset daily so a busy day can hit them before the monthly
figure does, and that Cloud Storage free quotas apply only in us-central1, us-west1
and us-east1.

### Graduated tiers (`catalog.ts`, `price.ts`, `src/lib/engine/cost.ts`)

`PriceItem` gains:

```ts
/** Graduated: each tier's price applies to the units that fall inside it, above `includedQuantity`. */
tiers?: { upTo: number | null; unitPrice: number }[];
```

`upTo` is in the same units as usage, counted from zero (so a tier list mirrors a
provider's table), `null` means no upper bound, and the list is ascending. When
`tiers` is set, `unitPrice` holds the first tier's price, so code that only checks
"is there a price" keeps working. Cost = Σ over tiers of `max(0, min(used, upTo) −
max(included, previous upTo)) × price ÷ unitSize`, rounded to cents. If
`overageCost()` in `cost.ts` doesn't cover this, a sibling `graduatedCost()` is added
there and unit-tested.

### Results UI

- `SERVICE_LABELS.firebase = "Firebase"`, with a chart colour and hatch pattern like
  the others.
- Stack section of the form: a Firebase toggle and plan select, and a "Database"
  select shown only when Supabase and Firebase are both on.
- The empty state lists Firebase among the services to turn on.

### Events

The existing events work for Firebase line items (`plan_limit` on Spark,
`overage_start` on Blaze). The `plan_limit` message for an item the plan doesn't include
at all reads "This plan doesn't include {label}. A paid plan is required."; for an item
with an allowance it stays "Over the plan limit for {label} ({included} included). A
paid plan is required."

## Edge cases

- `included > 0` and `used = 0`: a bar at 0 %, state `ok`, no badge.
- `used` exactly equals `included`: `pct = 100`, state `near`, not `paying`.
- Firebase Spark with `functionPct > 0`: a `blocked` "Not on this plan" bar for
  Cloud Functions, and a `plan_limit` event.
- Both backends off: the Backend section on the comparison page still shows all five
  plans, because each variant turns its own service on.
- A Supabase Free variant whose Nano compute can't carry the load is over its limit
  even when no bar is blocked.
- Firebase is the database and files aren't on Supabase: Supabase isn't priced, so the
  simulator form doesn't pin its compute select (the "Supabase only stores files" hint
  applies only when files are on Supabase).

## Testing

`tests/simulate/`:
- `limits.test.ts`: each state, the 75 % boundary, 100 % exactly, `hitsLimitMonth` in
  month 1 / a later month / never, fixed items excluded, `payFromFirst`, Spark
  "not on this plan" bars only when used.
- `compare.test.ts`: every role's variants, a variant reads only its service's items,
  files move to the compared backend unless in R2, R2 left out of hosting,
  cheapest-that-fits with a tie and with nothing fitting, over limit from a blocked bar
  and from compute that can't keep up, the cache's unavailable reason, only the user's
  own notices, and the month clamp.
- `price.test.ts`: graduated tiers (inside the first tier, across tiers, unbounded
  last tier, included above the first boundary), Firebase usage mapping as backend
  and as files-only.
- `stack.test.ts`: `db` fallbacks, unused second backend notice, `fs = firebase`
  fallback, cache blocked by a Firebase backend.
- `inputs.test.ts`: `fb`, `db` and `fs = firebase` round trip; old URLs decode
  unchanged.
- `catalog.test.ts`: Firebase sheets have sources, verified dates and ascending tiers.
- Every preset still produces finite, non-negative totals, with Firebase on and off.

Then a browser check on port 3100: the Plan limits card on `/simulator` following the
month select, the Compare plans link round trip, `/simulator/compare` with each
preset, Firebase as backend, and the mobile layout of both pages.
