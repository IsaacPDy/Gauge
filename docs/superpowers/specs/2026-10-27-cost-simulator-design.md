# Cost Simulator — Design

Date: 2026-10-27
Status: Approved design, pending spec review

## Goal

Let a developer estimate what their cloud stack will cost for a given workload,
without connecting a live account. They enter workload variables (MAU, traffic
shape, database hits, data sizes, growth) and pick a stack. The simulator shows
monthly cost per service, a 12-month projection, and whether and when a cache
pays off compared with upgrading database compute.

The simulator does not read collected usage. It is separate from the monitoring
side of CloudWatch and works before an app has launched.

## Decisions

| Topic | Decision |
|---|---|
| Services | Supabase, a cache (Upstash Redis), Vercel and Cloudflare (Workers, KV, R2). Mix and match: each can be toggled on or off |
| Starting numbers | Presets only ("Side project", "Small SaaS", "Consumer app"). No seeding from live data |
| Output | Monthly cost breakdown plus a 12-month projection driven by a growth rate, with events and a cache verdict |
| Persistence | Inputs are encoded in the page URL. No database changes |
| Where it runs | Pure TypeScript engine, computed in the browser. No server actions |
| Currency | USD only. Every figure is labelled an estimate |

## Non-goals

- Reading live usage or provider-reported costs.
- Saving named scenarios to the database, or comparing scenarios side by side.
- Currencies other than USD, taxes, or committed-use discounts.
- Modelling every product of each provider. Only the line items listed below are priced.

## Architecture

```
src/lib/engine/simulate/
  inputs.ts     zod schema, presets, defaults, URL encode/decode
  workload.ts   inputs → derived monthly usage (pure)
  catalog.ts    versioned price sheets per service and plan, plus Supabase compute sizes
  price.ts      usage + stack → line items per service (pure)
  project.ts    12-month loop: growth, per-month costs, events, cache verdict (pure)
  index.ts      simulate(inputs) → SimulationResult
src/app/(app)/simulator/
  page.tsx               server component shell (reads searchParams, renders client view)
  simulator-view.tsx     client component: owns state, syncs it to the URL
  simulator-form.tsx     inputs
  simulator-results.tsx  KPI tiles, verdict, chart, timeline, line items, provenance
src/components/nav.tsx   new "Simulator" item (Calculator icon)
tests/simulate.test.ts
```

Each engine file is pure and deterministic: same inputs, same output. Only
`simulator-view.tsx` touches the router. The engine reuses `overageCost()` from
`src/lib/engine/cost.ts` where the billing model fits (an included quantity, then a
per-unit or per-package price).

## Inputs

All inputs have a preset default. The URL stores only the values that differ from
the selected preset. Short URL keys are shown in brackets.

### Stack

| Input | Values |
|---|---|
| Preset [`p`] | `side_project`, `small_saas`, `consumer_app` |
| Supabase [`sb`] | `off`, `free`, `pro`, `team` |
| Supabase compute [`cmp`] | `auto` (smallest size that fits) or a fixed size key |
| Cache [`ca`] | `off`, `upstash_payg` |
| Vercel [`vc`] | `off`, `hobby`, `pro` |
| Vercel seats [`seats`] | integer ≥ 1 (Pro only) |
| Cloudflare [`cf`] | `off`, `free`, `paid` |
| API host [`host`] | `vercel`, `cloudflare`, `direct` (client calls Supabase directly) |
| File storage [`fs`] | `supabase`, `r2` |

Routing rules keep the mix-and-match combinations coherent:
- `host` may only name an enabled service. If it names a disabled one, the first
  enabled option in the order vercel → cloudflare → direct is used, with a notice.
- A cache requires a server-side host (`vercel` or `cloudflare`). With
  `host = direct`, the cache line is not priced and the verdict says why.
- `fs = r2` requires Cloudflare to be enabled. Otherwise it falls back to `supabase`.
- With Supabase off, database, MAU and Supabase line items are not priced, and the
  cache verdict is not shown.

### Workload

