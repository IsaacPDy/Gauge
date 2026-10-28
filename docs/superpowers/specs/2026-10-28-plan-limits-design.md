# Plan Limits and Plan Comparison — Design

Date: 2026-10-28
Status: Approved design, pending spec review
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
  /** used ÷ included × 100. Not capped; the UI caps the fill at 100 %. */
  pct: number;
  state: LimitState;
  /** USD for usage past the included amount (the line item's cost). 0 when blocked. */
  overageCost: number;
  /** First month in the projection where used > included, or null within the horizon. */
  hitsLimitMonth: number | null;
  note?: string;
}

interface PayFromFirstUnit { service: Service; key: string; label: string; unit: string; used: number; cost: number }

function limitBars(result: SimulationResult, month: number): { bars: LimitBar[]; payFromFirst: PayFromFirstUnit[] };
```

Rules:
- One bar per priced line item with `included > 0`. Fixed items (`base`, `compute`,
  `credit`) never get a bar.
- Items with `included = 0` and a unit price (Upstash commands, Vercel Pro
  invocations, Vercel Pro active CPU) go in `payFromFirst` instead, with their usage
  and cost.
- Items with `included = 0` and no unit price (Firebase Spark Cloud Functions and
  Cloud Storage) get a bar only when `used > 0`, in state `blocked` with `pct = 100`
  and the label "Not on this plan". When unused they are omitted.
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

## 2. Simulator: "Plan limits" card

On `/simulator`, placed after the cache verdict and before the projection chart.

- One section per enabled service, headed by the plan name (e.g. "Supabase Pro").
- Each bar shows: label, `used / included unit` (via `formatAmount`), the percentage,
  and a badge:
  - `ok`: "Reaches limit in month N" when `hitsLimitMonth` is set, else no badge.
  - `near`: warn tone, "N % used", plus "limit in month N" when it is later.
  - `paying`: accent tone, "Over by X · $Y/mo".
  - `blocked`: crit tone, "Needs a paid plan" (or "Not on this plan" for items with
    nothing included).
- Fill colour follows the state (ok, warn, accent, crit tokens already in `ui.tsx`).
  The bar is an accessible `role="progressbar"` with `aria-valuenow` capped at 100
  and an `aria-valuetext` that states the real usage.
- Under the bars, `payFromFirst` items are listed as "Billed from the first unit:
  Commands 2.1M · $4.20".
- The card follows the selected month. The month select moves from the Line items
  card header into shared state in `simulator-view.tsx`, and both cards render it.
- A "Compare plans" link in the card header opens `/simulator/compare` with the
  current query string.

New component: `src/app/(app)/simulator/plan-limits.tsx` (`PlanLimits`,
`LimitBarRow`). `LimitBarRow` is shared with the comparison page.

## 3. Comparison page (`/simulator/compare`)

### Layout

Inputs on the left, plans on the right (stacked on mobile), the same frame as the
simulator. The form shows the workload groups and the routing selects (API host,
file storage); the per-service on/off and plan selects are hidden, because every
plan is shown. A month select (1–12, default 1) sits above the plans. A "Back to
simulator" link keeps the query string.

Three role sections:

| Role | Plans |
|---|---|
| Backend: database, auth, files, functions, realtime | Supabase Free, Pro, Team · Firebase Spark, Blaze |
| API hosting | Vercel Hobby, Pro · Cloudflare Workers Free, Paid |
| Cache | Upstash Redis pay as you go |

Each plan card shows: plan name, the service's monthly total for that plan in the
selected month, the limit bars (`LimitBarRow`), the `payFromFirst` list, and one badge:
- "Over limit" (crit) when any bar is `blocked`.
- "Cheapest that fits" (ok) on the lowest total in its role with no `blocked` bar.
  Ties go to the first plan in table order.
- "Fits" otherwise.

The Cache section shows the reason instead of a card when the cache cannot be priced
(no Supabase backend, or `host = direct`), using the existing reason strings.

### How each plan is priced (`src/lib/engine/simulate/compare.ts`)

```ts
interface PlanVariant {
  role: "backend" | "hosting" | "cache";
  service: Service;
  plan: string;
  label: string;
  total: number;                 // that service's totalsByService for the month
  bars: LimitBar[];
  payFromFirst: PayFromFirstUnit[];
  blocked: boolean;
  blockedReason: string | null;  // cache only
}
function comparePlans(inputs: SimInputs, month: number, opts?): { variants: PlanVariant[]; notices: string[] };
```

For each plan, the user's inputs are copied and the plan is put in its role, then
`simulate()` runs and only that service's line items are read:
- Backend variant: set that service to the plan and `db` to that service. The other
  backend keeps the user's setting.
- Hosting variant: set that service to the plan and `host` to that service.
- Cache variant: set `cache = upstash_payg`. If the resolved stack blocks the cache,
  return `blocked: true` with the stack's `cacheBlockedReason`.
- Everything else (workload, compute choice, file storage, seats) comes from the
  user's inputs, so the numbers match the simulator for the plans the user picked.

There are 10 variants, each a 12-month `simulate()` call: cheap enough to run in the
browser on every change (memoised on the encoded query).

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
  it is on, with a notice. With neither on, there is no backend: database, auth,
  functions and realtime are not priced (as today with Supabase off).
- The backend chosen by `db` receives MAU/auth, database queries and size, Edge or
  Cloud Functions, realtime, and the DB response egress.
- The other backend, when on, is priced only if file storage routes to it (its base
  fee, plus compute for Supabase, plus its file items). Otherwise it is not priced and
  a notice says "Supabase is on, but Firebase is the database and nothing else uses
  it, so it isn't priced." (and the mirror message).
- `fs = firebase` requires Firebase. Otherwise it falls back to Supabase if Supabase is
  on, else file storage isn't priced, with a notice (like `fs = r2`).
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
| `fs_storage_gb` | `dbSizeGB` | 0 |
| `fs_egress_gb` | `backendEgressGB` | 0 |
| `fn_invocations` | `fnInvocations` | 0 |
| `storage_gb` | `storageGB` if `fs = firebase` | same |
| `storage_egress_gb` | `fileEgressGB` if `fs = firebase` | same |

Firestore realtime listeners are billed as one document read per update delivered,
so realtime messages count as reads. Deletes are not modelled; writes include them.
These are stated assumptions in the line item notes.

### Price sheets (`catalog.ts`)

Free quotas below are from https://firebase.google.com/pricing, read on 2026-10-28.
Daily quotas are shown per month (× 30), as Cloudflare's are. Blaze unit prices
beyond the free quota are on Google Cloud pricing pages and are filled in during
implementation from those pages, with `sourceUrl` and `verifiedAt` recorded per the
existing rule (prices are never taken from memory). GiB quotas are converted to GB
(1 GiB = 1.073741824 GB).

| Key | Label | Spark included | Spark price | Blaze included | Blaze price source |
|---|---|---|---|---|---|
| `auth_mau` | Auth monthly active users | 50 000 | restricted | 50 000 | Identity Platform pricing (graduated tiers) |
| `fs_reads` | Firestore document reads | 1 500 000 (50K/day) | restricted | 1 500 000 | Firestore pricing, per 100 000 |
| `fs_writes` | Firestore document writes | 600 000 (20K/day) | restricted | 600 000 | Firestore pricing, per 100 000 |
| `fs_storage_gb` | Firestore stored data | 1 GiB | restricted | 1 GiB | Firestore pricing, per GiB-month |
| `fs_egress_gb` | Firestore network egress | 10 GiB | restricted | 10 GiB | Cloud internet egress, Premium Tier (graduated tiers) |
| `fn_invocations` | Cloud Functions invocations | 0 (not on Spark) | restricted | 2 000 000 | $0.40 per million (Firebase page) |
| `storage_gb` | Cloud Storage | 0 (not on Spark) | restricted | 5 GB | Cloud Storage pricing, Standard, us-central1 |
| `storage_egress_gb` | Cloud Storage downloads | 0 (not on Spark) | restricted | 100 GB | Cloud Storage egress pricing |

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

The existing events work unchanged for Firebase line items (`plan_limit` on Spark,
`overage_start` on Blaze).

## Edge cases

- `included > 0` and `used = 0`: a bar at 0 %, state `ok`, no badge.
- `used` exactly equals `included`: `pct = 100`, state `near`, not `paying`.
- Firebase Spark with `functionPct > 0`: a `blocked` "Not on this plan" bar for
  Cloud Functions, and a `plan_limit` event.
- Both backends off: the Backend section on the comparison page still shows all five
  plans, because each variant turns its own service on.
- A comparison variant that triggers routing notices (e.g. `fs = r2` with Cloudflare
  off) doesn't repeat them per card: notices are de-duplicated and shown once.

## Testing

`tests/simulate/`:
- `limits.test.ts`: each state, the 75 % boundary, 100 % exactly, `hitsLimitMonth` in
  month 1 / a later month / never, fixed items excluded, `payFromFirst`, Spark
  "not on this plan" bars only when used.
- `compare.test.ts`: every role's variants, a variant reads only its service's items,
  cheapest-that-fits with a tie and with a blocked cheaper plan, cache blocked under
  `host = direct` and under a Firebase backend, notices de-duplicated.
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
