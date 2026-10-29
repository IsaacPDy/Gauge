# Limit Gauge — unified cloud usage & cost monitoring

Limit Gauge connects to your cloud accounts with read-only access, discovers your projects, collects usage on a schedule, compares it against provider-reported or user-configured limits, forecasts the end of the billing cycle, and warns you (in-app and by email) before you hit a limit or an unexpected bill.

It implements checkpoints 1–6 of the PRD (`writing-block.md`): the full MVP definition of done, plus forecasting and cost estimates. Supabase (OAuth or token), Vercel, Cloudflare and Neon (API tokens) are the real integrations. A clearly labelled **Demo provider** (development only) generates sample data so you can explore the whole product without credentials.

> Limit Gauge monitors and forecasts. It never shuts down services, changes plans or caps spending, and every estimate is labelled as one.

## Quick start (local)

Prerequisites: Node 20.12+ and a free Neon account (https://neon.com). Set up Neon first (see [Neon setup](#neon-setup)), then:

```bash
npm install
```

```bash
npm run setup:env
```

`setup:env` creates `.env.local` and generates the secrets. Open it and fill in the values from the Neon console (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, and `NEON_BRANCH=dev`). Then:

```bash
npm run db:migrate
```

```bash
npm run dev
```

Then open http://localhost:3100. The app uses port 3100 so it does not collide with other apps on 3000.

1. Create an account. A private workspace is created automatically.
2. **Providers → Add demo connection** (or **Connect Supabase** with a personal access token or OAuth).
3. Choose the resources to monitor. Usage history appears within seconds.
4. Explore **Home**, **Usage**, **Limits & quotas** and **Alerts**. In development alert emails are printed to the server log (`EMAIL_TRANSPORT=console`).

`setup:env` copies the keys from `.env.example` and generates the credential encryption key, cron secret and auth cookie secret. It keeps existing values, so it is safe to re-run.

### Neon setup

1. In the Neon console create a project and a branch named `dev`.
2. On that branch open **Auth** and enable it.
3. Copy these values into `.env.local`:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | **Connect** with connection pooling **on** (the pooled string) |
| `DATABASE_URL_UNPOOLED` | **Connect** with connection pooling **off** (the direct string). Migrations and `db:reset` use it |
| `NEON_AUTH_BASE_URL` | **Auth → Configuration** (the Auth URL) |
| `NEON_BRANCH` | A label you choose. `db:reset` only runs when it is `dev` |

4. In **Auth** add `http://localhost:3100` as a trusted origin. Leave **Allow Localhost** on for development.
5. In development, Neon Auth sends verification and password-reset emails through Neon's shared sender. That sender is meant for development only.

Safari does not store the auth cookies over plain HTTP on localhost. Run `npm run dev -- --experimental-https` and open the https address it prints.

**"An unexpected response was received from the server" when you submit a form (HTTP 431).** Cookies on `localhost` are shared by every app and port, so a browser profile that has run many local apps (old Supabase `sb-*-auth-token` cookies are the usual culprits) can send more than Node's default 16 KB of request headers. Node then rejects the request before the app sees it. `npm run dev` raises the limit to 64 KB, but the cleaner fix is to delete the stale `localhost` cookies in DevTools (Application > Cookies), or to use a separate browser profile for local development.

### Changing the schema

1. Add a new `db/migrations/NNNN_name.sql` (never edit an applied migration).
2. Update `src/db/schema.ts` to match.
3. Run `npm run db:migrate`.

The schema parity test (`tests/db/schema-parity.test.ts`) fails when the Drizzle schema and the migrated database drift apart.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server on :3100. With `RUN_SCHEDULER_IN_PROCESS=true` it also runs collection and alert delivery every 60 s |
| `npm run worker` / `worker:once` | Standalone scheduler loop / single pass (for production-style setups) |
| `npm test` | Unit tests, plus database integration tests when `DATABASE_URL_TEST` is set (see [Tests](#tests)) |
| `npm run typecheck` | TypeScript check |
| `npm run db:migrate` | Apply `db/migrations/*.sql` to the branch in `DATABASE_URL_UNPOOLED` |
| `npm run db:reset -- --yes --host=<host>` | Wipe and re-create the app schema on the branch in `DATABASE_URL_UNPOOLED`. Refuses unless `NEON_BRANCH=dev`, `--yes` is given and `--host` equals that URL's host. On a mismatch it prints the actual host and the command to retype |

## Architecture

```
Provider APIs ──▶ Adapters (src/lib/providers) ──▶ Sync job (jobs/sync.ts)
                                                     │  idempotent upserts
                                                     ▼
                                     PostgreSQL (Neon, workspace-scoped repositories)
                                                     │
                     Recalculation (jobs/recalc.ts): quota evaluations, forecasts,
                     cost estimates, alert evaluation, dedupe/escalation, delivery queue
                                                     │
                       ┌─────────────────────────────┴────────────────────────┐
                       ▼                                                      ▼
          Dashboard (Next.js server components,                  Email deliveries (jobs/notify.ts)
          reads stored snapshots only)                           with retries and backoff
```

| Area | Where | Notes |
|---|---|---|
| Schema and access control | `db/migrations/`, `src/db/` | SQL-first migrations; a Drizzle schema for typed queries. Access control lives in `src/db/scope.ts`: every user-facing query goes through a repository in `src/db/repos/` that needs a `WorkspaceScope`. Repositories never touch `provider_credentials` or `oauth_states`. |
| Provider adapters | `src/lib/providers/` | Common interface with a declared capability model. Unsupported data is reported as `unsupported`, never invented or shown as zero. |
| Pure engine | `src/lib/engine/` | Billing cycles, usage aggregation (gauge / cumulative / incremental), forecasting, cost estimates, alert evaluation and connection health. Deterministic and unit-tested. |
| Jobs | `src/lib/jobs/` | Sync (discover → collect → persist), recalculation, notifications, scheduler. Connections are claimed with `FOR UPDATE SKIP LOCKED`, so workers can run in parallel. |
| UI | `src/app/(app)/` | Home, Applications, Providers, Usage explorer, Limits & quotas, Cost simulator, Alerts, Settings |

### Key behaviours (mapped to the PRD)

- **Idempotency.** Resources are keyed by provider ID, and samples by `(connection, metric, scope, bucket)`. Re-syncing overwrites instead of duplicating, and user choices (monitoring, application grouping, billing-cycle day) are never overwritten.
- **Quota sources.** *Provider-reported* limits come from APIs (for example, Supabase provisioned disk size and the Edge Function entitlement). *User-configured* limits always take precedence. Published plan allowances are only **suggested**: they cite their source, show the date they were verified, and apply only after you confirm them. Unknown limits stay unknown.
- **Billing scope.** Organization-wide quotas (MAU, storage) sum the monitored projects in the organization and flag partial coverage. They are never attributed to a single application.
- **Forecasting.** `projected = current + avg daily usage × remaining days`, using up to 7 valid daily observations. It needs at least 3; stale data produces no forecast. Cumulative counters are never differenced across a cycle reset. Gauges use linear growth.
- **Alerts.** Thresholds default to 50/75/90/100% and can be customized per workspace or per quota. Each threshold fires at most once per billing cycle, and a higher threshold escalates (supersedes) a lower one. Alerts can be acknowledged or muted (1 day, 7 days, or until the cycle resets). Alerts resolve automatically when the condition clears. Each alert's deliveries are unique per channel, so retries can't duplicate notifications.
- **Connection health.** Provider errors are normalized: auth failures pause collection until you reauthorize, missing permissions retry daily, and transient errors (429/5xx/network) back off exponentially. Data older than your freshness threshold raises a *stale* alert. Failures never erase data or read as zero usage.
- **Costs.** Provider-reported spend is kept separate from calculated estimates. Each estimate carries its pricing rule and version, and currencies are never mixed.

### Cost simulator

`/simulator` estimates monthly costs for a workload you describe, without reading any connected account. Pick a preset, turn on the services in your stack (Supabase, Firebase, Upstash Redis, Vercel, Cloudflare), and set where the API runs and where files live. Then adjust users, traffic, database queries, data sizes and growth.

The **Plan limits** card shows, for each service you turn on, how close the simulated month is to every plan allowance, the month you pass it, and what you pay beyond it. **Compare plans** (`/simulator/compare`) uses the same inputs and URL to lay out every plan side by side by role (backend: Supabase or Firebase; API hosting: Vercel or Cloudflare; cache: Upstash), marking the cheapest plan that fits. Firebase Spark and Blaze are priced: Auth MAU, Firestore reads, writes, storage and egress, Cloud Functions invocations and Cloud Storage.

- **Engine.** `src/lib/engine/simulate/` is pure and deterministic: inputs → resolved stack → monthly usage → priced line items → a 12-month projection with events.
- **Cache vs. compute.** Every month is priced both with and without a cache in front of the database. The verdict says whether a cache saves money (in compute size or Supabase egress), or whether a larger compute size is cheaper. Supabase doesn't publish query throughput, so the planning QPS per compute size is an editable assumption.
- **Prices.** Price sheets in `catalog.ts` record their source and verification date. A sheet more than 90 days old is flagged as possibly outdated. Free-plan limits show as restrictions, never as charges.
- **Sharing.** Inputs live in the URL (only values that differ from the preset), so a scenario can be bookmarked or shared.

### Supabase integration

Verified on 2026-10-09 against the Management API OpenAPI spec and the "Manage your usage" docs.

| Metric | Source | Notes |
|---|---|---|
| Database size | `POST /v1/projects/{ref}/database/query/read-only` (`pg_database_size`) | Free plan limit (500 MB, read-only mode) is a plan suggestion |
| Disk usage | `GET /v1/projects/{ref}/config/disk/util` | Provisioned size becomes a provider-reported limit |
| Storage size | read-only SQL over `storage.objects` | Derived; Supabase bills the cycle average |
| Monthly active users | read-only SQL over `auth.users.last_sign_in_at` | **Estimate**; undercounts token refreshes |
| API requests | `GET …/analytics/endpoints/usage.api-counts` | Daily totals with REST/Auth/Storage/Realtime breakdown |
| Edge Functions deployed | `GET /v1/projects/{ref}/functions` + org entitlements | Entitlement is a provider-reported limit |
| Egress, function invocations | — | Shown as **unsupported** (not exposed reliably by the API) |

**OAuth (recommended).** Create an OAuth app in your Supabase organization with redirect URI `${APP_URL}/api/integrations/supabase/oauth/callback`, then set `SUPABASE_OAUTH_CLIENT_ID` and `SUPABASE_OAUTH_CLIENT_SECRET`. The flow uses PKCE and a one-time, expiring, encrypted state. It requests only read scopes: `organizations:read projects:read analytics:read database:read edge_functions:read`.

**Personal access tokens** work without an OAuth app. Supabase does not scope them, so the UI warns about this and recommends revoking the token in Supabase after disconnecting.

## Deploying

1. **Database and auth.** In Neon, use the `main` branch for production. Apply the schema by hand, before deploying code that needs it: `DATABASE_URL_UNPOOLED=<main direct url> npm run db:migrate`. In the branch's Auth settings add your production domain as a trusted origin, set up a custom email provider, and enable email verification (see Neon's auth production checklist).
2. **App.** Deploy to Vercel or any Node host, with these env vars: `DATABASE_URL` (the **pooled** URL), `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `APP_URL`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, the email settings (`EMAIL_TRANSPORT=resend` + `RESEND_API_KEY`, or SMTP), and optionally the Supabase OAuth credentials. Set `ENABLE_DEMO_PROVIDER=false` and `RUN_SCHEDULER_IN_PROCESS=false`.
   - `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` (32+ characters) are needed at **build** time too: the Auth SDK validates them when it is imported.
   - `APP_URL` is mandatory in production; the app throws without it.
   - Do not enable Neon's Data API. The tables have no row-level security; authorization lives in the app's workspace scopes (`src/db/scope.ts`).
   - `SUPABASE_MANAGEMENT_API_URL` is an optional override for the Supabase adapter's API base URL (default `https://api.supabase.com`).
3. **Scheduling.** `vercel.json` calls `/api/cron/tick` once a day at 06:00 UTC, and Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. That is the most often Vercel's Hobby plan allows (a more frequent schedule makes the deployment fail), so each connection is collected about once a day and alerts are evaluated once a day. On Vercel Pro, change the schedule to `*/15 * * * *` for near-real-time monitoring. Elsewhere, run `npm run worker` as a separate process, or have any scheduler call the endpoint with the bearer token. Each connection's collection interval defaults to 6 hours.

**Session caching.** The Auth SDK trusts its session cache cookie for about 5 minutes. After you delete an account or revoke a session, another device may keep working for up to that long.

## Tests

`npm test` runs the unit tests and, when `DATABASE_URL_TEST` is set, the database integration tests:

- **Engine**: cycles, aggregation, forecasting (including reset boundaries and reproducibility), costs, alert dedupe keys, health, units, and failure backoff.
- **Supabase adapter**: mocked API covering parsing, per-metric failures, auth aborts, paused projects, retries and rate limits.
- **Cost simulator**: price catalog structure, URL encoding and presets, stack routing (including the Supabase/Firebase backend), the workload model, pricing, graduated tiers and unit conversions, compute choice and the cache verdict, events, plan limit bars, the plan comparison, and every preset against the real catalog.
- **Database** (needs `DATABASE_URL_TEST`): schema parity with the migrations, workspace bootstrap, and workspace isolation of the repositories. They run on the Neon branch in `DATABASE_URL_TEST`, which may be the same as the dev branch; they create and delete their own random test users and leave other data alone.

While the tests run, do not run `npm run worker` or set `RUN_SCHEDULER_IN_PROCESS=true`: the scheduler would process the test data. If the dev branch holds data you care about, point `DATABASE_URL_TEST` at a separate Neon branch.

## Not yet built (later checkpoints)

- Cloudflare, Firebase/GCP and AWS adapters (Checkpoint 7+). The catalog shows them as "coming soon", and the adapter interface is ready for them.
- Checkpoint 8 launch items: data-retention jobs, encryption-key rotation tooling, CSP headers, privacy policy and terms, production monitoring, and end-to-end browser tests.
- Team workspaces, Slack/Discord/webhook channels, anomaly detection and CSV export (Phase 2+).