| Input [key] | Unit | Range | Meaning |
|---|---|---|---|
| MAU [`mau`] | users | 0 – 100 000 000 | Monthly active users in month 1 |
| DAU ratio [`dau`] | % | 1 – 100 | Share of MAU active on a typical day |
| Sessions per day [`spd`] | count | 0.1 – 50 | Sessions per active user per day |
| Requests per session [`rps`] | count | 1 – 1 000 | API requests per session |
| DB queries per request [`qpr`] | count | 0 – 50 | Database queries per API request |
| DB queries override [`dbq`] | queries/month | optional | Skips the derived chain for DB queries |
| Read share [`rd`] | % | 0 – 100 | Share of queries that are reads |
| Cache hit rate [`hit`] | % | 0 – 99 | Share of reads served from cache |
| Peak-to-average [`pk`] | × | 1 – 50 | Peak traffic relative to the monthly average |
| Avg response size [`kb`] | KB | 0.1 – 10 000 | Per API request |
| DB data per user [`dbkb`] | KB | 0 – 100 000 | Database bytes each user adds (cumulative) |
| Files per user [`fmb`] | MB | 0 – 100 000 | Stored file bytes each user adds (cumulative) |
| File downloads per user [`fdl`] | MB/month | 0 – 100 000 | File egress per MAU per month |
| Function share [`fn`] | % | 0 – 100 | Share of requests that invoke an Edge Function |
| Realtime share [`rt`] | % | 0 – 100 | Share of DAU using Realtime |
| Realtime messages per user [`rtm`] | count/day | 0 – 100 000 | Per realtime user |
| Function CPU time [`cpu`] | ms | 1 – 30 000 | Average active CPU per server request (Vercel, Workers) |
| Monthly growth [`g`] | % | −50 – 200 | Compounding MAU growth per month |

### Assumptions (collapsed by default)

| Input [key] | Default | Meaning |
|---|---|---|
| Headroom [`hr`] | 70 % | Highest share of a compute size's planning QPS you are willing to use |
| Avg query time [`qms`] | 5 ms | Used to estimate the concurrent connections needed |
| Planning QPS per compute size | per size, in `catalog.ts` | Editable. Supabase does not publish QPS capacity |
| Cache value size [`cvk`] | 2 KB | Used to size cache storage |
| Cached keys share [`ck`] | 10 % | Share of DB data that is held in the cache |
| Average file size [`fsz`] | 0.5 MB | Turns file bytes into R2 operation counts |

Planning-QPS overrides are encoded as `qps.<size>=<n>`.

### Presets

Presets set every workload and stack input. They must be written down in
`inputs.ts` with a one-line description each. Starting values:

| | Side project | Small SaaS | Consumer app |
|---|---|---|---|
| MAU | 500 | 10 000 | 250 000 |
| DAU ratio | 20 % | 25 % | 15 % |
| Sessions/day | 1 | 2 | 3 |
| Requests/session | 20 | 40 | 30 |
| Queries/request | 2 | 3 | 2 |
| Read share | 85 % | 80 % | 90 % |
| Cache hit rate | 80 % | 80 % | 85 % |
| Peak-to-average | 3 | 4 | 6 |
| Avg response | 5 KB | 10 KB | 8 KB |
| DB data/user | 20 KB | 200 KB | 50 KB |
| Files/user | 1 MB | 20 MB | 5 MB |
| File downloads/user | 2 MB | 30 MB | 20 MB |
| Function share | 0 % | 5 % | 10 % |
| Realtime share | 0 % | 10 % | 20 % |
| Realtime msgs/user/day | 0 | 50 | 100 |
| CPU/request | 10 ms | 20 ms | 15 ms |
| Growth | 10 % | 8 % | 5 % |
| Stack | Supabase Free, Vercel Hobby | Supabase Pro, Vercel Pro (1 seat), cache off | Supabase Pro, Vercel Pro (2 seats), cache on |
| Routing | API on Vercel, files on Supabase, compute auto | same | same |
| Cloudflare | off | off | off |

## Workload model (`workload.ts`)

For month *m* (1-based), with `MAU_m = MAU × (1 + g)^(m−1)`:

```
DAU              = MAU_m × dau
requests         = DAU × spd × rps × 30
db_queries       = dbq_override × (1 + g)^(m−1)   if set
                 = requests × qpr                  otherwise
reads            = db_queries × rd
writes           = db_queries − reads
cache_hits       = reads × hit        if the cache is priced, else 0
db_hits          = db_queries − cache_hits
avg_db_qps       = db_hits / (30 × 86 400)
peak_db_qps      = avg_db_qps × pk
peak_connections = peak_db_qps × qms / 1000      (Little's law)
api_egress_GB    = requests × kb / 1e6
db_size_GB       = Σ new users so far × dbkb / 1e6
storage_GB       = Σ new users so far × fmb / 1e3
file_egress_GB   = MAU_m × fdl / 1e3
fn_invocations   = requests × fn
rt_peak_conns    = DAU × rt × pk / 24     (realtime users spread over the day, scaled by peak)
rt_messages      = DAU × rt × rtm × 30
server_requests  = requests                        if host ≠ direct, else 0
cpu_ms           = server_requests × cpu
```

