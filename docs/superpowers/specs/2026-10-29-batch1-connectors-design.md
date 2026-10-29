# Batch 1 Connectors (Vercel, Cloudflare, Neon) — Design

Date: 2026-10-29
Status: Approved design, pending spec review
Builds on: the provider adapter model in `src/lib/providers/types.ts` and the categorized catalog in `src/lib/providers/registry.ts`

## Goal

Let a user connect a Vercel, Cloudflare or Neon account to their workspace with an API
token, discover its projects and resources, and collect usage on the existing schedule,
so the three show up in Home, Usage, Limits & quotas and Alerts like Supabase does.
Build the shared groundwork once so the later batches (Railway, DigitalOcean, Firebase,
Twilio, SendGrid, AWS, Google Cloud, Azure) only add an adapter and its connect
instructions.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Shared groundwork plus Vercel, Cloudflare and Neon end to end. Other batches later |
| Auth | Pasted API tokens for all three. No OAuth in this batch |
| Connect UI | One generic page `/providers/connect/[provider]` and one server action, driven by per-adapter connect instructions. Supabase keeps its own page (OAuth) |
| Credentials | The existing `{ kind: "token", token }` shape. All three need one token |
| Vercel plans | Pro/Enterprise get billing-API usage and cost. Hobby gets projects and deployments; billing metrics show as not available on Hobby |
| Plan allowances | Suggested (user confirms) where a plan is detectable: Vercel, Neon. Cloudflare limits are user-configured |

## Non-goals

- OAuth for any of the three providers.
- Pricing rules for cost estimates. Vercel reports actual cost; Cloudflare and Neon
  pricing rules come later.
- Cloudflare KV, Pages, Durable Objects, Queues and plan detection (needs billing
  permissions).
- Neon consumption-history backfill (paid plans only) and Neon branch counts.
- Multi-field credentials. Needed by later batches (Twilio, AWS, Azure, Google Cloud),
  not by these three.

## 1. Shared groundwork

**Provider ids.** `ProviderId` gains `"vercel" | "neon"` (`"cloudflare"` already exists).
Migration `db/migrations/0002_batch1_providers.sql` drops and re-adds the
`provider_connections.provider` check constraint with `vercel` and `neon` added. Other
tables store `provider` as free text and need no change.

**Registry.** `ADAPTERS` registers the three adapters. Their catalog entries become
`available: true`. `getAdapter` and `PROVIDER_NAMES` keep working unchanged.

**Connect instructions.** A new optional field on `ProviderAdapter`:

```ts
interface TokenConnectInfo {
  tokenLabel: string;          // "Access token", "API token", "API key"
  placeholder?: string;        // e.g. "vercel_…" when a prefix is known
  createUrl: string;           // where the user creates the token
  steps: string[];             // short numbered instructions
  permissions?: string[];      // exact permission names to tick, shown as chips
  warning?: string;            // shown when the token is not read-only
}
```

Adapters that support token auth set `tokenConnect`. The Supabase adapter does not
need it (its page stays bespoke).

**Connect page** `src/app/(app)/providers/connect/[provider]/page.tsx`. Looks up the
adapter; 404s unless the adapter exists, is available in the catalog and has
`tokenConnect`. Renders the steps, permission chips, the warning (as a `Notice`
`tone="warn"`) and the token form. The static `connect/supabase` route keeps
precedence. Catalog cards already link to `/providers/connect/${id}`.

**Token form.** `TokenForm` gains optional `tokenLabel`, `tokenHint`, `placeholder` and
`defaultLabel` props; Supabase's current values become the defaults, so its page is
unchanged.

**Server action.** `connectToken(provider, state, form)` generalizes
`connectSupabaseToken`: same zod validation, rate limit, `validate()`, audit and
`createConnection`. `createConnection`'s `provider` type widens to `ProviderId`.
`connectSupabaseToken` becomes a thin wrapper so existing callers and tests keep working.

**Existing connection page** (`providers/[id]/page.tsx`). `replaceToken` is already
provider-agnostic. The page currently shows the replace-token form only for Supabase;
it also shows it for any adapter with `tokenConnect`, using that adapter's token label
and placeholder. The disconnect confirmation ("Also revoke the token in your Supabase
account settings") names the connection's provider instead of Supabase.

## 2. Vercel adapter (`src/lib/providers/vercel/adapter.ts`)

Base URL `https://api.vercel.com`, bearer token, `teamId` query parameter per team.

**Validate.** `GET /v2/user` for identity. Granted scopes: `["team-token"]` (Vercel
tokens have no scopes to report).

**Discover.**
- Accounts: `GET /v2/teams` (paginated). `accountType: "organization"`, `plan` from
  `billing.plan` (`hobby` | `pro` | `enterprise`), `dashboardUrl`
  `https://vercel.com/<slug>`.
- Resources: `GET /v10/projects?teamId=` (paginated). `resourceType: "project"`,
  `dashboardUrl` `https://vercel.com/<team-slug>/<project-name>`.

**Metrics.**

| Key | Name | Unit | Aggregation | Scope | Source | Plans |
|---|---|---|---|---|---|---|
| `vercel.deployments` | Deployments | count | incremental | resource | `GET /v6/deployments` counted per UTC day | all |
| `vercel.function_invocations` | Function invocations | count | incremental | resource | billing charges | Pro, Enterprise |
| `vercel.data_transfer` | Data transfer | bytes | incremental | resource | billing charges | Pro, Enterprise |
| `vercel.edge_requests` | Edge requests | count | incremental | resource | billing charges | Pro, Enterprise |
| `vercel.build_minutes` | Build minutes | count | incremental | resource | billing charges | Pro, Enterprise |

`vercel.deployments` derivation is `derived`; the billing metrics are `reported`.

**Billing charges.** `GET /v1/billing/charges?teamId=&from=&to=` returns FOCUS v1.3
JSONL (one JSON object per line, gzip). Parse line by line. Keep rows with
`ChargeCategory: "Usage"`. Map a row to a metric by `ServiceName` (and `ConsumedUnit`
to confirm the unit, converting GB to bytes). The mapping table lives in the adapter
and is verified against a live Pro response during implementation; unmapped service
names contribute to cost only. Rows are attributed to a project by
`Tags.ProjectId`; rows without one are dropped from per-project metrics but still count
toward cost. Each day's `BilledCost` summed per team becomes a `ReportedCost`.

**Hobby.** For a team whose plan is `hobby`, the adapter does not call the billing
endpoint and reports the four billing metrics as `unsupported` with detail "Vercel
reports usage through its billing API on Pro and Enterprise teams only." A 403 from the
billing endpoint on another plan reports them as `unavailable` with the error code,
without failing the connection.

**Capabilities.** accountDiscovery, resourceDiscovery: supported. usageMetrics,
actualCost, forecastingInputs: partial ("Pro and Enterprise teams only, except
deployments"). quotaRetrieval: unsupported. billingCycleMetadata: unsupported.
accountControls: unsupported.

**Plan allowances** (suggested, cite Vercel's limits/pricing pages with the date
verified): Hobby deployments per day and Pro included amounts for function invocations,
data transfer, edge requests and build minutes, where Vercel publishes a monthly
included amount. Daily limits are mentioned in the metric description, not enforced as
cycle quotas.

**Connect info.** Token label "Access token", create URL
`https://vercel.com/account/settings/tokens`, steps: create a token, scope it to the
team, set an expiry. Warning: "Vercel tokens can do more than read. Limit Gauge only
sends read requests and encrypts the token at rest. Scope it to one team and set an
expiry."

## 3. Cloudflare adapter (`src/lib/providers/cloudflare/adapter.ts`)

Base URL `https://api.cloudflare.com/client/v4`, bearer token.

**Validate.** `GET /user/tokens/verify` (status must be `active`), then `GET /accounts`
must return at least one account; otherwise `permission_denied` naming Account
Settings: Read.

**Discover.**
- Accounts: `GET /accounts` (paginated). `accountType: "account"`, `plan: null`,
  `dashboardUrl` `https://dash.cloudflare.com/<account_id>`.
- Resources per account:
  - Workers: `GET /accounts/{id}/workers/scripts` → `resourceType: "worker"`,
    external id `worker:<script name>`.
  - R2 buckets: `GET /accounts/{id}/r2/buckets` → `resourceType: "r2_bucket"`,
    external id `r2:<bucket name>`.
  - D1 databases: `GET /accounts/{id}/d1/database` → `resourceType: "d1_database"`,
    external id `d1:<uuid>`.
  A 403 on one resource type skips that type and records why in the account's
  metadata; it does not fail discovery.

**Metrics.** All from `POST /graphql`, one query per account per collection run,
filtered by `accountTag` and a date range, grouped by date and resource.

| Key | Name | Unit | Aggregation | Scope | Dataset / field |
|---|---|---|---|---|---|
| `cloudflare.workers_requests` | Workers requests | count | incremental | resource | `workersInvocationsAdaptive` `sum.requests` by `scriptName`, `date` |
| `cloudflare.workers_cpu_time` | Workers CPU time (ms) | count | incremental | resource | `workersInvocationsAdaptive` `sum.cpuTimeUs` / 1000 |
| `cloudflare.r2_class_a_ops` | R2 Class A operations | count | incremental | resource | `r2OperationsAdaptiveGroups` `sum.requests` by `bucketName`, `actionType` ∈ Class A |
| `cloudflare.r2_class_b_ops` | R2 Class B operations | count | incremental | resource | same, `actionType` ∈ Class B |
| `cloudflare.r2_storage` | R2 storage | bytes | gauge | resource | `r2StorageAdaptiveGroups` `max.payloadSize + max.metadataSize` |
| `cloudflare.d1_rows_read` | D1 rows read | count | incremental | resource | `d1AnalyticsAdaptiveGroups` `sum.rowsRead` by `databaseId` |
| `cloudflare.d1_rows_written` | D1 rows written | count | incremental | resource | `d1AnalyticsAdaptiveGroups` `sum.rowsWritten` |
| `cloudflare.d1_storage` | D1 storage | bytes | gauge | resource | `d1StorageAdaptiveGroups` `max.databaseSizeBytes` |

The R2 Class A / B action-type lists follow Cloudflare's R2 pricing page and live in
the adapter. Exact dataset field names are confirmed by GraphQL introspection against a
real account during implementation; the table is the intended mapping.

The date range starts at `target.since` and is capped at 30 days (the adaptive
datasets' query window on every plan).

**GraphQL errors.** The endpoint answers 200 with an `errors` array. Messages about
authorization or missing permission map to `permission_denied`; anything else maps to
`invalid_response`. A permission error on one dataset marks only that dataset's metrics
`unavailable`.

**Capabilities.** accountDiscovery, resourceDiscovery, usageMetrics, forecastingInputs:
supported. quotaRetrieval, actualCost, billingCycleMetadata, accountControls:
unsupported.

**Connect info.** Token label "API token", create URL
`https://dash.cloudflare.com/profile/api-tokens`, steps: Create Custom Token, add the
permissions, limit to the accounts to monitor. Permissions (all Account-level, Read):
Account Settings, Account Analytics, Workers Scripts, Workers R2 Storage, D1. No
warning: the token is read-only.

## 4. Neon adapter (`src/lib/providers/neon/adapter.ts`)

Base URL `https://console.neon.tech/api/v2`, bearer API key.

**Validate.** `GET /users/me`, then `GET /users/me/organizations`.

**Discover.**
- Accounts: organizations. `accountType: "organization"`, `plan` from the
  organization's subscription type, `dashboardUrl`
  `https://console.neon.tech/app/<org_id>/projects`.
- Resources: `GET /projects?org_id=` (paginated with `cursor`). `resourceType:
  "project"`, `region` from `region_id`, `dashboardUrl`
  `https://console.neon.tech/app/projects/<id>`.

**Metrics.** From each project's current consumption-period counters, which every plan
returns (`GET /projects/{id}` if the list response lacks them).

| Key | Name | Unit | Aggregation | Scope | Field |
|---|---|---|---|---|---|
| `neon.compute_hours` | Compute hours | count | cumulative | resource | `compute_time_seconds` / 3600 |
| `neon.storage` | Storage | bytes | gauge | resource | `synthetic_storage_size` |
| `neon.data_written` | Data written | bytes | cumulative | resource | `written_data_bytes` |
| `neon.data_transfer` | Data transfer | bytes | cumulative | resource | `data_transfer_bytes` |

Observations are bucketed to the UTC day of collection. `consumption_period_start` is
stored in the observation's dimensions so a period reset is visible; the engine already
never differences cumulative values across a cycle reset.

**Capabilities.** accountDiscovery, resourceDiscovery, usageMetrics, forecastingInputs:
supported. billingCycleMetadata: partial (per-project consumption period). quotaRetrieval,
actualCost, accountControls: unsupported.

**Plan allowances** (suggested, cite Neon's pricing page with the date verified): Free
plan compute hours, storage and data transfer per project.

**Connect info.** Token label "API key", create URL
`https://console.neon.tech/app/settings/api-keys`, steps: create a personal API key,
ideally from a member with the Viewer role. Warning: "Neon API keys are not read-only.
A personal key from a Viewer-role member can only read. Limit Gauge only sends read
requests and encrypts the key at rest."

## 5. Error handling

All three adapters use `requestJson` from `src/lib/providers/http.ts` (retries,
timeouts, status-to-`ProviderError` mapping). Connection-level failures (401, revoked
token, provider outage) throw; per-metric failures go into `outcomes`, never as zeros.
Vercel's JSONL endpoint needs a sibling helper that returns text instead of parsed JSON
and shares the same error mapping.

## 6. Testing

- One unit test file per adapter (`tests/vercel-adapter.test.ts`,
  `tests/cloudflare-adapter.test.ts`, `tests/neon-adapter.test.ts`) using a fake `fetch`
  with recorded-shape fixtures, in the style of `tests/supabase-adapter.test.ts`:
  validate, discover, collect, pagination, Hobby path, GraphQL error mapping, unit
  conversions, unmapped Vercel services.
- Registry test: the three are available and have `tokenConnect`.
- Action test for `connectToken` with an unknown or unavailable provider.
- Live check: connect a real account of each provider in the local app (the user pastes
  the token into the browser), sync, and confirm field names, the Vercel service-name
  mapping and the Cloudflare dataset fields. Fix the mappings from what the live
  responses show.