"New users so far" counts month 1's MAU plus each later month's positive growth.
Negative growth never shrinks stored data.

Where egress is billed:
- API response egress goes to the API host: Vercel or Cloudflare when they host the
  API. With `host = direct`, it is Supabase egress.
- Supabase egress (when the API runs on a server host) = the bytes of DB responses
  that are not served from the cache. That is `api_egress_GB × (db_hits / db_queries)`,
  or 0 when there are no queries. This is a stated assumption: DB responses are
  about the same size as API responses.
- File egress goes to the file store: Supabase Storage or R2.

## Price catalog (`catalog.ts`)

Each service plan is a `PriceSheet`:

```ts
interface PriceSheet {
  service: "supabase" | "upstash" | "vercel" | "cloudflare";
  plan: string;
  version: string;      // e.g. "2026-10"
  verifiedAt: string;   // YYYY-MM-DD
  sourceUrl: string;
  baseFee: number;      // per month (per seat where `perSeat`)
  perSeat?: boolean;
  items: PriceItem[];
}
interface PriceItem {
  key: string;          // e.g. "mau", "egress_gb"
  label: string;
  unit: string;         // display unit, e.g. "GB", "M requests"
  included: number;
  /** null: going over is a restriction on this plan, not a charge. */
  unitPrice: number | null;
  unitSize: number;
  billingMode: "per_unit" | "package";
}
```

Supabase compute sizes are a separate list: `{ key, label, monthlyPrice, cpu, ramGB,
maxDirectConnections, maxPoolerConnections, planningQps }`, plus the monthly
compute credit that paid plans include. `planningQps` is labelled an assumption in
the UI.

Line items priced per service:

| Service | Line items |
|---|---|
| Supabase | Plan base fee, compute size (minus credits), MAU, database disk, file storage, egress, Edge Function invocations, Realtime peak connections, Realtime messages |
| Upstash Redis | Commands, storage |
| Vercel | Plan base fee (per seat), function invocations, active CPU, data transfer |
| Cloudflare | Plan base fee, Workers requests, Workers CPU time, R2 storage, R2 Class A operations (writes) and Class B operations (reads) |

Cache commands = `reads + (reads − cache_hits) + writes`, i.e. lookups, fills on a
miss, and invalidations. Cache storage = `db_size_GB × ck`. Cache value size
(`cvk`) is used only to show an estimated key count.

R2 operations use the average file size (`fsz`): Class A = storage added that month
÷ `fsz`, and Class B = file egress ÷ `fsz`. R2 egress is free.

**Prices are not taken from memory.** During implementation, every number in
`catalog.ts` is checked against the provider's official pricing page, and its
`sourceUrl` and `verifiedAt` are recorded. This follows the PRD rule and the
existing `PricingRule` convention.

## Pricing (`price.ts`)

`priceMonth(usage, stack, catalog) → LineItem[]`

```ts
interface LineItem {
  service: string;
  key: string;
  label: string;
  usage: number;
  included: number;
  billable: number;
  cost: number;           // USD, rounded to cents
  restricted: boolean;    // usage > included on an item with unitPrice null
  note?: string;
}
```

- Every item has a single rate above its included quantity and reuses `overageCost()`.
  Graduated (volume) tiers are deferred: no priced item uses them today. If a verified
  price turns out to be tiered, add tier support then rather than flattening the price.
- Items with `unitPrice: null` never cost money. When usage passes the included
  amount, `restricted` is set. This is how Free and Hobby plans are modelled.
- Disabled services produce no line items.

## Compute and cache decision (`project.ts`)

For each month, both variants are evaluated, whether or not the cache is enabled:

```
fits(size, qps)  = qps ≤ size.planningQps × hr
                   and peak_connections ≤ size.maxPoolerConnections

tier_no_cache    = smallest size that fits peak_db_qps with hit = 0
tier_with_cache  = smallest size that fits peak_db_qps with the cache hit rate

cost_no_cache    = compute(tier_no_cache) − credits + Supabase egress cost (hit = 0)
cost_with_cache  = compute(tier_with_cache) − credits + Supabase egress cost (with hits)
                   + cache cost (commands + storage)
```

The comparison includes Supabase egress because cached reads cut it, so a cache
can pay off through egress alone, even at the same compute size.

When `cmp` is fixed rather than `auto`, that size is priced, and a month where it
does not fit raises a "compute saturated" event. On Supabase Free, compute is fixed
to the size the Free plan includes, and `cmp` is ignored.

Verdict (shown for month 1, with the month it changes):

| Verdict | Condition |
|---|---|
| Add a cache | `cost_with_cache < cost_no_cache`. Shows the monthly saving, and the tier avoided if there is one |
| No cache needed | The cache does not win, and `tier_no_cache` is the smallest size |
| Upgrade compute | The cache does not win, and `tier_no_cache` is larger than the smallest size |
| No tier fits | The largest size doesn't fit without a cache. Says whether the cache fixes it |
| Not applicable | Supabase off, or `host = direct` |

The verdict also gives the first month in which it becomes "Add a cache", if that
happens within 12 months.

## Projection and events (`project.ts`)

`simulate(inputs) → SimulationResult`:

```ts
interface SimulationResult {
  months: { month: number; mau: number; usage: Usage; items: LineItem[];
            totalsByService: Record<string, number>; total: number;
            restricted: boolean; computeSize: string | null }[];
  verdict: CacheVerdict;
  events: { month: number; kind: EventKind; service: string; message: string }[];
  notices: string[];          // routing fallbacks, ignored URL params
  provenance: { service: string; plan: string; version: string;
                verifiedAt: string; sourceUrl: string; stale: boolean }[];
}
```

The projection covers 12 months. Each event fires once, in the first month it
becomes true:
- `plan_limit`: a restricted item, e.g. "MAU passes the Free limit (50 000). Pro is required".
- `overage_start`: an item first goes above its included quantity on a paid plan.
- `compute_upgrade`: auto compute moves to a larger size.
- `compute_saturated`: a fixed size no longer fits.
- `cache_pays_off`: the verdict flips to "Add a cache".

A price sheet is `stale` when `verifiedAt` is more than 90 days before today.

## UI (`/simulator`)

On desktop, inputs sit on the left and results on the right. On mobile they stack.
Existing `ui.tsx`, `form-controls.tsx` and `charts.tsx` components are used where
they fit.

Inputs:
1. Preset select. Changing it resets every input to that preset, after a confirm if
   anything was edited.
2. Stack: a toggle and plan select per service, plus API host and file storage selects.
3. Groups: Users & traffic, Database, Data & bandwidth, Growth, Assumptions (collapsed).
4. "Reset to preset" link.

Results:
1. KPI tiles: month 1 total, month 12 total, cost per MAU (month 1), and peak DB QPS (month 1).
2. Cache verdict card.
3. 12-month stacked bar chart of cost by service. Restricted months are marked
   (pattern fill plus a legend note).
4. Events timeline.
5. Line-item table for a selected month (month select, default 1), grouped by service.
6. Provenance: plan, version, verified date and source link per enabled service,
   with a "may be outdated" badge when stale.
7. A permanent note: "Estimates from published prices and your assumptions. Not a bill."

## URL state

- `decode(searchParams)` → `{ inputs, notices }`. It starts from the preset (`p`,
  default `small_saas`), applies every known key that parses, and clamps values to
  their range. Unknown keys and values that fail to parse are ignored, and each adds
  a notice.
- `encode(inputs)` writes `p` plus only the keys that differ from that preset.
- `encode(decode(x))` is stable, and `decode(encode(inputs))` returns the same inputs.
- The view updates the URL with `router.replace(…, { scroll: false })`, debounced
  by 300 ms.

## Edge cases

- MAU 0, or every traffic input 0: all usage is 0, only base fees are charged,
  and the verdict is "No cache needed".
- `db_queries = 0`: the egress share division returns 0, never NaN.
- Negative growth: MAU shrinks, and stored data stays at its peak.
- No service enabled: the results area shows an empty state asking you to pick one.
- Very large numbers are formatted with `src/lib/units.ts`.

## Testing (`tests/simulate.test.ts`)

- The workload formulas for one fixed input set, including the DB queries override
  and negative growth.
- Pricing: single-rate overage, graduated tiers, package billing, base fee per
  seat, and a restricted item on a Free plan.
- Compute and cache: each verdict, "no tier fits", a fixed compute size saturating,
  `host = direct`, a cache that wins on egress alone, and Supabase Free ignoring `cmp`.
- Events fire once, in the right month.
- Routing fallbacks: `host` names a disabled service, `fs = r2` without Cloudflare,
  and a cache with `host = direct`.
- URL: round trip, values clamped, unknown and invalid keys ignored with notices.
- Every preset produces finite, non-negative totals.

Then a browser check of `/simulator` on port 3100: change inputs, confirm the URL
updates and survives a reload, and check the mobile layout.
