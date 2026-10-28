# Neon Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local Supabase (Docker) with a Neon database and Neon Auth, and replace the supabase-js query layer with Drizzle, with no change to what the app does.

**Architecture:** SQL-first migrations in `db/migrations/` are applied by a small runner; a hand-written Drizzle schema (snake_case property names, ISO-string timestamps, number numerics) keeps every row shaped exactly like the PostgREST rows the engine, views and pages already consume. User-facing code reads and writes only through repository functions that take a `WorkspaceScope` (obtainable only via `requireWorkspace`), replacing RLS. Background jobs use `db` directly because they work across workspaces. Neon Auth (managed Better Auth) replaces Supabase Auth; the workspace bootstrap that a database trigger used to do becomes an idempotent `ensureUserWorkspace()`.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle ORM (`drizzle-orm/neon-serverless`), `@neondatabase/serverless` + `ws`, `@neondatabase/auth`, Vitest, tsx.

Spec: `docs/superpowers/specs/2026-10-28-neon-migration-design.md`

---

## Deviations from the spec (decided while planning, from reading the code)

1. **SQL-first migrations, no `drizzle-kit`.** The schema relies on check constraints, `unique nulls not distinct`, partial indexes, composite foreign keys and three plpgsql functions. Hand-kept SQL keeps these exact. A parity test (Task 4) fails if `src/db/schema.ts` drifts from the migrated database. `drizzle-kit` is therefore not installed; `db:migrate` runs `scripts/migrate.ts`.
2. **User-id columns are `text` with no foreign key.** The spec planned foreign keys to `neon_auth.user`. That table is managed by Neon and its id type is not guaranteed, so we do not depend on it. Deleting a user is done explicitly by `deleteUserData()` (Task 5).
3. **Background jobs use `db` directly instead of a `WorkspaceScope`.** The scheduler claims connections across all workspaces, so there is no single scope. `WorkspaceScope` is used for everything a signed-in user can reach (pages, server actions, API routes).
4. **Account deletion keeps today's UX** (type your email to confirm). Neon's `deleteUser()` is called before any data is removed, so a failure leaves the account intact.

## Before you start (read this)

- **The user does Task 0 by hand.** There is no Neon CLI or MCP tool in this environment. Do not ask for connection strings in chat; the user puts them straight into `.env.local`.
- **Work in a git worktree on branch `feat/neon-migration`** so the uncommitted simulator/currency work on `feat/cost-simulator` is not mixed in. The pages in `src/app/(app)/` are touched by both pieces of work, so expect small conflicts when the two meet. Do Task 10 (pages) last for that reason.
- **`.env.local` and `node_modules` are not in a fresh worktree.** Task 0 copies the first and installs the second.
- **Facts to confirm along the way** (each has a step that checks it): the Neon Auth SDK's password-reset method names (Task 7), and whether `auth.getSession()` works inside `proxy.ts` (Task 7).

## File structure

Create:

| File | Responsibility |
|---|---|
| `db/migrations/0001_init.sql` | The whole schema for Neon: tables, indexes, triggers, `claim_*` functions. No RLS, no Supabase roles. |
| `src/db/columns.ts` | Drizzle column types: `isoTimestamp` (timestamptz ↔ ISO string) and `num` (numeric ↔ number). |
| `src/db/json.ts` | The `Json` type used for jsonb columns. |
| `src/db/schema.ts` | Drizzle tables (property names equal column names) and the `tables` map. |
| `src/db/types.ts` | `Row<"table">` and `NewRow<"table">` helper types. |
| `src/db/client.ts` | Lazy `db` (Neon Pool + Drizzle), safe to import without `DATABASE_URL`. |
| `src/db/sql.ts` | `excludedFrom()` for `ON CONFLICT DO UPDATE`. |
| `src/db/errors.ts` | `isUniqueViolation()` that sees through Drizzle's error wrapper. |
| `src/db/migrate.ts` | `migrate(url)`: applies `db/migrations/*.sql` once each, race-safe. |
| `src/db/bootstrap.ts` | `ensureUserWorkspace()` and `deleteUserData()`. |
| `src/db/scope.ts` | `WorkspaceScope`, `requireWorkspace()`. |
| `src/db/claims.ts` | `claimDueConnections`, `claimConnection`, `claimDueDeliveries` (wrap the SQL functions). |
| `src/db/alert-relations.ts` | One alert joined to its connection/resource/account/application. |
| `src/db/repos/inventory.ts` | Connections, accounts, resources, sync runs. |
| `src/db/repos/applications.ts` | Applications and resource mappings. |
| `src/db/repos/quotas.ts` | Quotas with evaluations; user-quota writes. |
| `src/db/repos/alerts.ts` | Alerts, deliveries, inbox, alert rules, costs, counts. |
| `src/db/repos/samples.ts` | Usage samples. |
| `src/db/repos/account.ts` | Profile and workspace settings. |
| `src/lib/auth/server.ts` | The Neon Auth server instance. |
| `src/app/api/auth/[...path]/route.ts` | Neon Auth request handler. |
| `scripts/migrate.ts`, `scripts/db-reset.ts` | CLI wrappers. |
| `tests/helpers/test-db.ts` | Points the app at the `test` branch and migrates it. |
| `tests/db/schema-parity.test.ts`, `tests/db/bootstrap.test.ts`, `tests/db/isolation.test.ts` | Integration tests (skipped without `DATABASE_URL_TEST`). |

Modify: `package.json`, `.env.example`, `scripts/setup-env.mjs`, `README.md`, `src/proxy.ts`, `src/lib/session.ts`, `src/lib/audit.ts`, `src/lib/jobs/{db,credentials,reference,scheduler,notify,sync,recalc}.ts`, `src/lib/data/views.ts`, `src/app/page.tsx`, `src/app/auth/signout/route.ts`, `src/app/(auth)/{actions.ts,reset-password/page.tsx,login/page.tsx}`, `src/app/(app)/{layout.tsx,home,alerts,applications,providers,settings,usage}/…`, `src/app/api/integrations/supabase/oauth/{start,callback}/route.ts`.

Delete: `src/lib/supabase/`, `supabase/`, `src/app/auth/callback/route.ts`, `tests/rls.integration.test.ts`.

---

### Task 0: Neon project, environment and worktree (manual, done by the user)

**Files:** `.env.local` (not committed)

- [ ] **Step 1: Create the Neon project and branches**

In the Neon console: create a project named `limit-gauge` (Postgres 17). Keep the default branch `main` as prod and leave it empty. Create a branch `dev` from `main`. On branch `dev`, open **Auth** and click **Enable Auth**. Check the plan/pricing note on the Auth page; if Auth is not available on your plan, stop and tell the assistant.

- [ ] **Step 2: Put the connection settings in `.env.local`**

Open `.env.local` in an editor and add these lines (values from the console: **Connect** → branch `dev`, once with "Connection pooling" on and once off; Auth URL from **Auth → Configuration**). Do not paste them into the chat.

```
DATABASE_URL=postgresql://…-pooler…/neondb?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://…/neondb?sslmode=require
NEON_AUTH_BASE_URL=https://ep-…neonauth….neon.tech/neondb/auth
NEON_BRANCH=dev
```

In the Neon console under **Auth → Configuration** (branch `dev`), add `http://localhost:3100` as a trusted domain / allowed origin, and leave "Allow Localhost" on.

- [ ] **Step 3: Create the worktree**

```bash
cd "/Users/fiona/Documents/Apps/Cloud Watch"
git worktree add ../"Cloud Watch Neon" -b feat/neon-migration
cp .env.local "../Cloud Watch Neon/.env.local"
cd "../Cloud Watch Neon" && npm install
```

Expected: a new directory `Cloud Watch Neon` next to the original, on branch `feat/neon-migration`, with dependencies installed. **All following tasks run in that directory.**

---

### Task 1: Dependencies and environment template

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install the new packages**

```bash
npm install drizzle-orm @neondatabase/serverless ws @neondatabase/auth@latest
npm install -D @types/ws
```

Expected: install succeeds. (The Supabase packages stay until Task 11 because code still imports them.)

- [ ] **Step 2: Add the migration script**

In `package.json` `scripts`, add after `"worker:once"`:

```json
    "db:migrate": "tsx --env-file=.env.local scripts/migrate.ts",
```

- [ ] **Step 3: Add the Neon variables to `.env.example`**

Replace the block that starts with `# --- CloudWatch's own Supabase project (auth + database) ---` through the `SUPABASE_SERVICE_ROLE_KEY=` line with:

```
# --- Neon (database + auth) ---
# Pooled connection string of the branch you develop on (Neon console → Connect, pooling on).
DATABASE_URL=
# Direct (unpooled) connection string of the same branch; used by migrations.
DATABASE_URL_UNPOOLED=
# A label for the branch the URLs above point to. db:reset only runs when this is "dev".
NEON_BRANCH=dev
# Neon Auth: the Auth URL of the same branch (Neon console → Auth → Configuration).
NEON_AUTH_BASE_URL=
# 32+ random characters. Generate with: openssl rand -base64 32
NEON_AUTH_COOKIE_SECRET=
# Direct connection string of the Neon branch `npm test` integration tests run on. It may be the
# same branch as DATABASE_URL (the tests only create and delete their own random users); use a
# separate branch if that branch holds data you care about. Leave empty to skip those tests.
DATABASE_URL_TEST=
```

Also change the email comment line `# Local Supabase ships Mailpit: SMTP on 54325, inbox UI on http://127.0.0.1:54324` to `# Local development: use EMAIL_TRANSPORT=console (emails are printed to the server log).`

- [ ] **Step 4: Set `NEON_AUTH_COOKIE_SECRET` locally**

```bash
printf 'NEON_AUTH_COOKIE_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env.local
```

Expected: the line is appended to `.env.local` (nothing printed).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add Neon, Drizzle and Neon Auth dependencies

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database core (columns, json, client, sql helper, errors)

**Files:**
- Create: `src/db/columns.ts`, `src/db/json.ts`, `src/db/client.ts`, `src/db/sql.ts`, `src/db/errors.ts`

These are thin and are exercised by the tests in Tasks 4–6, so they have no tests of their own.

- [ ] **Step 1: Create `src/db/json.ts`**

```ts
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
```

- [ ] **Step 2: Create `src/db/columns.ts`**

```ts
import { customType } from "drizzle-orm/pg-core";

/**
 * timestamptz as an ISO-8601 string. PostgREST returned ISO strings and the whole app
 * (engine, views, pages) parses them with `new Date(...)`/`Date.parse`, so we keep that shape.
 */
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamptz",
  fromDriver: (value) => new Date(value).toISOString(),
  toDriver: (value) => value,
});

/** numeric as a JS number. node-postgres returns numeric as text; PostgREST returned numbers. */
export const num = customType<{ data: number; driverData: string | number }>({
  dataType: () => "numeric",
  fromDriver: (value) => Number(value),
  toDriver: (value) => String(value),
});
```

- [ ] **Step 3: Create `src/db/errors.ts`**

```ts
/** SQLSTATE of a Postgres error, whether or not Drizzle wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === "23505";
```

- [ ] **Step 4: Create `src/db/sql.ts`**

```ts
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

/**
 * The `set` clause of `ON CONFLICT DO UPDATE` that takes the incoming value of every column
 * present in `sample` (except `skip`). Columns absent from `sample` (for example the user's
 * own `is_monitored` choice) are left alone, which is how PostgREST upserts behaved.
 */
export function excludedFrom<T extends PgTable>(table: T, sample: object, skip: string[] = []): PgUpdateSetSource<T> {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sample)) {
    if (!(key in columns) || skip.includes(key)) continue;
    set[key] = sql.raw(`excluded."${columns[key].name}"`);
  }
  return set as PgUpdateSetSource<T>;
}
```

- [ ] **Step 5: Create `src/db/client.ts`**

```ts
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const KEY = Symbol.for("limitgauge.db");
type Global = typeof globalThis & { [KEY]?: Db };

function create(): Db {
  if (typeof window !== "undefined") throw new Error("db must never be used in the browser");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (see .env.example)");
  return drizzle(new Pool({ connectionString: url, max: 5 }), { schema });
}

function get(): Db {
  const g = globalThis as Global;
  return (g[KEY] ??= create()); // one pool per process, also across Next.js hot reloads
}

/** Created on first use, so importing this module never needs DATABASE_URL (builds, unit tests). */
export const db: Db = new Proxy({} as Db, { get: (_target, prop) => Reflect.get(get(), prop) });

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
```

- [ ] **Step 6: Commit** (the files do not typecheck until Task 4 adds `schema.ts`; commit anyway, nothing runs them yet)

```bash
git add src/db
git commit -m "feat(db): add Drizzle client, column types and helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: SQL migration, runner and the dev and test branches

**Files:**
- Create: `db/migrations/0001_init.sql`, `src/db/migrate.ts`, `scripts/migrate.ts`

- [ ] **Step 1: Create `db/migrations/0001_init.sql`**

This is `supabase/migrations/20261009000000_init.sql` with these removals: the `pgcrypto` extension (`gen_random_uuid()` is built in), every `references auth.users`, `handle_new_user()` and its trigger, `is_workspace_member()`, all grants/revokes, `enable row level security` and all policies. User-id columns become `text`.

```sql
-- Limit Gauge schema for Neon.
--
-- Authorization is enforced in application code (src/db/scope.ts): every user-facing query
-- filters by the workspace of a WorkspaceScope. User ids are text with no foreign key because
-- users live in Neon Auth's managed neon_auth schema.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Users & workspaces ---------------------------------------------------------

create table public.profiles (
  id text primary key,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner_id text not null,
  notify_in_app boolean not null default true,
  notify_email boolean not null default true,
  email_min_severity text not null default 'warning'
    check (email_min_severity in ('info', 'warning', 'critical', 'limit_reached')),
  alert_email text check (alert_email is null or alert_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  stale_after_hours integer not null default 24 check (stale_after_hours between 1 and 720),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_owner_idx on public.workspaces (owner_id);

-- MVP: exactly one owner per workspace. The table exists so teams can be added later.
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id text not null,
  role text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

-- Provider connections, credentials, accounts, resources -----------------------

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null check (provider in ('supabase', 'cloudflare', 'firebase', 'aws', 'demo')),
  label text not null check (char_length(label) between 1 and 80),
  auth_method text not null check (auth_method in ('oauth', 'token', 'demo')),
  status text not null default 'syncing' check (status in (
    'connected', 'syncing', 'reauth_required', 'permission_insufficient',
    'unsupported_capability', 'error', 'disconnected'
  )),
  status_detail text,
  status_changed_at timestamptz not null default now(),
  granted_scopes text[] not null default '{}',
  capabilities jsonb not null default '{}'::jsonb,
  sync_interval_minutes integer not null default 360 check (sync_interval_minutes between 15 and 10080),
  next_sync_at timestamptz default now(),
  locked_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_discovery_at timestamptz,
  last_manual_sync_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error_code text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (id, workspace_id)
);
create index provider_connections_workspace_idx on public.provider_connections (workspace_id);
create index provider_connections_due_idx on public.provider_connections (next_sync_at)
  where status <> 'disconnected';

create table public.provider_credentials (
  connection_id uuid primary key references public.provider_connections (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ciphertext text not null,
  key_version integer not null default 1,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.oauth_states (
  state text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id text not null,
  provider text not null,
  code_verifier_ciphertext text not null,
  connection_id uuid references public.provider_connections (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create table public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  external_id text not null,
  name text not null,
  account_type text not null default 'organization',
  plan text,
  billing_currency text,
  -- Day of month (UTC) the billing cycle resets. Providers rarely expose this, so the
  -- user can correct it; quotas scoped to this account and its resources use it.
  billing_cycle_anchor_day integer not null default 1 check (billing_cycle_anchor_day between 1 and 28),
  status text not null default 'active' check (status in ('active', 'inaccessible', 'deleted')),
  dashboard_url text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (connection_id, external_id),
  unique (id, workspace_id),
  foreign key (connection_id, workspace_id)
    references public.provider_connections (id, workspace_id) on delete cascade
);
create index provider_accounts_workspace_idx on public.provider_accounts (workspace_id);

create table public.provider_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  account_id uuid references public.provider_accounts (id) on delete set null,
  provider text not null,
  external_id text not null,
  name text not null,
  resource_type text not null,
  region text,
  plan text,
  provider_status text,
  status text not null default 'active' check (status in ('active', 'inaccessible', 'deleted')),
  is_monitored boolean not null default false,
  dashboard_url text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_collected_at timestamptz,
  unique (connection_id, resource_type, external_id),
  unique (id, workspace_id),
  foreign key (connection_id, workspace_id)
    references public.provider_connections (id, workspace_id) on delete cascade
);
create index provider_resources_workspace_idx on public.provider_resources (workspace_id);
create index provider_resources_account_idx on public.provider_resources (account_id);

-- Applications (user-defined grouping, independent of provider hierarchy) ----------

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name),
  unique (id, workspace_id)
);

-- A resource belongs to at most one application. Composite foreign keys guarantee the
-- application and the resource live in the same workspace.
create table public.application_resources (
  application_id uuid not null,
  resource_id uuid not null unique,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (application_id, resource_id),
  foreign key (application_id, workspace_id)
    references public.applications (id, workspace_id) on delete cascade,
  foreign key (resource_id, workspace_id)
    references public.provider_resources (id, workspace_id) on delete cascade
);
create index application_resources_workspace_idx on public.application_resources (workspace_id);

-- Reference data: metric definitions and versioned pricing rules ---------------------
-- Source of truth lives in code (src/lib/providers/*); synced by the server.

create table public.metric_definitions (
  key text primary key,
  provider text not null,
  name text not null,
  description text not null default '',
  unit text not null,
  aggregation text not null check (aggregation in ('gauge', 'cumulative', 'incremental')),
  scope_level text not null check (scope_level in ('account', 'resource')),
  derivation text not null check (derivation in ('reported', 'derived', 'estimated')),
  supported boolean not null default true,
  unsupported_reason text,
  updated_at timestamptz not null default now()
);

create table public.pricing_rules (
  id text primary key, -- e.g. supabase.pro.monthly_active_users@2026-10
  provider text not null,
  metric_key text not null references public.metric_definitions (key) on delete cascade,
  plan text not null,
  version text not null,
  currency text not null,
  included_quantity numeric not null default 0,
  unit_price numeric not null,
  unit_size numeric not null default 1 check (unit_size > 0),
  billing_mode text not null default 'per_unit' check (billing_mode in ('per_unit', 'package')),
  source_url text,
  verified_at date not null,
  notes text,
  updated_at timestamptz not null default now(),
  unique (metric_key, plan, version)
);

-- Quotas ------------------------------------------------------------------------------

create table public.quota_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  metric_key text not null references public.metric_definitions (key) on delete cascade,
  scope_type text not null check (scope_type in ('account', 'resource')),
  account_id uuid,
  resource_id uuid,
  limit_value numeric check (limit_value is null or limit_value >= 0),
  unit text not null,
  period text not null default 'billing_cycle' check (period in ('billing_cycle', 'none')),
  source text not null check (source in ('provider', 'user')),
  overage_effect text not null default 'unknown'
    check (overage_effect in ('charges', 'restriction', 'both', 'none', 'unknown')),
  pricing_rule_id text references public.pricing_rules (id) on delete set null,
  thresholds jsonb, -- optional per-quota override of the workspace threshold rule
  plan_hint text,
  notes text check (notes is null or char_length(notes) <= 500),
  verified_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'account' and account_id is not null and resource_id is null)
    or (scope_type = 'resource' and resource_id is not null and account_id is null)
  ),
  foreign key (account_id, workspace_id)
    references public.provider_accounts (id, workspace_id) on delete cascade,
  foreign key (resource_id, workspace_id)
    references public.provider_resources (id, workspace_id) on delete cascade,
  unique nulls not distinct (workspace_id, metric_key, account_id, resource_id, source)
);
create index quota_rules_workspace_idx on public.quota_rules (workspace_id);

-- Latest evaluation of each quota, recalculated after ingestion and after quota edits.
create table public.quota_evaluations (
  quota_rule_id uuid primary key references public.quota_rules (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  is_effective boolean not null default true,
  current_value numeric,
  limit_value numeric,
  percent_used numeric,
  cycle_start timestamptz,
  cycle_end timestamptz,
  data_updated_at timestamptz,
  data_state text not null check (data_state in ('fresh', 'stale', 'missing', 'unknown_limit')),
  coverage jsonb not null default '{}'::jsonb,
  forecast jsonb not null default '{}'::jsonb,
  cost jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);
create index quota_evaluations_workspace_idx on public.quota_evaluations (workspace_id);

-- Usage & cost ---------------------------------------------------------------------------

create table public.usage_samples (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  account_id uuid references public.provider_accounts (id) on delete cascade,
  resource_id uuid references public.provider_resources (id) on delete cascade,
  metric_key text not null references public.metric_definitions (key) on delete cascade,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  value numeric not null check (value >= 0),
  unit text not null,
  aggregation text not null check (aggregation in ('gauge', 'cumulative', 'incremental')),
  observed_at timestamptz not null,
  collected_at timestamptz not null default now(),
  source text not null check (source in ('provider', 'derived', 'estimated', 'demo')),
  quality text not null default 'ok' check (quality in ('ok', 'partial', 'estimated')),
  dimensions jsonb,
  sync_run_id uuid,
  check (bucket_end > bucket_start),
  -- One value per scope, metric and bucket: re-collecting the same bucket overwrites it,
  -- so repeated fetches never double-count.
  unique nulls not distinct (connection_id, metric_key, account_id, resource_id, bucket_start)
);
create index usage_samples_workspace_metric_idx on public.usage_samples (workspace_id, metric_key, bucket_start);
create index usage_samples_resource_idx on public.usage_samples (resource_id, metric_key, bucket_start desc);

create table public.cost_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid references public.provider_connections (id) on delete cascade,
  account_id uuid references public.provider_accounts (id) on delete cascade,
  resource_id uuid references public.provider_resources (id) on delete cascade,
  metric_key text, -- null for an account's total reported spend
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount numeric not null,
  currency text not null,
  kind text not null check (kind in ('reported', 'estimated', 'projected')),
  pricing_rule_id text references public.pricing_rules (id) on delete set null,
  pricing_version text,
  calculation jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  unique nulls not distinct (workspace_id, kind, metric_key, account_id, resource_id, period_start)
);
create index cost_records_workspace_idx on public.cost_records (workspace_id, period_start);

-- Alerts & notifications ------------------------------------------------------------------

create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  category text not null check (category in (
    'quota_threshold', 'forecast_breach', 'cost_overage', 'integration_health'
  )),
  enabled boolean not null default true,
  thresholds jsonb not null default '[]'::jsonb,
  notify_in_app boolean not null default true,
  notify_email boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, category)
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_id uuid references public.alert_rules (id) on delete set null,
  category text not null check (category in (
    'quota_threshold', 'forecast_breach', 'cost_overage', 'integration_health'
  )),
  severity text not null check (severity in ('info', 'warning', 'critical', 'limit_reached')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'muted', 'resolved', 'superseded')),
  dedupe_key text not null,
  group_key text not null,
  title text not null,
  message text not null,
  recommended_action text,
  connection_id uuid references public.provider_connections (id) on delete set null,
  account_id uuid references public.provider_accounts (id) on delete set null,
  resource_id uuid references public.provider_resources (id) on delete set null,
  application_id uuid references public.applications (id) on delete set null,
  quota_rule_id uuid references public.quota_rules (id) on delete set null,
  metric_key text,
  current_value numeric,
  limit_value numeric,
  unit text,
  percent_used numeric,
  cycle_start timestamptz,
  cycle_reset_at timestamptz,
  forecast_breach_at timestamptz,
  data_updated_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  muted_until timestamptz,
  resolved_at timestamptz,
  unique (workspace_id, dedupe_key)
);
create index alerts_workspace_status_idx on public.alerts (workspace_id, status, created_at desc);
create index alerts_group_idx on public.alerts (workspace_id, group_key);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  alert_id uuid not null references public.alerts (id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email')),
  recipient text,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alert_id, channel)
);
create index notification_deliveries_pending_idx on public.notification_deliveries (next_attempt_at)
  where status in ('pending', 'sending');
create index notification_deliveries_inbox_idx on public.notification_deliveries (workspace_id, channel, created_at desc);

-- Operations ------------------------------------------------------------------------------

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  trigger text not null check (trigger in ('scheduled', 'manual', 'connect')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_code text,
  error_message text,
  stats jsonb not null default '{}'::jsonb
);
create index sync_runs_connection_idx on public.sync_runs (connection_id, started_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_workspace_idx on public.audit_logs (workspace_id, created_at desc);

-- updated_at triggers ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'workspaces', 'provider_connections', 'provider_credentials', 'applications',
    'quota_rules', 'alert_rules', 'alerts', 'notification_deliveries'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  end loop;
end $$;

-- Worker functions -------------------------------------------------------------------------

-- Atomically claim connections that are due for collection. SKIP LOCKED lets several
-- workers run concurrently without processing the same connection twice.
create or replace function public.claim_due_connections(p_limit integer default 10, p_lock_minutes integer default 15)
returns setof public.provider_connections
language plpgsql
set search_path = ''
as $$
begin
  return query
  update public.provider_connections c
     set locked_until = now() + make_interval(mins => p_lock_minutes),
         last_attempt_at = now()
   where c.id in (
     select pc.id from public.provider_connections pc
      where pc.status <> 'disconnected'
        and pc.next_sync_at is not null
        and pc.next_sync_at <= now()
        and (pc.locked_until is null or pc.locked_until < now())
      order by pc.next_sync_at
      limit p_limit
      for update skip locked
   )
  returning c.*;
end;
$$;

create or replace function public.claim_connection(p_connection_id uuid, p_lock_minutes integer default 15)
returns setof public.provider_connections
language plpgsql
set search_path = ''
as $$
begin
  return query
  update public.provider_connections c
     set locked_until = now() + make_interval(mins => p_lock_minutes),
         last_attempt_at = now()
   where c.id = p_connection_id
     and c.status <> 'disconnected'
     and (c.locked_until is null or c.locked_until < now())
  returning c.*;
end;
$$;

-- Claim notification deliveries that are due. Rows stuck in 'sending' for 10 minutes
-- (crashed worker) become claimable again; the unique (alert_id, channel) constraint
-- guarantees a retry never creates a second delivery.
create or replace function public.claim_due_deliveries(p_limit integer default 25)
returns setof public.notification_deliveries
language plpgsql
set search_path = ''
as $$
begin
  return query
  update public.notification_deliveries d
     set status = 'sending', attempts = d.attempts + 1
   where d.id in (
     select nd.id from public.notification_deliveries nd
      where nd.channel = 'email'
        and nd.next_attempt_at <= now()
        and (nd.status = 'pending' or (nd.status = 'sending' and nd.updated_at < now() - interval '10 minutes'))
      order by nd.next_attempt_at
      limit p_limit
      for update skip locked
   )
  returning d.*;
end;
$$;
```

- [ ] **Step 2: Create `src/db/migrate.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const DIR = join(process.cwd(), "db", "migrations");
const LOCK_ID = 727274;

/**
 * Applies db/migrations/*.sql in filename order, each exactly once, each in its own
 * transaction. Concurrent callers (parallel test files) are serialised by an advisory lock.
 * Returns the names of the migrations applied by this call.
 */
export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1 });
  const applied: string[] = [];
  try {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`select pg_advisory_xact_lock(${LOCK_ID})`);
        await client.query(
          "create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())",
        );
        const seen = await client.query("select 1 from public.schema_migrations where name = $1", [file]);
        if (seen.rowCount === 0) {
          await client.query(readFileSync(join(DIR, file), "utf8"));
          await client.query("insert into public.schema_migrations (name) values ($1)", [file]);
          applied.push(file);
        }
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}
```

- [ ] **Step 3: Create `scripts/migrate.ts`**

```ts
// `npm run db:migrate` — applies db/migrations to the branch DATABASE_URL_UNPOOLED points at.
import { migrate } from "../src/db/migrate";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL) in .env.local first.");
  process.exit(1);
}

migrate(url).then(
  (applied) => console.info(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date."),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
```

- [ ] **Step 4: Apply the migration to the `dev` branch**

```bash
npm run db:migrate
```

Expected: `Applied: 0001_init.sql`. Running it again prints `Database is up to date.`

- [ ] **Step 5: Create the `test` branch (manual, user)**

Decision (project owner): no separate `test` branch. Integration tests run on the `dev` branch, so set `DATABASE_URL_TEST` in `.env.local` to the same **direct (unpooled)** connection string as `DATABASE_URL_UNPOOLED`. Tests run `migrate()` themselves, which is a no-op on `dev`. (A separate branch is safer if `dev` ever holds data you care about; see `tests/helpers/test-db.ts`.)

- [ ] **Step 6: Commit**

```bash
git add db scripts/migrate.ts src/db/migrate.ts
git commit -m "feat(db): add Neon schema migration and runner

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Drizzle schema, row types and the parity test

**Files:**
- Create: `src/db/schema.ts`, `src/db/types.ts`, `tests/helpers/test-db.ts`, `tests/db/schema-parity.test.ts`
- Modify: `vitest.config.mts`

- [ ] **Step 0: Raise the test timeouts**

The first request to a Neon branch can wake a suspended compute, which takes longer than Vitest's defaults. Replace `vitest.config.mts` with:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 60_000 },
});
```

- [ ] **Step 1: Create `tests/helpers/test-db.ts`**

```ts
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export const testUrl = process.env.DATABASE_URL_TEST;
export const hasTestDb = Boolean(testUrl);

/**
 * Points the app's `db` at DATABASE_URL_TEST and applies migrations to it.
 * Call (and await) before importing anything from "@/db/*" in a test file.
 *
 * DATABASE_URL_TEST may be the same Neon branch as DATABASE_URL (the project owner chose to
 * test on `dev`). That is safe only because the tests create users with random ids and delete
 * exactly those in `afterAll`; a test must never drop, truncate or bulk-delete anything.
 */
export async function useTestDb() {
  const url = testUrl!;
  process.env.DATABASE_URL = url;
  const { migrate } = await import("@/db/migrate");
  await migrate(url);
}
```

- [ ] **Step 2: Write the failing parity test `tests/db/schema-parity.test.ts`**

```ts
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { hasTestDb, useTestDb } from "../helpers/test-db";

describe.skipIf(!hasTestDb)("drizzle schema matches the migrated database", () => {
  beforeAll(useTestDb);

  it("has exactly the tables and columns the migration created", async () => {
    const { db } = await import("@/db/client");
    const { tables } = await import("@/db/schema");
    const res = await db.execute(
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public' and table_name <> 'schema_migrations'`,
    );
    const actual = new Map<string, string[]>();
    for (const r of res.rows as { table_name: string; column_name: string }[]) {
      actual.set(r.table_name, [...(actual.get(r.table_name) ?? []), r.column_name]);
    }
    const declared = Object.values(tables);
    expect([...actual.keys()].sort()).toEqual(declared.map((t) => getTableName(t)).sort());
    for (const t of declared) {
      const columns = Object.values(getTableColumns(t)).map((c) => c.name).sort();
      expect((actual.get(getTableName(t)) ?? []).sort(), getTableName(t)).toEqual(columns);
    }
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run tests/db/schema-parity.test.ts
```

Expected: FAIL, `Failed to resolve import "@/db/schema"`. (If `DATABASE_URL_TEST` is unset the test is skipped; set it first.)

- [ ] **Step 4: Create `src/db/schema.ts`**

```ts
import { sql } from "drizzle-orm";
import { bigint, boolean, date, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { isoTimestamp as ts, num } from "./columns";
import type { Json } from "./json";

// Property names equal column names on purpose: rows keep the snake_case shape the engine,
// views and pages already use. This file only declares columns and defaults; constraints,
// indexes and functions live in db/migrations (tests/db/schema-parity.test.ts guards drift).

const now = sql`now()`;
const emptyObject = sql`'{}'::jsonb`;

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  display_name: text("display_name"),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  owner_id: text("owner_id").notNull(),
  notify_in_app: boolean("notify_in_app").notNull().default(true),
  notify_email: boolean("notify_email").notNull().default(true),
  email_min_severity: text("email_min_severity").notNull().default("warning"),
  alert_email: text("alert_email"),
  stale_after_hours: integer("stale_after_hours").notNull().default(24),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const workspace_members = pgTable(
  "workspace_members",
  {
    workspace_id: uuid("workspace_id").notNull(),
    user_id: text("user_id").notNull(),
    role: text("role").notNull().default("owner"),
    created_at: ts("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.user_id] })],
);

export const provider_connections = pgTable("provider_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  auth_method: text("auth_method").notNull(),
  status: text("status").notNull().default("syncing"),
  status_detail: text("status_detail"),
  status_changed_at: ts("status_changed_at").notNull().default(now),
  granted_scopes: text("granted_scopes").array().notNull().default([]),
  capabilities: jsonb("capabilities").$type<Json>().notNull().default(emptyObject),
  sync_interval_minutes: integer("sync_interval_minutes").notNull().default(360),
  next_sync_at: ts("next_sync_at").default(now),
  locked_until: ts("locked_until"),
  last_attempt_at: ts("last_attempt_at"),
  last_success_at: ts("last_success_at"),
  last_discovery_at: ts("last_discovery_at"),
  last_manual_sync_at: ts("last_manual_sync_at"),
  consecutive_failures: integer("consecutive_failures").notNull().default(0),
  last_error_code: text("last_error_code"),
  created_by: text("created_by"),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
  disconnected_at: ts("disconnected_at"),
});

export const provider_credentials = pgTable("provider_credentials", {
  connection_id: uuid("connection_id").primaryKey(),
  workspace_id: uuid("workspace_id").notNull(),
  ciphertext: text("ciphertext").notNull(),
  key_version: integer("key_version").notNull().default(1),
  expires_at: ts("expires_at"),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const oauth_states = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  workspace_id: uuid("workspace_id").notNull(),
  user_id: text("user_id").notNull(),
  provider: text("provider").notNull(),
  code_verifier_ciphertext: text("code_verifier_ciphertext").notNull(),
  connection_id: uuid("connection_id"),
  created_at: ts("created_at").notNull().default(now),
  expires_at: ts("expires_at").notNull().default(sql`now() + interval '10 minutes'`),
});

export const provider_accounts = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  connection_id: uuid("connection_id").notNull(),
  provider: text("provider").notNull(),
  external_id: text("external_id").notNull(),
  name: text("name").notNull(),
  account_type: text("account_type").notNull().default("organization"),
  plan: text("plan"),
  billing_currency: text("billing_currency"),
  billing_cycle_anchor_day: integer("billing_cycle_anchor_day").notNull().default(1),
  status: text("status").notNull().default("active"),
  dashboard_url: text("dashboard_url"),
  metadata: jsonb("metadata").$type<Json>().notNull().default(emptyObject),
  first_seen_at: ts("first_seen_at").notNull().default(now),
  last_seen_at: ts("last_seen_at").notNull().default(now),
});

export const provider_resources = pgTable("provider_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  connection_id: uuid("connection_id").notNull(),
  account_id: uuid("account_id"),
  provider: text("provider").notNull(),
  external_id: text("external_id").notNull(),
  name: text("name").notNull(),
  resource_type: text("resource_type").notNull(),
  region: text("region"),
  plan: text("plan"),
  provider_status: text("provider_status"),
  status: text("status").notNull().default("active"),
  is_monitored: boolean("is_monitored").notNull().default(false),
  dashboard_url: text("dashboard_url"),
  metadata: jsonb("metadata").$type<Json>().notNull().default(emptyObject),
  first_seen_at: ts("first_seen_at").notNull().default(now),
  last_seen_at: ts("last_seen_at").notNull().default(now),
  last_collected_at: ts("last_collected_at"),
});

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const application_resources = pgTable(
  "application_resources",
  {
    application_id: uuid("application_id").notNull(),
    resource_id: uuid("resource_id").notNull(),
    workspace_id: uuid("workspace_id").notNull(),
    created_at: ts("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.application_id, t.resource_id] })],
);

export const metric_definitions = pgTable("metric_definitions", {
  key: text("key").primaryKey(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  unit: text("unit").notNull(),
  aggregation: text("aggregation").notNull(),
  scope_level: text("scope_level").notNull(),
  derivation: text("derivation").notNull(),
  supported: boolean("supported").notNull().default(true),
  unsupported_reason: text("unsupported_reason"),
  updated_at: ts("updated_at").notNull().default(now),
});

export const pricing_rules = pgTable("pricing_rules", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  metric_key: text("metric_key").notNull(),
  plan: text("plan").notNull(),
  version: text("version").notNull(),
  currency: text("currency").notNull(),
  included_quantity: num("included_quantity").notNull().default(0),
  unit_price: num("unit_price").notNull(),
  unit_size: num("unit_size").notNull().default(1),
  billing_mode: text("billing_mode").notNull().default("per_unit"),
  source_url: text("source_url"),
  verified_at: date("verified_at", { mode: "string" }).notNull(),
  notes: text("notes"),
  updated_at: ts("updated_at").notNull().default(now),
});

export const quota_rules = pgTable("quota_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  metric_key: text("metric_key").notNull(),
  scope_type: text("scope_type").notNull(),
  account_id: uuid("account_id"),
  resource_id: uuid("resource_id"),
  limit_value: num("limit_value"),
  unit: text("unit").notNull(),
  period: text("period").notNull().default("billing_cycle"),
  source: text("source").notNull(),
  overage_effect: text("overage_effect").notNull().default("unknown"),
  pricing_rule_id: text("pricing_rule_id"),
  thresholds: jsonb("thresholds").$type<Json>(),
  plan_hint: text("plan_hint"),
  notes: text("notes"),
  verified_at: ts("verified_at"),
  created_by: text("created_by"),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const quota_evaluations = pgTable("quota_evaluations", {
  quota_rule_id: uuid("quota_rule_id").primaryKey(),
  workspace_id: uuid("workspace_id").notNull(),
  is_effective: boolean("is_effective").notNull().default(true),
  current_value: num("current_value"),
  limit_value: num("limit_value"),
  percent_used: num("percent_used"),
  cycle_start: ts("cycle_start"),
  cycle_end: ts("cycle_end"),
  data_updated_at: ts("data_updated_at"),
  data_state: text("data_state").notNull(),
  coverage: jsonb("coverage").$type<Json>().notNull().default(emptyObject),
  forecast: jsonb("forecast").$type<Json>().notNull().default(emptyObject),
  cost: jsonb("cost").$type<Json>().notNull().default(emptyObject),
  computed_at: ts("computed_at").notNull().default(now),
});

export const usage_samples = pgTable("usage_samples", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  workspace_id: uuid("workspace_id").notNull(),
  connection_id: uuid("connection_id").notNull(),
  account_id: uuid("account_id"),
  resource_id: uuid("resource_id"),
  metric_key: text("metric_key").notNull(),
  bucket_start: ts("bucket_start").notNull(),
  bucket_end: ts("bucket_end").notNull(),
  value: num("value").notNull(),
  unit: text("unit").notNull(),
  aggregation: text("aggregation").notNull(),
  observed_at: ts("observed_at").notNull(),
  collected_at: ts("collected_at").notNull().default(now),
  source: text("source").notNull(),
  quality: text("quality").notNull().default("ok"),
  dimensions: jsonb("dimensions").$type<Json>(),
  sync_run_id: uuid("sync_run_id"),
});

export const cost_records = pgTable("cost_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  connection_id: uuid("connection_id"),
  account_id: uuid("account_id"),
  resource_id: uuid("resource_id"),
  metric_key: text("metric_key"),
  period_start: ts("period_start").notNull(),
  period_end: ts("period_end").notNull(),
  amount: num("amount").notNull(),
  currency: text("currency").notNull(),
  kind: text("kind").notNull(),
  pricing_rule_id: text("pricing_rule_id"),
  pricing_version: text("pricing_version"),
  calculation: jsonb("calculation").$type<Json>().notNull().default(emptyObject),
  computed_at: ts("computed_at").notNull().default(now),
});

export const alert_rules = pgTable("alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  category: text("category").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  thresholds: jsonb("thresholds").$type<Json>().notNull().default(sql`'[]'::jsonb`),
  notify_in_app: boolean("notify_in_app").notNull().default(true),
  notify_email: boolean("notify_email").notNull().default(true),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  rule_id: uuid("rule_id"),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),
  dedupe_key: text("dedupe_key").notNull(),
  group_key: text("group_key").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  recommended_action: text("recommended_action"),
  connection_id: uuid("connection_id"),
  account_id: uuid("account_id"),
  resource_id: uuid("resource_id"),
  application_id: uuid("application_id"),
  quota_rule_id: uuid("quota_rule_id"),
  metric_key: text("metric_key"),
  current_value: num("current_value"),
  limit_value: num("limit_value"),
  unit: text("unit"),
  percent_used: num("percent_used"),
  cycle_start: ts("cycle_start"),
  cycle_reset_at: ts("cycle_reset_at"),
  forecast_breach_at: ts("forecast_breach_at"),
  data_updated_at: ts("data_updated_at"),
  details: jsonb("details").$type<Json>().notNull().default(emptyObject),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
  acknowledged_at: ts("acknowledged_at"),
  acknowledged_by: text("acknowledged_by"),
  muted_until: ts("muted_until"),
  resolved_at: ts("resolved_at"),
});

export const notification_deliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  alert_id: uuid("alert_id").notNull(),
  channel: text("channel").notNull(),
  recipient: text("recipient"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  next_attempt_at: ts("next_attempt_at").notNull().default(now),
  sent_at: ts("sent_at"),
  read_at: ts("read_at"),
  created_at: ts("created_at").notNull().default(now),
  updated_at: ts("updated_at").notNull().default(now),
});

export const sync_runs = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspace_id: uuid("workspace_id").notNull(),
  connection_id: uuid("connection_id").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull().default("running"),
  started_at: ts("started_at").notNull().default(now),
  finished_at: ts("finished_at"),
  error_code: text("error_code"),
  error_message: text("error_message"),
  stats: jsonb("stats").$type<Json>().notNull().default(emptyObject),
});

export const audit_logs = pgTable("audit_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  workspace_id: uuid("workspace_id"),
  actor_id: text("actor_id"),
  action: text("action").notNull(),
  target_type: text("target_type"),
  target_id: text("target_id"),
  details: jsonb("details").$type<Json>().notNull().default(emptyObject),
  created_at: ts("created_at").notNull().default(now),
});

export const tables = {
  profiles,
  workspaces,
  workspace_members,
  provider_connections,
  provider_credentials,
  oauth_states,
  provider_accounts,
  provider_resources,
  applications,
  application_resources,
  metric_definitions,
  pricing_rules,
  quota_rules,
  quota_evaluations,
  usage_samples,
  cost_records,
  alert_rules,
  alerts,
  notification_deliveries,
  sync_runs,
  audit_logs,
};
```

- [ ] **Step 5: Create `src/db/types.ts`**

```ts
import type { tables } from "./schema";

export type { Json } from "./json";
export type TableName = keyof typeof tables;
/** A row as selected from the table, in the same shape PostgREST rows had. */
export type Row<K extends TableName> = (typeof tables)[K]["$inferSelect"];
/** A row as inserted into the table. */
export type NewRow<K extends TableName> = (typeof tables)[K]["$inferInsert"];
```

- [ ] **Step 6: Run the parity test and typecheck the new files**

```bash
npx vitest run tests/db/schema-parity.test.ts
npx tsc --noEmit 2>&1 | grep -E "^src/db/|^tests/(db|helpers)/" || echo "db files typecheck clean"
```

Expected: the test passes (1 test). The `tsc` filter prints `db files typecheck clean`. (Errors elsewhere in the repo are expected until later tasks and are ignored by the filter.)

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/types.ts tests/helpers tests/db/schema-parity.test.ts vitest.config.mts
git commit -m "feat(db): add Drizzle schema with a parity test against the migration

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Workspace bootstrap and user deletion

**Files:**
- Create: `src/db/bootstrap.ts`, `tests/db/bootstrap.test.ts`

`ensureUserWorkspace()` replaces the `handle_new_user()` trigger. `deleteUserData()` replaces the cascade from `auth.users`.

- [ ] **Step 1: Write the failing test `tests/db/bootstrap.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb, useTestDb } from "../helpers/test-db";

describe.skipIf(!hasTestDb)("workspace bootstrap", () => {
  const created: string[] = [];
  const newUser = () => {
    const id = randomUUID();
    created.push(id);
    return { id, email: `boot-${id}@limitgauge.test` };
  };

  beforeAll(useTestDb);
  afterAll(async () => {
    const { deleteUserData } = await import("@/db/bootstrap");
    for (const id of created) await deleteUserData(id);
  });

  it("creates the profile, workspace, owner membership and the four default alert rules", async () => {
    const { ensureUserWorkspace } = await import("@/db/bootstrap");
    const { db } = await import("@/db/client");
    const { alert_rules, profiles, workspace_members } = await import("@/db/schema");
    const user = newUser();
    const ws = await ensureUserWorkspace(user);

    expect(ws.owner_id).toBe(user.id);
    expect(ws.name).toBe(`boot-${user.id}'s workspace`.slice(0, 80));
    expect((await db.select().from(profiles).where(eq(profiles.id, user.id)))[0]?.email).toBe(user.email);
    expect(await db.select().from(workspace_members).where(eq(workspace_members.workspace_id, ws.id))).toHaveLength(1);
    const rules = await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, ws.id));
    expect(rules.map((r) => r.category).sort()).toEqual(["cost_overage", "forecast_breach", "integration_health", "quota_threshold"]);
    expect(rules.find((r) => r.category === "quota_threshold")?.thresholds).toEqual([
      { percent: 50, severity: "info" },
      { percent: 75, severity: "warning" },
      { percent: 90, severity: "critical" },
      { percent: 100, severity: "limit_reached" },
    ]);
  });

  it("is idempotent, even when first requests race", async () => {
    const { ensureUserWorkspace } = await import("@/db/bootstrap");
    const { db } = await import("@/db/client");
    const { workspaces } = await import("@/db/schema");
    const user = newUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureUserWorkspace(user)));
    expect(new Set(results.map((w) => w.id)).size).toBe(1);
    expect(await db.select().from(workspaces).where(eq(workspaces.owner_id, user.id))).toHaveLength(1);
  });

  it("deleteUserData removes the workspace and everything under it", async () => {
    const { ensureUserWorkspace, deleteUserData } = await import("@/db/bootstrap");
    const { db } = await import("@/db/client");
    const { alert_rules, profiles, workspaces } = await import("@/db/schema");
    const user = newUser();
    const ws = await ensureUserWorkspace(user);
    await deleteUserData(user.id);
    expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(0);
    expect(await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, ws.id))).toHaveLength(0);
    expect(await db.select().from(profiles).where(eq(profiles.id, user.id))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/db/bootstrap.test.ts
```

Expected: FAIL, `Failed to resolve import "@/db/bootstrap"`.

- [ ] **Step 3: Create `src/db/bootstrap.ts`**

```ts
import { asc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import type { Json } from "./json";
import { alert_rules, audit_logs, profiles, workspace_members, workspaces } from "./schema";
import type { Row } from "./types";

const DEFAULT_QUOTA_THRESHOLDS: Json = [
  { percent: 50, severity: "info" },
  { percent: 75, severity: "warning" },
  { percent: 90, severity: "critical" },
  { percent: 100, severity: "limit_reached" },
];

/**
 * Makes sure the user has a profile and a private workspace (with owner membership and the
 * default alert rules). Replaces the old `handle_new_user()` database trigger. Safe to call
 * on every request: the common path is one indexed select.
 */
export async function ensureUserWorkspace(user: { id: string; email: string }): Promise<Row<"workspaces">> {
  const first = () => db.select().from(workspaces).where(eq(workspaces.owner_id, user.id)).orderBy(asc(workspaces.created_at)).limit(1);
  const [found] = await first();
  if (found) return found;

  return db.transaction(async (tx) => {
    // Concurrent first requests for the same user queue here; the loser finds the winner's rows.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`);
    const [again] = await tx.select().from(workspaces).where(eq(workspaces.owner_id, user.id)).orderBy(asc(workspaces.created_at)).limit(1);
    if (again) return again;

    await tx.insert(profiles).values({ id: user.id, email: user.email }).onConflictDoNothing();
    const base = user.email.split("@")[0] || "My";
    const [ws] = await tx
      .insert(workspaces)
      .values({ name: `${base}'s workspace`.slice(0, 80), owner_id: user.id })
      .returning();
    await tx.insert(workspace_members).values({ workspace_id: ws.id, user_id: user.id, role: "owner" });
    await tx.insert(alert_rules).values([
      { workspace_id: ws.id, category: "quota_threshold", thresholds: DEFAULT_QUOTA_THRESHOLDS },
      { workspace_id: ws.id, category: "forecast_breach", thresholds: [] },
      { workspace_id: ws.id, category: "cost_overage", thresholds: [] },
      { workspace_id: ws.id, category: "integration_health", thresholds: [] },
    ]);
    return ws;
  });
}

/**
 * Removes a user's workspaces (which cascades to every row under them), their profile, and
 * their id from audit entries that outlive the workspace. Replaces the cascade from auth.users.
 */
export async function deleteUserData(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(workspaces).where(eq(workspaces.owner_id, userId));
    await tx.delete(workspace_members).where(eq(workspace_members.user_id, userId));
    await tx.delete(profiles).where(eq(profiles.id, userId));
    await tx.update(audit_logs).set({ actor_id: null }).where(eq(audit_logs.actor_id, userId));
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run tests/db/bootstrap.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/bootstrap.ts tests/db/bootstrap.test.ts
git commit -m "feat(db): ensureUserWorkspace and deleteUserData replace the signup trigger and cascade

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Workspace scope, repositories and tenant-isolation tests

> Amended during execution (commits edc13d0, 008863e and the follow-up): the repositories now constrain joins to the workspace, whitelist patch keys with src/db/pick.ts, narrow patchConnection's type and add tests/db/boundaries.test.ts. The code in src/db is authoritative where it differs from the blocks below.

**Files:**
- Create: `src/db/scope.ts`, `src/db/claims.ts`, `src/db/alert-relations.ts`
- Create: `src/db/repos/inventory.ts`, `applications.ts`, `quotas.ts`, `alerts.ts`, `samples.ts`, `account.ts`
- Test: `tests/db/isolation.test.ts`

This replaces RLS. Every function in `src/db/repos/` takes a `WorkspaceScope` first and filters by `scope.workspaceId`. The repos expose only the columns and operations the old column-level grants allowed, and none of them touches `provider_credentials` or `oauth_states`.

- [ ] **Step 1: Write the failing test `tests/db/isolation.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb, useTestDb } from "../helpers/test-db";

type Ctx = { userId: string; workspaceId: string; scope: Awaited<ReturnType<typeof import("@/db/scope").requireWorkspace>> };

describe.skipIf(!hasTestDb)("workspace isolation (replaces RLS)", () => {
  const userIds: string[] = [];
  let a: Ctx;
  let b: Ctx;
  let connA: { id: string };
  let resA: { id: string };
  let appA: { id: string };
  let alertA: { id: string };
  let providerQuotaA: { id: string };

  beforeAll(async () => {
    await useTestDb();
    const { ensureUserWorkspace } = await import("@/db/bootstrap");
    const { requireWorkspace } = await import("@/db/scope");
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");

    const make = async (): Promise<Ctx> => {
      const id = randomUUID();
      userIds.push(id);
      const ws = await ensureUserWorkspace({ id, email: `iso-${id}@limitgauge.test` });
      return { userId: id, workspaceId: ws.id, scope: await requireWorkspace(id, ws.id) };
    };
    a = await make();
    b = await make();

    [connA] = await db.insert(t.provider_connections).values({ workspace_id: a.workspaceId, provider: "demo", label: "A", auth_method: "demo" }).returning();
    await db.insert(t.provider_credentials).values({ connection_id: connA.id, workspace_id: a.workspaceId, ciphertext: "v1:secret" });
    [resA] = await db
      .insert(t.provider_resources)
      .values({ workspace_id: a.workspaceId, connection_id: connA.id, provider: "demo", external_id: "x", name: "a-res", resource_type: "project" })
      .returning();
    [appA] = await db.insert(t.applications).values({ workspace_id: a.workspaceId, name: "A app" }).returning();
    [alertA] = await db
      .insert(t.alerts)
      .values({ workspace_id: a.workspaceId, category: "quota_threshold", severity: "warning", dedupe_key: "k", group_key: "g", title: "A alert", message: "m" })
      .returning();
    await db
      .insert(t.metric_definitions)
      .values({ key: "demo.database_size", provider: "demo", name: "Database size", unit: "bytes", aggregation: "gauge", scope_level: "resource", derivation: "reported" })
      .onConflictDoNothing();
    [providerQuotaA] = await db
      .insert(t.quota_rules)
      .values({ workspace_id: a.workspaceId, metric_key: "demo.database_size", scope_type: "resource", resource_id: resA.id, limit_value: 1, unit: "bytes", source: "provider" })
      .returning();
  });

  afterAll(async () => {
    const { deleteUserData } = await import("@/db/bootstrap");
    for (const id of userIds) await deleteUserData(id);
  });

  it("only issues a scope to a member of the workspace", async () => {
    const { requireWorkspace, WorkspaceAccessError } = await import("@/db/scope");
    await expect(requireWorkspace(b.userId, a.workspaceId)).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it("never returns another workspace's rows", async () => {
    const inv = await import("@/db/repos/inventory");
    const alerts = await import("@/db/repos/alerts");
    const quotas = await import("@/db/repos/quotas");
    expect(await inv.listConnections(b.scope)).toEqual([]);
    expect(await inv.listResources(b.scope)).toEqual([]);
    expect(await inv.getConnection(b.scope, connA.id)).toBeNull();
    expect(await alerts.listAlerts(b.scope, { limit: 10 })).toEqual([]);
    expect(await alerts.getAlertDetail(b.scope, alertA.id)).toBeNull();
    expect(await quotas.listQuotasWithEvaluations(b.scope)).toEqual([]);
    expect((await inv.listConnections(a.scope)).map((c) => c.id)).toEqual([connA.id]);
  });

  it("turns writes against another workspace into no-ops", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const inv = await import("@/db/repos/inventory");
    const apps = await import("@/db/repos/applications");
    const alerts = await import("@/db/repos/alerts");

    expect(await inv.setResourcesMonitored(b.scope, [resA.id], true)).toEqual([]);
    await inv.patchConnection(b.scope, connA.id, { label: "hacked" });
    await apps.deleteApplication(b.scope, appA.id);
    await alerts.acknowledgeAlert(b.scope, alertA.id);

    const [res] = await db.select().from(t.provider_resources).where(eq(t.provider_resources.id, resA.id));
    const [conn] = await db.select().from(t.provider_connections).where(eq(t.provider_connections.id, connA.id));
    const [app] = await db.select().from(t.applications).where(eq(t.applications.id, appA.id));
    const [alert] = await db.select().from(t.alerts).where(eq(t.alerts.id, alertA.id));
    expect(res.is_monitored).toBe(false);
    expect(conn.label).toBe("A");
    expect(app).toBeDefined();
    expect(alert.status).toBe("open");
  });

  it("refuses to map a foreign resource into one's own application", async () => {
    const apps = await import("@/db/repos/applications");
    const appB = await apps.createApplication(b.scope, { name: "mine", description: null });
    await expect(apps.assignResources(b.scope, appB, [resA.id])).rejects.toThrow();
  });

  it("lets a workspace move its own resources between applications", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const apps = await import("@/db/repos/applications");
    const app2 = await apps.createApplication(a.scope, { name: "second", description: null });
    await apps.assignResources(a.scope, appA.id, [resA.id]);
    await apps.assignResources(a.scope, app2, [resA.id]);
    const rows = await db.select().from(t.application_resources).where(eq(t.application_resources.resource_id, resA.id));
    expect(rows.map((r) => r.application_id)).toEqual([app2]);
  });

  it("writes only user-sourced quotas and never deletes provider quotas", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const quotas = await import("@/db/repos/quotas");
    const key = { metric_key: "demo.database_size", scope_type: "resource" as const, scopeId: resA.id, unit: "bytes" };
    const values = { limit_value: 5, overage_effect: "none", pricing_rule_id: null, notes: null, verified_at: new Date().toISOString() };

    await quotas.saveUserQuota(a.scope, key, values);
    await quotas.saveUserQuota(a.scope, key, { ...values, limit_value: 7 }); // updates, does not duplicate
    const userRows = await db.select().from(t.quota_rules).where(and(eq(t.quota_rules.workspace_id, a.workspaceId), eq(t.quota_rules.source, "user")));
    expect(userRows).toHaveLength(1);
    expect(userRows[0].limit_value).toBe(7);
    expect(userRows[0].created_by).toBe(a.userId);

    await quotas.deleteUserQuota(a.scope, providerQuotaA.id); // provider-sourced: must survive
    expect(await db.select().from(t.quota_rules).where(eq(t.quota_rules.id, providerQuotaA.id))).toHaveLength(1);
    await quotas.deleteUserQuota(a.scope, userRows[0].id);
    expect(await db.select().from(t.quota_rules).where(eq(t.quota_rules.id, userRows[0].id))).toHaveLength(0);

    await expect(quotas.saveUserQuota(b.scope, key, values)).rejects.toThrow(); // foreign resource
  });

  it("updates only the caller's workspace settings", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const account = await import("@/db/repos/account");
    await account.updateWorkspace(b.scope, { name: "B renamed" });
    const [wa] = await db.select().from(t.workspaces).where(eq(t.workspaces.id, a.workspaceId));
    const [wb] = await db.select().from(t.workspaces).where(eq(t.workspaces.id, b.workspaceId));
    expect(wb.name).toBe("B renamed");
    expect(wa.name).not.toBe("B renamed");
  });

  it("keeps stored secrets out of every repository", () => {
    const dir = "src/db/repos";
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, "utf8");
      expect(source, file).not.toMatch(/provider_credentials|oauth_states/);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/db/isolation.test.ts
```

Expected: FAIL, `Failed to resolve import "@/db/scope"`.

- [ ] **Step 3: Create `src/db/scope.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { workspace_members } from "./schema";

declare const brand: unique symbol;

/**
 * Proof that a user belongs to a workspace. The only way to obtain one is `requireWorkspace()`,
 * and every repository function takes one, so user-facing code cannot query a workspace table
 * without a workspace filter. This replaces row-level security.
 */
export type WorkspaceScope = Readonly<{ workspaceId: string; userId: string }> & { readonly [brand]: true };

export class WorkspaceAccessError extends Error {
  constructor() {
    super("You do not have access to this workspace");
    this.name = "WorkspaceAccessError";
  }
}

export async function requireWorkspace(userId: string, workspaceId: string): Promise<WorkspaceScope> {
  const [member] = await db
    .select({ workspace_id: workspace_members.workspace_id })
    .from(workspace_members)
    .where(and(eq(workspace_members.workspace_id, workspaceId), eq(workspace_members.user_id, userId)))
    .limit(1);
  if (!member) throw new WorkspaceAccessError();
  return { workspaceId, userId } as WorkspaceScope;
}
```

- [ ] **Step 4: Create `src/db/claims.ts`**

```ts
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import { notification_deliveries, provider_connections } from "./schema";
import type { Row } from "./types";

// The claim_* SQL functions lock and stamp rows atomically (FOR UPDATE SKIP LOCKED). We take
// only the ids from them and re-read the rows through Drizzle so they have the app's row shape.

const idsOf = (res: { rows: unknown[] }) => (res.rows as { id: string }[]).map((r) => r.id);

export async function claimDueConnections(limit: number): Promise<Row<"provider_connections">[]> {
  const ids = idsOf(await db.execute(sql`select id from public.claim_due_connections(${limit})`));
  return ids.length ? db.select().from(provider_connections).where(inArray(provider_connections.id, ids)) : [];
}

export async function claimConnection(connectionId: string): Promise<Row<"provider_connections"> | undefined> {
  const ids = idsOf(await db.execute(sql`select id from public.claim_connection(${connectionId}::uuid)`));
  if (!ids.length) return undefined;
  return (await db.select().from(provider_connections).where(eq(provider_connections.id, ids[0])))[0];
}

export async function claimDueDeliveries(limit: number): Promise<Row<"notification_deliveries">[]> {
  const ids = idsOf(await db.execute(sql`select id from public.claim_due_deliveries(${limit})`));
  return ids.length ? db.select().from(notification_deliveries).where(inArray(notification_deliveries.id, ids)) : [];
}
```

- [ ] **Step 5: Create `src/db/alert-relations.ts`**

```ts
import { eq, type SQL } from "drizzle-orm";
import { db } from "./client";
import { alerts, applications, provider_accounts, provider_connections, provider_resources } from "./schema";

/**
 * One alert plus the connection, resource, account and application it points at (each null
 * when unset). Same shape the PostgREST embedded select returned. `where` must already
 * constrain the workspace when called on behalf of a user (see repos/alerts.ts).
 */
export async function selectAlertWithRelations(where: SQL) {
  const [r] = await db
    .select({
      alert: alerts,
      conn: { id: provider_connections.id, label: provider_connections.label, provider: provider_connections.provider },
      res: { id: provider_resources.id, name: provider_resources.name, dashboard_url: provider_resources.dashboard_url },
      acc: { id: provider_accounts.id, name: provider_accounts.name, dashboard_url: provider_accounts.dashboard_url },
      app: { id: applications.id, name: applications.name },
    })
    .from(alerts)
    .leftJoin(provider_connections, eq(alerts.connection_id, provider_connections.id))
    .leftJoin(provider_resources, eq(alerts.resource_id, provider_resources.id))
    .leftJoin(provider_accounts, eq(alerts.account_id, provider_accounts.id))
    .leftJoin(applications, eq(alerts.application_id, applications.id))
    .where(where)
    .limit(1);
  if (!r) return null;
  return { ...r.alert, provider_connections: r.conn, provider_resources: r.res, provider_accounts: r.acc, applications: r.app };
}
```

- [ ] **Step 6: Create `src/db/repos/inventory.ts`**

```ts
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { application_resources, applications, provider_accounts, provider_connections, provider_resources, sync_runs } from "../schema";
import type { WorkspaceScope } from "../scope";
import type { NewRow, Row } from "../types";

export const listConnections = (s: WorkspaceScope) =>
  db.select().from(provider_connections).where(eq(provider_connections.workspace_id, s.workspaceId)).orderBy(asc(provider_connections.created_at));

export const listAccounts = (s: WorkspaceScope) =>
  db.select().from(provider_accounts).where(eq(provider_accounts.workspace_id, s.workspaceId)).orderBy(asc(provider_accounts.name));

export const listResources = (s: WorkspaceScope) =>
  db.select().from(provider_resources).where(eq(provider_resources.workspace_id, s.workspaceId)).orderBy(asc(provider_resources.name));

export const listApplications = (s: WorkspaceScope) =>
  db.select().from(applications).where(eq(applications.workspace_id, s.workspaceId)).orderBy(asc(applications.name));

export const listApplicationMappings = (s: WorkspaceScope) =>
  db
    .select({ application_id: application_resources.application_id, resource_id: application_resources.resource_id })
    .from(application_resources)
    .where(eq(application_resources.workspace_id, s.workspaceId));

export async function getConnection(s: WorkspaceScope, id: string): Promise<Row<"provider_connections"> | null> {
  const [row] = await db
    .select()
    .from(provider_connections)
    .where(and(eq(provider_connections.id, id), eq(provider_connections.workspace_id, s.workspaceId)))
    .limit(1);
  return row ?? null;
}

type ConnectionPatch = Partial<Omit<Row<"provider_connections">, "id" | "workspace_id" | "provider" | "created_at" | "created_by">>;

export async function patchConnection(s: WorkspaceScope, id: string, patch: ConnectionPatch): Promise<void> {
  await db
    .update(provider_connections)
    .set(patch)
    .where(and(eq(provider_connections.id, id), eq(provider_connections.workspace_id, s.workspaceId)));
}

export async function insertConnection(
  s: WorkspaceScope,
  values: Omit<NewRow<"provider_connections">, "workspace_id" | "created_by">,
): Promise<{ id: string; workspace_id: string }> {
  const [row] = await db
    .insert(provider_connections)
    .values({ ...values, workspace_id: s.workspaceId, created_by: s.userId })
    .returning({ id: provider_connections.id, workspace_id: provider_connections.workspace_id });
  return row;
}

export async function deleteConnection(s: WorkspaceScope, id: string): Promise<void> {
  await db.delete(provider_connections).where(and(eq(provider_connections.id, id), eq(provider_connections.workspace_id, s.workspaceId)));
}

/** Turns monitoring on or off. Returns the connections whose resources changed. */
export async function setResourcesMonitored(
  s: WorkspaceScope,
  ids: string[],
  monitored: boolean,
  onlyConnectionId?: string,
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .update(provider_resources)
    .set({ is_monitored: monitored })
    .where(
      and(
        inArray(provider_resources.id, ids),
        eq(provider_resources.workspace_id, s.workspaceId),
        onlyConnectionId ? eq(provider_resources.connection_id, onlyConnectionId) : undefined,
      ),
    )
    .returning({ connection_id: provider_resources.connection_id });
  return [...new Set(rows.map((r) => r.connection_id))];
}

/** Returns the account's connection id, or null when the account is not in this workspace. */
export async function setAccountCycleDay(s: WorkspaceScope, accountId: string, day: number): Promise<string | null> {
  const [row] = await db
    .update(provider_accounts)
    .set({ billing_cycle_anchor_day: day })
    .where(and(eq(provider_accounts.id, accountId), eq(provider_accounts.workspace_id, s.workspaceId)))
    .returning({ connection_id: provider_accounts.connection_id });
  return row?.connection_id ?? null;
}

export const listSyncRuns = (s: WorkspaceScope, connectionId: string, limit: number) =>
  db
    .select()
    .from(sync_runs)
    .where(and(eq(sync_runs.connection_id, connectionId), eq(sync_runs.workspace_id, s.workspaceId)))
    .orderBy(desc(sync_runs.started_at))
    .limit(limit);

/** The plan of an account, or of the account a resource belongs to. Null when not in this workspace. */
export async function getScopePlan(
  s: WorkspaceScope,
  scopeType: "account" | "resource",
  scopeId: string,
): Promise<{ plan: string | null } | null> {
  if (scopeType === "account") {
    const [row] = await db
      .select({ plan: provider_accounts.plan })
      .from(provider_accounts)
      .where(and(eq(provider_accounts.id, scopeId), eq(provider_accounts.workspace_id, s.workspaceId)))
      .limit(1);
    return row ? { plan: row.plan } : null;
  }
  const [row] = await db
    .select({ plan: provider_accounts.plan })
    .from(provider_resources)
    .leftJoin(provider_accounts, eq(provider_resources.account_id, provider_accounts.id))
    .where(and(eq(provider_resources.id, scopeId), eq(provider_resources.workspace_id, s.workspaceId)))
    .limit(1);
  return row ? { plan: row.plan ?? null } : null;
}
```

- [ ] **Step 7: Create `src/db/repos/applications.ts`**

```ts
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { application_resources, applications } from "../schema";
import type { WorkspaceScope } from "../scope";

/** Throws a unique-violation (see isUniqueViolation) when the name is already used. */
export async function createApplication(s: WorkspaceScope, v: { name: string; description: string | null }): Promise<string> {
  const [row] = await db
    .insert(applications)
    .values({ workspace_id: s.workspaceId, name: v.name, description: v.description })
    .returning({ id: applications.id });
  return row.id;
}

export async function updateApplication(s: WorkspaceScope, id: string, v: { name: string; description: string | null }): Promise<void> {
  await db
    .update(applications)
    .set(v)
    .where(and(eq(applications.id, id), eq(applications.workspace_id, s.workspaceId)));
}

export async function deleteApplication(s: WorkspaceScope, id: string): Promise<void> {
  await db.delete(applications).where(and(eq(applications.id, id), eq(applications.workspace_id, s.workspaceId)));
}

/**
 * Moves resources into an application (a resource belongs to at most one). Composite foreign
 * keys make this throw, and roll back, if the application or any resource is in another workspace.
 */
export async function assignResources(s: WorkspaceScope, applicationId: string, resourceIds: string[]): Promise<void> {
  if (!resourceIds.length) return;
  await db.transaction(async (tx) => {
    await tx
      .delete(application_resources)
      .where(and(inArray(application_resources.resource_id, resourceIds), eq(application_resources.workspace_id, s.workspaceId)));
    await tx
      .insert(application_resources)
      .values(resourceIds.map((resource_id) => ({ application_id: applicationId, resource_id, workspace_id: s.workspaceId })));
  });
}

export async function unassignResource(s: WorkspaceScope, resourceId: string): Promise<void> {
  await db
    .delete(application_resources)
    .where(and(eq(application_resources.resource_id, resourceId), eq(application_resources.workspace_id, s.workspaceId)));
}

export async function removeResourceFromApplication(s: WorkspaceScope, applicationId: string, resourceId: string): Promise<void> {
  await db
    .delete(application_resources)
    .where(
      and(
        eq(application_resources.application_id, applicationId),
        eq(application_resources.resource_id, resourceId),
        eq(application_resources.workspace_id, s.workspaceId),
      ),
    );
}
```

- [ ] **Step 8: Create `src/db/repos/quotas.ts`**

```ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "../client";
import type { Json } from "../json";
import { quota_evaluations, quota_rules } from "../schema";
import type { WorkspaceScope } from "../scope";

/** Quotas with their latest evaluation (null when not evaluated yet). */
export async function listQuotasWithEvaluations(s: WorkspaceScope) {
  const rows = await db
    .select({ quota: quota_rules, evaluation: quota_evaluations })
    .from(quota_rules)
    .leftJoin(quota_evaluations, eq(quota_evaluations.quota_rule_id, quota_rules.id))
    .where(eq(quota_rules.workspace_id, s.workspaceId))
    .orderBy(asc(quota_rules.created_at));
  return rows.map((r) => ({ ...r.quota, quota_evaluations: r.evaluation }));
}

export interface UserQuotaValues {
  limit_value: number;
  overage_effect: string;
  pricing_rule_id: string | null;
  thresholds?: Json | null;
  notes: string | null;
  plan_hint?: string | null;
  verified_at: string;
}

/**
 * Creates or updates the user's own quota for a scope. Only `source = 'user'` rows are ever
 * written or matched here: provider-reported quotas belong to the collector. Throws if the
 * account/resource is not in the workspace (composite foreign key).
 */
export async function saveUserQuota(
  s: WorkspaceScope,
  key: { metric_key: string; scope_type: "account" | "resource"; scopeId: string; unit: string },
  values: UserQuotaValues,
): Promise<void> {
  const scopeColumn = key.scope_type === "account" ? quota_rules.account_id : quota_rules.resource_id;
  const [existing] = await db
    .select({ id: quota_rules.id })
    .from(quota_rules)
    .where(
      and(
        eq(quota_rules.workspace_id, s.workspaceId),
        eq(quota_rules.metric_key, key.metric_key),
        eq(scopeColumn, key.scopeId),
        eq(quota_rules.source, "user"),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(quota_rules)
      .set(values)
      .where(and(eq(quota_rules.id, existing.id), eq(quota_rules.workspace_id, s.workspaceId), eq(quota_rules.source, "user")));
    return;
  }
  await db.insert(quota_rules).values({
    ...values,
    workspace_id: s.workspaceId,
    metric_key: key.metric_key,
    scope_type: key.scope_type,
    account_id: key.scope_type === "account" ? key.scopeId : null,
    resource_id: key.scope_type === "resource" ? key.scopeId : null,
    unit: key.unit,
    source: "user",
    created_by: s.userId,
  });
}

export async function deleteUserQuota(s: WorkspaceScope, id: string): Promise<void> {
  await db
    .delete(quota_rules)
    .where(and(eq(quota_rules.id, id), eq(quota_rules.workspace_id, s.workspaceId), eq(quota_rules.source, "user")));
}
```

- [ ] **Step 9: Create `src/db/repos/alerts.ts`**

```ts
import { and, asc, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { selectAlertWithRelations } from "../alert-relations";
import { db } from "../client";
import { alert_rules, alerts, cost_records, notification_deliveries } from "../schema";
import type { WorkspaceScope } from "../scope";
import type { Row } from "../types";

export const listAlerts = (s: WorkspaceScope, opts: { statuses?: string[]; limit: number }) =>
  db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workspace_id, s.workspaceId), opts.statuses ? inArray(alerts.status, opts.statuses) : undefined))
    .orderBy(desc(alerts.created_at))
    .limit(opts.limit);

export async function getAlert(s: WorkspaceScope, id: string): Promise<Row<"alerts"> | null> {
  const [row] = await db.select().from(alerts).where(and(eq(alerts.id, id), eq(alerts.workspace_id, s.workspaceId))).limit(1);
  return row ?? null;
}

export const getAlertDetail = (s: WorkspaceScope, id: string) =>
  selectAlertWithRelations(and(eq(alerts.id, id), eq(alerts.workspace_id, s.workspaceId))!);

export const listDeliveriesForAlert = (s: WorkspaceScope, alertId: string) =>
  db
    .select()
    .from(notification_deliveries)
    .where(and(eq(notification_deliveries.alert_id, alertId), eq(notification_deliveries.workspace_id, s.workspaceId)))
    .orderBy(asc(notification_deliveries.channel));

/** In-app notifications with the alert each one is about (null if the alert is gone). */
export async function listInbox(s: WorkspaceScope, limit: number) {
  const rows = await db
    .select({
      id: notification_deliveries.id,
      created_at: notification_deliveries.created_at,
      read_at: notification_deliveries.read_at,
      alert: { id: alerts.id, title: alerts.title, severity: alerts.severity, category: alerts.category, status: alerts.status },
    })
    .from(notification_deliveries)
    .leftJoin(alerts, eq(notification_deliveries.alert_id, alerts.id))
    .where(
      and(
        eq(notification_deliveries.workspace_id, s.workspaceId),
        eq(notification_deliveries.channel, "in_app"),
        eq(notification_deliveries.status, "sent"),
      ),
    )
    .orderBy(desc(notification_deliveries.created_at))
    .limit(limit);
  return rows.map(({ alert, ...rest }) => ({ ...rest, alerts: alert }));
}

const mine = (s: WorkspaceScope, id: string) => and(eq(alerts.id, id), eq(alerts.workspace_id, s.workspaceId));

export async function acknowledgeAlert(s: WorkspaceScope, id: string): Promise<void> {
  await db
    .update(alerts)
    .set({ status: "acknowledged", acknowledged_at: new Date().toISOString(), acknowledged_by: s.userId })
    .where(mine(s, id));
}

export async function muteAlert(s: WorkspaceScope, id: string, untilIso: string): Promise<void> {
  await db.update(alerts).set({ status: "muted", muted_until: untilIso }).where(mine(s, id));
}

export async function unmuteAlert(s: WorkspaceScope, id: string): Promise<void> {
  await db.update(alerts).set({ status: "open", muted_until: null }).where(mine(s, id));
}

/** Marks one notification read. Returns the alert it points at, or null if it is not in this workspace. */
export async function markDeliveryRead(s: WorkspaceScope, deliveryId: string): Promise<string | null> {
  const [row] = await db
    .update(notification_deliveries)
    .set({ read_at: new Date().toISOString() })
    .where(and(eq(notification_deliveries.id, deliveryId), eq(notification_deliveries.workspace_id, s.workspaceId)))
    .returning({ alert_id: notification_deliveries.alert_id });
  return row?.alert_id ?? null;
}

export async function markAllInAppRead(s: WorkspaceScope): Promise<void> {
  await db
    .update(notification_deliveries)
    .set({ read_at: new Date().toISOString() })
    .where(
      and(
        eq(notification_deliveries.workspace_id, s.workspaceId),
        eq(notification_deliveries.channel, "in_app"),
        isNull(notification_deliveries.read_at),
      ),
    );
}

export async function countOpenAlerts(s: WorkspaceScope): Promise<number> {
  const [row] = await db.select({ n: count() }).from(alerts).where(and(eq(alerts.workspace_id, s.workspaceId), eq(alerts.status, "open")));
  return row.n;
}

export async function countUnreadInApp(s: WorkspaceScope): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notification_deliveries)
    .where(
      and(
        eq(notification_deliveries.workspace_id, s.workspaceId),
        eq(notification_deliveries.channel, "in_app"),
        eq(notification_deliveries.status, "sent"),
        isNull(notification_deliveries.read_at),
      ),
    );
  return row.n;
}

export const listAlertRules = (s: WorkspaceScope) => db.select().from(alert_rules).where(eq(alert_rules.workspace_id, s.workspaceId));

type AlertRulePatch = Partial<Pick<Row<"alert_rules">, "enabled" | "thresholds" | "notify_in_app" | "notify_email">>;

export async function updateAlertRule(s: WorkspaceScope, id: string, patch: AlertRulePatch): Promise<void> {
  await db.update(alert_rules).set(patch).where(and(eq(alert_rules.id, id), eq(alert_rules.workspace_id, s.workspaceId)));
}

/** Cost records whose period has not ended yet. */
export const listFutureCosts = (s: WorkspaceScope, nowIso: string) =>
  db.select().from(cost_records).where(and(eq(cost_records.workspace_id, s.workspaceId), gt(cost_records.period_end, nowIso)));
```

- [ ] **Step 10: Create `src/db/repos/samples.ts`**

```ts
import { and, asc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../client";
import { usage_samples } from "../schema";
import type { WorkspaceScope } from "../scope";

/**
 * Usage samples from `from` onwards. Scope filters:
 * - resourceIds + accountIds: samples for either set
 * - resourceIds only: resource-level samples
 * - accountIds only: account-level samples (no resource)
 * An empty id list matches nothing, as before.
 */
export function loadSamples(
  s: WorkspaceScope,
  opts: { metricKeys?: string[]; resourceIds?: string[]; accountIds?: string[]; from: Date },
) {
  const where: (SQL | undefined)[] = [eq(usage_samples.workspace_id, s.workspaceId), gte(usage_samples.bucket_start, opts.from.toISOString())];
  if (opts.metricKeys?.length) where.push(inArray(usage_samples.metric_key, opts.metricKeys));
  if (opts.resourceIds && opts.accountIds) {
    const either = [
      opts.resourceIds.length ? inArray(usage_samples.resource_id, opts.resourceIds) : undefined,
      opts.accountIds.length ? inArray(usage_samples.account_id, opts.accountIds) : undefined,
    ].filter((c): c is SQL => c !== undefined);
    if (either.length) where.push(or(...either));
  } else if (opts.resourceIds) {
    where.push(opts.resourceIds.length ? inArray(usage_samples.resource_id, opts.resourceIds) : sql`false`);
  } else if (opts.accountIds) {
    where.push(isNull(usage_samples.resource_id));
    where.push(opts.accountIds.length ? inArray(usage_samples.account_id, opts.accountIds) : sql`false`);
  }
  return db
    .select({
      metric_key: usage_samples.metric_key,
      resource_id: usage_samples.resource_id,
      account_id: usage_samples.account_id,
      bucket_start: usage_samples.bucket_start,
      bucket_end: usage_samples.bucket_end,
      value: usage_samples.value,
      observed_at: usage_samples.observed_at,
      collected_at: usage_samples.collected_at,
      quality: usage_samples.quality,
      source: usage_samples.source,
      dimensions: usage_samples.dimensions,
    })
    .from(usage_samples)
    .where(and(...where))
    .orderBy(asc(usage_samples.bucket_start), asc(usage_samples.id));
}
```

- [ ] **Step 11: Create `src/db/repos/account.ts`**

```ts
import { eq } from "drizzle-orm";
import { db } from "../client";
import { profiles, workspaces } from "../schema";
import type { WorkspaceScope } from "../scope";
import type { Row } from "../types";

export async function getProfile(s: WorkspaceScope): Promise<Row<"profiles"> | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, s.userId)).limit(1);
  return row ?? null;
}

export async function setDisplayName(s: WorkspaceScope, name: string | null): Promise<void> {
  await db.update(profiles).set({ display_name: name }).where(eq(profiles.id, s.userId));
}

/** The workspace columns a user may change (the same set the old column grants allowed). */
export type WorkspacePatch = Partial<
  Pick<Row<"workspaces">, "name" | "notify_in_app" | "notify_email" | "email_min_severity" | "alert_email" | "stale_after_hours">
>;

export async function updateWorkspace(s: WorkspaceScope, patch: WorkspacePatch): Promise<void> {
  await db.update(workspaces).set(patch).where(eq(workspaces.id, s.workspaceId));
}
```

- [ ] **Step 12: Run the isolation tests and confirm they pass**

```bash
npx vitest run tests/db
```

Expected: all `tests/db` files pass (parity 1, bootstrap 3, isolation 8).

- [ ] **Step 13: Commit**

```bash
git add src/db tests/db
git commit -m "feat(db): workspace scope and repositories replace RLS, with isolation tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Authentication (Neon Auth) and session

**Files:**
- Create: `src/lib/auth/server.ts`, `src/app/api/auth/[...path]/route.ts`
- Modify: `src/lib/session.ts`, `src/proxy.ts`, `src/app/page.tsx`, `src/app/auth/signout/route.ts`, `src/app/(auth)/actions.ts`, `src/app/(auth)/reset-password/page.tsx`, `src/app/(auth)/login/page.tsx`
- Delete: `src/app/auth/callback/route.ts`

After this task the sign-up, sign-in, sign-out and password-reset pages work against Neon Auth. The signed-in app pages still import the old Supabase client and are ported in Tasks 8–10, so you can test sign-up and the redirect to `/home` but not the pages behind it.

- [ ] **Step 1: Create `src/lib/auth/server.ts`**

```ts
import { createNeonAuth } from "@neondatabase/auth/next/server";

/** Neon Auth (managed Better Auth). Server-side only: sessions, sign-in/out and the proxy handler. */
export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});
```

- [ ] **Step 2: Create `src/app/api/auth/[...path]/route.ts`**

```ts
import { auth } from "@/lib/auth/server";

export const { GET, POST } = auth.handler();
```

- [ ] **Step 3: Confirm the SDK's method names**

```bash
grep -rhoE "\b(requestPasswordReset|forgetPassword|resetPassword|changePassword|deleteUser)\b" node_modules/@neondatabase/auth/dist --include='*.d.ts' | sort | uniq -c
```

Expected: `requestPasswordReset`, `resetPassword`, `changePassword` and `deleteUser` all appear. **If `requestPasswordReset` is absent but `forgetPassword` is present, use `forgetPassword` in Step 7** (same arguments). If `deleteUser` or `changePassword` are absent, stop and report it: Task 9 depends on them.

- [ ] **Step 4: Rewrite `src/lib/session.ts`**

```ts
import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ensureUserWorkspace } from "@/db/bootstrap";
import { requireWorkspace } from "@/db/scope";
import { auth } from "@/lib/auth/server";

/**
 * The signed-in user, their workspace and a WorkspaceScope for querying it.
 * MVP: one workspace per user, created on first sign-in.
 */
export const getSession = cache(async () => {
  const { data } = await auth.getSession();
  const authUser = data?.user;
  if (!authUser) redirect("/login");
  const user = { id: authUser.id, email: authUser.email };
  const workspace = await ensureUserWorkspace(user);
  const scope = await requireWorkspace(user.id, workspace.id);
  return { user, workspace, scope };
});

export type Session = Awaited<ReturnType<typeof getSession>>;
```

- [ ] **Step 5: Rewrite `src/proxy.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";

const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password", "/auth", "/api/auth", "/api/cron", "/api/integrations"];

// Keeps signed-out users away from app pages. Authorization itself is enforced by workspace
// scopes (src/db/scope.ts) and server checks.
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = path === "/" || PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (isPublic) return NextResponse.next();

  const { data } = await auth.getSession();
  if (!data?.user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
```

- [ ] **Step 6: Update the root page and sign-out route**

`src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function Root() {
  const { data } = await auth.getSession();
  redirect(data?.user ? "/home" : "/login");
}
```

`src/app/auth/signout/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";

export async function POST(request: NextRequest) {
  await auth.signOut();
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), { status: 303 });
}
```

Delete the email-link callback, which Supabase needed and Neon Auth does not:

```bash
git rm src/app/auth/callback/route.ts
```

- [ ] **Step 7: Rewrite `src/app/(auth)/actions.ts`**

```ts
"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import { appUrl, safeNext } from "@/lib/urls";

export type AuthState = { error?: string; ok?: string } | undefined;

const credentials = z.object({
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(8, "Use at least 8 characters").max(128),
});

const EXPIRED_LINK = "Your reset link is invalid or has expired. Request a new one.";

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const { error } = await auth.signIn.email(parsed.data);
  if (error) {
    if (error.status === 429) return { error: "Too many attempts. Wait a moment and try again." };
    // Same message for unknown email and wrong password: no account enumeration.
    return { error: "Incorrect email or password." };
  }
  redirect(safeNext(form.get("next")));
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const { error } = await auth.signUp.email({ ...parsed.data, name: parsed.data.email.split("@")[0] || "User" });
  if (error) {
    if (error.status === 429) return { error: "Too many sign-up attempts. Try again later." };
    return { error: error.message ?? "Could not create the account." };
  }
  // Email verification is off, so the account is signed in. The workspace is created on first load.
  redirect("/home");
}

export async function requestPasswordReset(_: AuthState, form: FormData): Promise<AuthState> {
  const email = z.email().safeParse(form.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  const { error } = await auth.requestPasswordReset({ email: email.data, redirectTo: appUrl("/reset-password") });
  if (error?.status === 429) return { error: "Too many requests. Wait a minute and try again." };
  // Always the same answer, whether or not the account exists.
  return { ok: "If an account exists for that address, a reset link is on its way." };
}

export async function updatePassword(_: AuthState, form: FormData): Promise<AuthState> {
  const token = z.string().min(1).safeParse(form.get("token"));
  if (!token.success) return { error: EXPIRED_LINK };
  const password = z.string().min(8).max(128).safeParse(form.get("password"));
  if (!password.success) return { error: "Use at least 8 characters." };
  if (form.get("password") !== form.get("confirm")) return { error: "The passwords do not match." };
  const { error } = await auth.resetPassword({ newPassword: password.data, token: token.data });
  if (error) return { error: EXPIRED_LINK };
  redirect("/login?reset=1");
}
```

- [ ] **Step 8: Update the reset-password and login pages**

Replace `src/app/(auth)/reset-password/page.tsx` entirely (the reset link now carries a `token` instead of creating a session):

```tsx
import Link from "next/link";
import { Notice } from "@/components/ui";
import { updatePassword } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;
  if (typeof token !== "string" || typeof error === "string") {
    return (
      <>
        <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1>
        <div className="my-4">
          <Notice tone="crit">This reset link is invalid or has expired.</Notice>
        </div>
        <Link className="text-sm text-accent hover:underline" href="/forgot-password">
          Request a new link
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1>
      <p className="mb-5 text-sm text-muted">You followed a recovery link. Set a new password to continue.</p>
      <AuthForm
        action={updatePassword}
        submit="Update password"
        hidden={{ token }}
        fields={[
          { name: "password", label: "New password", type: "password", autoComplete: "new-password", hint: "(8+ characters)" },
          { name: "confirm", label: "Confirm password", type: "password", autoComplete: "new-password" },
        ]}
      />
    </>
  );
}
```

In `src/app/(auth)/login/page.tsx` change the destructuring line to include `reset`:

```tsx
  const { next, error, deleted, reset } = await searchParams;
```

and add this block directly after the `{deleted ? (...) : null}` block:

```tsx
      {reset ? (
        <div className="mb-4">
          <Notice tone="ok">Password updated. Sign in with your new password.</Notice>
        </div>
      ) : null}
```

- [ ] **Step 9: Smoke test sign-up against Neon Auth**

Start the dev server (`npm run dev`, port 3100) and open `http://localhost:3100/signup`. Create an account (for example `neon-test@limitgauge.test` with a throwaway password, which you may also save as `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` in `.env.local`).

Expected: the browser redirects to `/home` (which errors for now because the app pages still use Supabase; that is fine). Then confirm the user landed in Neon Auth and see the id column type:

```bash
psql "$(node --env-file=.env.local -p 'process.env.DATABASE_URL_UNPOOLED')" -c 'select id, email from neon_auth."user" order by "createdAt" desc limit 3' -c '\d neon_auth."user"'
```

Expected: one row with the email you used. Our `user_id` columns are `text`, so either a `uuid` or `text` id works. Also check `http://localhost:3100/` redirects to `/login` when signed out (clear cookies) and that `/login` and `/signup` render.

**If the dev server logs an error from `auth.getSession()` inside `proxy.ts`** (for example a message that `cookies` was called outside a request scope), replace the body of `src/proxy.ts` with Neon's own middleware and accept that the `?next=` return path is dropped:

```ts
import { auth } from "@/lib/auth/server";

export default auth.middleware({ loginUrl: "/login" });

export const config = {
  matcher: ["/((?!login|signup|forgot-password|reset-password|auth|api/auth|api/cron|api/integrations|_next/static|_next/image|favicon.ico|icon.svg|$).+)"],
};
```

- [ ] **Step 10: Commit**

```bash
git add -A src
git commit -m "feat(auth): replace Supabase Auth with Neon Auth

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Port the background jobs to Drizzle

**Files:**
- Modify: `src/lib/jobs/db.ts`, `credentials.ts`, `reference.ts`, `scheduler.ts`, `notify.ts`, `sync.ts`, `recalc.ts`, `src/lib/audit.ts`

Jobs use `db` directly (deviation 3). The existing tests that touch these modules (`tests/engine.test.ts`: `failurePlan`, `effectiveQuotaIds`) must keep passing, which proves the exports survived. Rules used throughout:

| supabase-js | Drizzle |
|---|---|
| `.select("*").eq(a, x)` | `db.select().from(t).where(eq(t.a, x))` |
| `.in(col, ids)` | `inArray(t.col, ids)` |
| `.maybeSingle()` / `.single()` | take `[0]` / `[row]` |
| `.upsert(rows, { onConflict })` | `.insert(t).values(rows).onConflictDoUpdate({ target, set: excludedFrom(t, rows[0], targetKeys) })` |
| `.upsert(..., { ignoreDuplicates })` | `.onConflictDoNothing({ target })` |
| `.update(p).eq(...)` | `db.update(t).set(p).where(...)` |
| `{ error }` from `.insert` | the call throws; use `isUniqueViolation(e)` for code `23505` |
| `.rpc("claim_…")` | `claimDueConnections` / `claimConnection` / `claimDueDeliveries` from `src/db/claims.ts` |
| paging with `fetchAll` | not needed: Drizzle returns every row |

- [ ] **Step 1: Run the baseline tests**

```bash
npx vitest run tests/engine.test.ts
```

Expected: PASS (this file only imports `failurePlan` and `effectiveQuotaIds`; it must still pass at the end of this task).

- [ ] **Step 2: Replace `src/lib/jobs/db.ts`** (only `chunk` is still needed)

```ts
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

- [ ] **Step 3: Replace `src/lib/jobs/credentials.ts`**

The `admin` parameter is gone from all three functions.

```ts
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { provider_credentials } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { refreshTokens } from "../providers/supabase/oauth";
import { type Credentials, ProviderError } from "../providers/types";

export async function saveCredentials(connection: { id: string; workspace_id: string }, credentials: Credentials): Promise<void> {
  const values = {
    connection_id: connection.id,
    workspace_id: connection.workspace_id,
    ciphertext: encryptSecret(JSON.stringify(credentials), connection.id),
    key_version: 1,
    expires_at: credentials.kind === "oauth" ? credentials.expiresAt : null,
  };
  try {
    await db
      .insert(provider_credentials)
      .values(values)
      .onConflictDoUpdate({
        target: provider_credentials.connection_id,
        set: { workspace_id: values.workspace_id, ciphertext: values.ciphertext, key_version: 1, expires_at: values.expires_at },
      });
  } catch (e) {
    throw new Error(`Storing credentials failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function deleteCredentials(connectionId: string): Promise<Credentials | null> {
  const existing = await readCredentials(connectionId).catch(() => null);
  await db.delete(provider_credentials).where(eq(provider_credentials.connection_id, connectionId));
  return existing;
}

async function readCredentials(connectionId: string): Promise<Credentials | null> {
  const [row] = await db
    .select({ ciphertext: provider_credentials.ciphertext })
    .from(provider_credentials)
    .where(eq(provider_credentials.connection_id, connectionId))
    .limit(1);
  if (!row) return null;
  return JSON.parse(decryptSecret(row.ciphertext, connectionId)) as Credentials;
}

/** Decrypts stored credentials, refreshing OAuth tokens that expire within 5 minutes. */
export async function loadCredentials(
  connection: { id: string; workspace_id: string; provider: string },
  now = new Date(),
): Promise<Credentials> {
  const creds = await readCredentials(connection.id);
  if (!creds) throw new ProviderError("auth_invalid", "No stored credentials for this connection");
  if (creds.kind === "oauth" && Date.parse(creds.expiresAt) - now.getTime() < 5 * 60_000) {
    if (connection.provider !== "supabase") throw new ProviderError("auth_expired", "OAuth token expired");
    const refreshed = await refreshTokens(creds.refreshToken);
    const next: Credentials = { kind: "oauth", ...refreshed };
    await saveCredentials(connection, next);
    return next;
  }
  return creds;
}
```

- [ ] **Step 4: Replace `src/lib/jobs/reference.ts`**

```ts
import { db } from "../../db/client";
import { metric_definitions, pricing_rules } from "../../db/schema";
import { excludedFrom } from "../../db/sql";
import { allMetricDefinitions, allPricingRules } from "../providers/registry";

let synced: Promise<void> | null = null;

/**
 * Metric definitions and pricing rules are defined in code (versioned with the adapters)
 * and mirrored into the database so quotas, samples and costs can reference them.
 */
export function ensureReferenceData(): Promise<void> {
  synced ??= (async () => {
    const updated_at = new Date().toISOString();
    const metrics = allMetricDefinitions().map((m) => ({
      key: m.key,
      provider: m.provider,
      name: m.name,
      description: m.description,
      unit: m.unit,
      aggregation: m.aggregation,
      scope_level: m.scopeLevel,
      derivation: m.derivation,
      supported: m.supported,
      unsupported_reason: m.unsupportedReason ?? null,
      updated_at,
    }));
    if (metrics.length) {
      await db
        .insert(metric_definitions)
        .values(metrics)
        .onConflictDoUpdate({ target: metric_definitions.key, set: excludedFrom(metric_definitions, metrics[0], ["key"]) });
    }

    const rules = allPricingRules().map((r) => ({
      id: r.id,
      provider: r.provider,
      metric_key: r.metricKey,
      plan: r.plan,
      version: r.version,
      currency: r.currency,
      included_quantity: r.includedQuantity,
      unit_price: r.unitPrice,
      unit_size: r.unitSize,
      billing_mode: r.billingMode,
      source_url: r.sourceUrl ?? null,
      verified_at: r.verifiedAt,
      notes: r.notes ?? null,
      updated_at,
    }));
    if (rules.length) {
      await db
        .insert(pricing_rules)
        .values(rules)
        .onConflictDoUpdate({ target: pricing_rules.id, set: excludedFrom(pricing_rules, rules[0], ["id"]) });
    }
  })().catch((e) => {
    synced = null; // retry next time
    throw e;
  });
  return synced;
}
```

- [ ] **Step 5: Replace `src/lib/audit.ts`**

```ts
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client";
import type { Json } from "../db/json";
import { audit_logs } from "../db/schema";

/** Record a security-relevant action. Never pass secrets in `details`. */
export async function audit(entry: {
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(audit_logs).values({
      workspace_id: entry.workspaceId,
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: (entry.details ?? {}) as Json,
    });
  } catch (e) {
    console.error(`[audit] failed to record ${entry.action}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** How many audit entries with one of `actions` the workspace has recorded since `sinceIso`. */
export async function countRecentAudits(workspaceId: string, actions: string[], sinceIso: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(audit_logs)
    .where(and(eq(audit_logs.workspace_id, workspaceId), inArray(audit_logs.action, actions), gte(audit_logs.created_at, sinceIso)));
  return row.n;
}
```

- [ ] **Step 6: Edit `src/lib/jobs/scheduler.ts`**

Replace the first two import lines (`import { adminClient } …` and `import { must } from "./db";`) with:

```ts
import { ne } from "drizzle-orm";
import { claimDueConnections } from "../../db/claims";
import { db } from "../../db/client";
import { provider_connections } from "../../db/schema";
```

In `runSchedulerTick`, delete `const admin = adminClient();` and replace the `due` line with:

```ts
    const due = await claimDueConnections(10);
```

Replace the health-sweep block (`const rows = must(await admin.from("provider_connections")…);` through `for (const r of rows) touched.add(r.workspace_id);`) with:

```ts
      const rows = await db
        .selectDistinct({ workspace_id: provider_connections.workspace_id })
        .from(provider_connections)
        .where(ne(provider_connections.status, "disconnected"));
      for (const r of rows) touched.add(r.workspace_id);
```

- [ ] **Step 7: Replace `src/lib/jobs/notify.ts`**

```ts
import { eq } from "drizzle-orm";
import { selectAlertWithRelations } from "../../db/alert-relations";
import { claimDueDeliveries } from "../../db/claims";
import { db } from "../../db/client";
import { alerts, notification_deliveries } from "../../db/schema";
import { renderAlertEmail } from "../email/alert-email";
import { sendEmail } from "../email/transport";
import { getMetric, PROVIDER_NAMES } from "../providers/registry";

const MAX_ATTEMPTS = 5;

/**
 * Sends due email deliveries. Each delivery row is unique per (alert, channel), so a retry
 * after a crash or failure can never produce a second alert or a second row.
 */
export async function deliverDueNotifications(): Promise<{ sent: number; failed: number; skipped: number }> {
  const claimed = await claimDueDeliveries(25);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const update = (id: string, patch: Partial<typeof notification_deliveries.$inferInsert>) =>
    db.update(notification_deliveries).set(patch).where(eq(notification_deliveries.id, id));

  for (const d of claimed) {
    const alert = await selectAlertWithRelations(eq(alerts.id, d.alert_id));
    if (!alert || alert.status === "muted" || alert.status === "resolved" || !d.recipient) {
      await update(d.id, { status: "skipped", last_error: !d.recipient ? "No recipient" : `Alert is ${alert?.status ?? "deleted"}` });
      skipped++;
      continue;
    }

    try {
      const conn = alert.provider_connections;
      await sendEmail(
        renderAlertEmail({
          to: d.recipient,
          appUrl: process.env.APP_URL ?? "http://localhost:3000",
          alert,
          metricName: alert.metric_key ? (getMetric(alert.metric_key)?.name ?? alert.metric_key) : null,
          providerLabel: conn ? `${PROVIDER_NAMES[conn.provider] ?? conn.provider} · ${conn.label}` : null,
          scopeName: alert.provider_resources?.name ?? alert.provider_accounts?.name ?? null,
          applicationName: alert.applications?.name ?? null,
        }),
      );
      await update(d.id, { status: "sent", sent_at: new Date().toISOString(), last_error: null });
      sent++;
    } catch (e) {
      const giveUp = d.attempts >= MAX_ATTEMPTS;
      await update(d.id, {
        status: giveUp ? "failed" : "pending",
        last_error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        next_attempt_at: new Date(Date.now() + 2 ** d.attempts * 60_000).toISOString(),
      });
      failed++;
    }
  }
  return { sent, failed, skipped };
}
```

- [ ] **Step 8: Port `src/lib/jobs/sync.ts`**

Replace lines 1–15 (all imports and `type Connection = …`) with:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { claimConnection } from "../../db/claims";
import { db } from "../../db/client";
import type { Json } from "../../db/json";
import { cost_records, provider_accounts, provider_connections, provider_resources, quota_rules, sync_runs, usage_samples } from "../../db/schema";
import { excludedFrom } from "../../db/sql";
import type { Row } from "../../db/types";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { findPricingRule, getAdapter, getMetric } from "../providers/registry";
import {
  type CollectResult,
  type Discovery,
  type MetricOutcome,
  ProviderError,
  type ProviderErrorCode,
  type ScopeRef,
} from "../providers/types";
import type { ConnectionStatus } from "../types";
import { loadCredentials } from "./credentials";
import { chunk } from "./db";
import { ensureReferenceData } from "./reference";

type Connection = Row<"provider_connections">;
```

Replace the whole `runConnectionSync` function (from its doc comment to its closing brace, before `failurePlan`'s doc comment) with:

```ts
/**
 * Discover and collect one connection (PRD Workflow B / D).
 * Never deletes historical data; a failed run only records the failure and backs off.
 */
export async function runConnectionSync(
  connectionId: string,
  trigger: SyncTrigger,
  opts: { alreadyClaimed?: boolean; now?: Date } = {},
): Promise<SyncSummary> {
  const now = opts.now ?? new Date();
  await ensureReferenceData();

  const conn: Connection | undefined = opts.alreadyClaimed
    ? (await db.select().from(provider_connections).where(eq(provider_connections.id, connectionId)).limit(1))[0]
    : await claimConnection(connectionId);
  if (!conn) return { connectionId, workspaceId: "", status: "skipped", message: "Connection is busy or disconnected" };

  const [run] = await db
    .insert(sync_runs)
    .values({ workspace_id: conn.workspace_id, connection_id: conn.id, trigger })
    .returning({ id: sync_runs.id });

  const stats: Record<string, number> = {};
  try {
    const adapter = getAdapter(conn.provider);
    if (!adapter) throw new ProviderError("unknown", `No integration available for provider "${conn.provider}"`, { retryable: false });

    const credentials = await loadCredentials(conn, now);
    const ctx = { credentials, now };

    const discoveryDue =
      trigger !== "scheduled" || !conn.last_discovery_at || now.getTime() - Date.parse(conn.last_discovery_at) > DISCOVERY_EVERY_MS;
    if (discoveryDue) {
      const discovery = await adapter.discover(ctx);
      Object.assign(stats, await persistDiscovery(conn, discovery, now));
    }

    const target = await buildTarget(conn, now);
    let outcomes: MetricOutcome[] = [];
    if (target.resources.length > 0) {
      const result = await adapter.collect(ctx, target.collect);
      Object.assign(stats, await persistCollection(conn, result, target, run.id, now));
      outcomes = result.outcomes;
    }

    const failed = outcomes.filter((o) => o.status === "error");
    const permissionGaps = failed.filter((o) => o.errorCode === "permission_denied").length;
    const detail = failed.length
      ? `${failed.length} metric reading${failed.length === 1 ? "" : "s"} failed${permissionGaps ? ` (${permissionGaps} due to missing permissions)` : ""}. See the capability table.`
      : null;

    await updateConnection(conn, {
      status: "connected",
      status_detail: detail,
      last_success_at: now.toISOString(),
      last_discovery_at: discoveryDue ? now.toISOString() : conn.last_discovery_at,
      consecutive_failures: 0,
      last_error_code: null,
      next_sync_at: new Date(now.getTime() + conn.sync_interval_minutes * 60_000).toISOString(),
      capabilities: mergeOutcomes(conn.capabilities, adapter.capabilities, outcomes, now),
    });

    const status = failed.length ? "partial" : "succeeded";
    await db
      .update(sync_runs)
      .set({ status, finished_at: new Date().toISOString(), stats: { ...stats, metricErrors: failed.length } })
      .where(eq(sync_runs.id, run.id));
    return { connectionId: conn.id, workspaceId: conn.workspace_id, status };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("unknown", e instanceof Error ? e.message : String(e), { retryable: false });
    const plan = failurePlan(conn, err, now);
    await updateConnection(conn, {
      status: plan.status,
      status_detail: plan.detail,
      consecutive_failures: conn.consecutive_failures + 1,
      last_error_code: err.code,
      next_sync_at: plan.nextSyncAt?.toISOString() ?? null,
    });
    await db
      .update(sync_runs)
      .set({ status: "failed", finished_at: new Date().toISOString(), error_code: err.code, error_message: err.message.slice(0, 500), stats })
      .where(eq(sync_runs.id, run.id));
    return { connectionId: conn.id, workspaceId: conn.workspace_id, status: "failed", errorCode: err.code, message: err.message };
  }
}
```

Replace `updateConnection` with:

```ts
async function updateConnection(conn: Connection, patch: Partial<Connection>) {
  const statusChanged = patch.status !== undefined && patch.status !== conn.status;
  await db
    .update(provider_connections)
    .set({ ...patch, ...(statusChanged ? { status_changed_at: new Date().toISOString() } : {}), locked_until: null })
    .where(eq(provider_connections.id, conn.id));
}
```

Replace `persistDiscovery` with:

```ts
async function persistDiscovery(conn: Connection, d: Discovery, now: Date) {
  const seen = now.toISOString();
  if (d.accounts.length) {
    const rows = d.accounts.map((a) => ({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      provider: conn.provider,
      external_id: a.externalId,
      name: a.name,
      account_type: a.accountType,
      plan: a.plan,
      billing_currency: a.billingCurrency,
      dashboard_url: a.dashboardUrl,
      metadata: (a.metadata ?? {}) as Json,
      status: "active",
      last_seen_at: seen,
    }));
    await db
      .insert(provider_accounts)
      .values(rows)
      .onConflictDoUpdate({
        target: [provider_accounts.connection_id, provider_accounts.external_id],
        set: excludedFrom(provider_accounts, rows[0], ["connection_id", "external_id"]),
      });
  }
  const accounts = await db
    .select({ id: provider_accounts.id, external_id: provider_accounts.external_id, status: provider_accounts.status })
    .from(provider_accounts)
    .where(eq(provider_accounts.connection_id, conn.id));
  const accountIds = new Map(accounts.map((a) => [a.external_id, a.id]));
  const goneAccounts = accounts.filter((a) => !d.accounts.some((x) => x.externalId === a.external_id) && a.status === "active");
  if (goneAccounts.length) {
    await db.update(provider_accounts).set({ status: "inaccessible" }).where(inArray(provider_accounts.id, goneAccounts.map((a) => a.id)));
  }

  if (d.resources.length) {
    for (const part of chunk(d.resources, 500)) {
      const rows = part.map((r) => ({
        workspace_id: conn.workspace_id,
        connection_id: conn.id,
        account_id: r.accountExternalId ? (accountIds.get(r.accountExternalId) ?? null) : null,
        provider: conn.provider,
        external_id: r.externalId,
        name: r.name,
        resource_type: r.resourceType,
        region: r.region,
        plan: r.plan,
        provider_status: r.providerStatus,
        status: r.status,
        dashboard_url: r.dashboardUrl,
        metadata: (r.metadata ?? {}) as Json,
        last_seen_at: seen,
      }));
      // is_monitored is not in the row, so a user's monitoring choice survives re-discovery.
      await db
        .insert(provider_resources)
        .values(rows)
        .onConflictDoUpdate({
          target: [provider_resources.connection_id, provider_resources.resource_type, provider_resources.external_id],
          set: excludedFrom(provider_resources, rows[0], ["connection_id", "resource_type", "external_id"]),
        });
    }
  }
  const resources = await db
    .select({
      id: provider_resources.id,
      external_id: provider_resources.external_id,
      resource_type: provider_resources.resource_type,
      status: provider_resources.status,
    })
    .from(provider_resources)
    .where(eq(provider_resources.connection_id, conn.id));
  const seenKeys = new Set(d.resources.map((r) => `${r.resourceType}|${r.externalId}`));
  const gone = resources.filter((r) => !seenKeys.has(`${r.resource_type}|${r.external_id}`) && r.status === "active");
  if (gone.length) {
    await db.update(provider_resources).set({ status: "inaccessible" }).where(inArray(provider_resources.id, gone.map((r) => r.id)));
  }
  return { accountsDiscovered: d.accounts.length, resourcesDiscovered: d.resources.length, resourcesNowInaccessible: gone.length };
}
```

In `buildTarget`, change the signature to `async function buildTarget(conn: Connection, now: Date): Promise<Target> {` and replace the two `must(await admin…)` statements (`const accounts = …` and `const resources = …`) with:

```ts
  const accounts = await db
    .select({
      id: provider_accounts.id,
      external_id: provider_accounts.external_id,
      plan: provider_accounts.plan,
      billing_cycle_anchor_day: provider_accounts.billing_cycle_anchor_day,
    })
    .from(provider_accounts)
    .where(and(eq(provider_accounts.connection_id, conn.id), eq(provider_accounts.status, "active")));
  const resources = await db
    .select({
      id: provider_resources.id,
      external_id: provider_resources.external_id,
      account_id: provider_resources.account_id,
      provider_status: provider_resources.provider_status,
      last_collected_at: provider_resources.last_collected_at,
    })
    .from(provider_resources)
    .where(and(eq(provider_resources.connection_id, conn.id), eq(provider_resources.status, "active"), eq(provider_resources.is_monitored, true)));
```

Replace `persistCollection` with:

```ts
async function persistCollection(conn: Connection, result: CollectResult, target: Target, runId: string, now: Date) {
  const resByExt = new Map(target.resources.map((r) => [r.externalId, r]));
  const accByExt = new Map(target.accounts.map((a) => [a.externalId, a]));
  const resolve = (scope: ScopeRef): { account_id: string | null; resource_id: string | null } | null => {
    if ("resourceExternalId" in scope) {
      const r = resByExt.get(scope.resourceExternalId);
      return r ? { account_id: r.accountId, resource_id: r.id } : null;
    }
    const a = accByExt.get(scope.accountExternalId);
    return a ? { account_id: a.id, resource_id: null } : null;
  };

  // Usage samples: one row per (scope, metric, bucket). Re-collection overwrites.
  const samples: (typeof usage_samples.$inferInsert)[] = [];
  for (const o of result.observations) {
    const metric = getMetric(o.metricKey);
    const ids = resolve(o.scope);
    if (!metric || !ids || !Number.isFinite(o.value) || o.value < 0) continue;
    samples.push({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      // Resource-level samples keep account_id null so the unique key stays one row per resource.
      account_id: ids.resource_id ? null : ids.account_id,
      resource_id: ids.resource_id,
      metric_key: o.metricKey,
      bucket_start: o.bucketStart.toISOString(),
      bucket_end: o.bucketEnd.toISOString(),
      value: o.value,
      unit: metric.unit,
      aggregation: metric.aggregation,
      observed_at: o.observedAt.toISOString(),
      collected_at: now.toISOString(),
      source: o.source,
      quality: o.quality,
      dimensions: (o.dimensions ?? null) as Json | null,
      sync_run_id: runId,
    });
  }
  const sampleKey = ["connection_id", "metric_key", "account_id", "resource_id", "bucket_start"];
  for (const part of chunk(samples, 500)) {
    await db
      .insert(usage_samples)
      .values(part)
      .onConflictDoUpdate({
        target: [usage_samples.connection_id, usage_samples.metric_key, usage_samples.account_id, usage_samples.resource_id, usage_samples.bucket_start],
        set: excludedFrom(usage_samples, part[0], sampleKey),
      });
  }

  // Provider-reported quotas. User-configured quotas live in separate rows and take precedence.
  const quotas: (typeof quota_rules.$inferInsert)[] = [];
  for (const q of result.quotas) {
    const ids = resolve(q.scope);
    if (!ids || !getMetric(q.metricKey)) continue;
    const scopeType = "resourceExternalId" in q.scope ? "resource" : "account";
    const plan = scopeType === "account" ? target.accounts.find((a) => a.id === ids.account_id)?.plan : undefined;
    quotas.push({
      workspace_id: conn.workspace_id,
      metric_key: q.metricKey,
      scope_type: scopeType,
      account_id: scopeType === "account" ? ids.account_id : null,
      resource_id: scopeType === "resource" ? ids.resource_id : null,
      limit_value: q.limit,
      unit: q.unit,
      source: "provider",
      overage_effect: q.overageEffect,
      pricing_rule_id: findPricingRule(q.metricKey, plan)?.id ?? null,
      notes: q.notes ?? null,
      verified_at: now.toISOString(),
    });
  }
  if (quotas.length) {
    await db
      .insert(quota_rules)
      .values(quotas)
      .onConflictDoUpdate({
        target: [quota_rules.workspace_id, quota_rules.metric_key, quota_rules.account_id, quota_rules.resource_id, quota_rules.source],
        set: excludedFrom(quota_rules, quotas[0], ["workspace_id", "metric_key", "account_id", "resource_id", "source"]),
      });
  }

  // Provider-reported spend.
  const costs: (typeof cost_records.$inferInsert)[] = [];
  for (const c of result.costs) {
    const a = accByExt.get(c.accountExternalId);
    if (!a) continue;
    costs.push({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      account_id: a.id,
      resource_id: null,
      metric_key: null,
      period_start: c.periodStart.toISOString(),
      period_end: c.periodEnd.toISOString(),
      amount: c.amount,
      currency: c.currency,
      kind: "reported",
      calculation: { source: "provider" } as Json,
      computed_at: now.toISOString(),
    });
  }
  if (costs.length) {
    await db
      .insert(cost_records)
      .values(costs)
      .onConflictDoUpdate({
        target: [cost_records.workspace_id, cost_records.kind, cost_records.metric_key, cost_records.account_id, cost_records.resource_id, cost_records.period_start],
        set: excludedFrom(cost_records, costs[0], ["workspace_id", "kind", "metric_key", "account_id", "resource_id", "period_start"]),
      });
  }

  const collectedIds = [
    ...new Set(
      result.outcomes
        .filter((o) => o.status === "ok" && "resourceExternalId" in o.scope)
        .map((o) => resByExt.get((o.scope as { resourceExternalId: string }).resourceExternalId)?.id)
        .filter(Boolean) as string[],
    ),
  ];
  if (collectedIds.length) {
    await db.update(provider_resources).set({ last_collected_at: now.toISOString() }).where(inArray(provider_resources.id, collectedIds));
  }

  return { samplesStored: samples.length, providerQuotas: quotas.length, reportedCosts: costs.length };
}
```

- [ ] **Step 9: Port `src/lib/jobs/recalc.ts`**

Replace lines 1–24 (all imports and the `type Tables/QuotaRow/AlertRow` lines) with:

```ts
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { isUniqueViolation } from "../../db/errors";
import type { Json } from "../../db/json";
import {
  alert_rules,
  alerts,
  application_resources,
  applications,
  cost_records,
  notification_deliveries,
  profiles,
  provider_accounts,
  provider_connections,
  provider_resources,
  quota_evaluations,
  quota_rules,
  usage_samples,
  workspaces,
} from "../../db/schema";
import { excludedFrom } from "../../db/sql";
import type { Row } from "../../db/types";
import { evaluateAlerts, normalizeThresholds, type AlertCandidate, type QuotaStateForAlerts } from "../engine/alerts";
import { estimateCost, type CostEstimate } from "../engine/cost";
import { forecast, type Forecast } from "../engine/forecast";
import { isStale } from "../engine/health";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { currentUsage, dailySeries, type CurrentUsage, type UsagePoint } from "../engine/usage";
import { findPricingRule, getMetric, getPricingRule, PROVIDER_NAMES, recommendationFor } from "../providers/registry";
import {
  type AlertCategory,
  type ConnectionStatus,
  DEFAULT_THRESHOLDS,
  type MetricDefinition,
  type OverageEffect,
  SEVERITY_RANK,
  type Severity,
} from "../types";
import { formatValue } from "../units";

type QuotaRow = Row<"quota_rules">;
type AlertRow = Row<"alerts">;
```

Replace the `WorkspaceData` interface and `loadWorkspace` (from `interface WorkspaceData {` to the end of `loadWorkspace`) with:

```ts
interface WorkspaceData {
  workspace: Row<"workspaces">;
  ownerEmail: string | null;
  connections: Row<"provider_connections">[];
  accounts: Row<"provider_accounts">[];
  resources: Row<"provider_resources">[];
  appByResource: Map<string, { id: string; name: string }>;
  quotas: QuotaRow[];
  rules: Row<"alert_rules">[];
}

async function loadWorkspace(workspaceId: string): Promise<WorkspaceData | null> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) return null;
  const [owner, connections, accounts, resources, mappings, quotas, rules] = await Promise.all([
    db.select({ email: profiles.email }).from(profiles).where(eq(profiles.id, workspace.owner_id)).limit(1),
    db.select().from(provider_connections).where(eq(provider_connections.workspace_id, workspaceId)),
    db.select().from(provider_accounts).where(eq(provider_accounts.workspace_id, workspaceId)),
    db.select().from(provider_resources).where(eq(provider_resources.workspace_id, workspaceId)),
    db
      .select({ resource_id: application_resources.resource_id, id: applications.id, name: applications.name })
      .from(application_resources)
      .innerJoin(applications, eq(application_resources.application_id, applications.id))
      .where(eq(application_resources.workspace_id, workspaceId)),
    db.select().from(quota_rules).where(eq(quota_rules.workspace_id, workspaceId)),
    db.select().from(alert_rules).where(eq(alert_rules.workspace_id, workspaceId)),
  ]);
  const appByResource = new Map<string, { id: string; name: string }>();
  for (const m of mappings) appByResource.set(m.resource_id, { id: m.id, name: m.name });
  return { workspace, ownerEmail: owner[0]?.email ?? null, connections, accounts, resources, appByResource, quotas, rules };
}
```

In `computeQuotas`, change the signature to `export async function computeQuotas(data: WorkspaceData, now: Date): Promise<QuotaComputation[]> {` and replace the `const samples = metricKeys.length ? await fetchAll(…) : [];` statement (the whole expression, ending in `: [];`) with:

```ts
  const samples = metricKeys.length
    ? await db
        .select({
          metric_key: usage_samples.metric_key,
          account_id: usage_samples.account_id,
          resource_id: usage_samples.resource_id,
          bucket_start: usage_samples.bucket_start,
          bucket_end: usage_samples.bucket_end,
          value: usage_samples.value,
          observed_at: usage_samples.observed_at,
          quality: usage_samples.quality,
        })
        .from(usage_samples)
        .where(
          and(
            eq(usage_samples.workspace_id, workspace.id),
            inArray(usage_samples.metric_key, metricKeys),
            gte(usage_samples.bucket_start, new Date(earliest).toISOString()),
          ),
        )
        .orderBy(asc(usage_samples.id))
    : [];
```

In `recalculateWorkspace`, replace the first three statements (`const admin = adminClient();`, `const data = await loadWorkspace(admin, workspaceId);`, `if (!data) …`, `const computed = await computeQuotas(admin, data, now);`) with:

```ts
  const data = await loadWorkspace(workspaceId);
  if (!data) return { quotas: 0, newAlerts: 0 };
  const computed = await computeQuotas(data, now);
```

Replace the evaluations block (`// 1. Persist evaluations` through its closing `}`) with:

```ts
  // 1. Persist evaluations
  if (computed.length) {
    const rows = computed.map((c) => ({
      quota_rule_id: c.quota.id,
      workspace_id: workspaceId,
      is_effective: c.isEffective,
      current_value: c.usage.value,
      limit_value: c.quota.limit_value,
      percent_used: c.percent,
      cycle_start: c.cycle.start.toISOString(),
      cycle_end: c.cycle.end.toISOString(),
      data_updated_at: c.usage.asOf?.toISOString() ?? null,
      data_state: c.dataState,
      coverage: {
        monitored: c.coverage.monitored,
        total: c.coverage.total,
        partial: c.usage.partial || c.coverage.monitored < c.coverage.total,
      } as Json,
      forecast: (c.forecast ?? {}) as unknown as Json,
      cost: (c.cost ?? {}) as unknown as Json,
      computed_at: now.toISOString(),
    }));
    await db
      .insert(quota_evaluations)
      .values(rows)
      .onConflictDoUpdate({ target: quota_evaluations.quota_rule_id, set: excludedFrom(quota_evaluations, rows[0], ["quota_rule_id"]) });
  }
```

Replace the cost upsert (`if (costRows.length) { must(… "Upsert estimated costs"); }`) with:

```ts
  if (costRows.length) {
    await db
      .insert(cost_records)
      .values(costRows)
      .onConflictDoUpdate({
        target: [cost_records.workspace_id, cost_records.kind, cost_records.metric_key, cost_records.account_id, cost_records.resource_id, cost_records.period_start],
        set: excludedFrom(cost_records, costRows[0], ["workspace_id", "kind", "metric_key", "account_id", "resource_id", "period_start"]),
      });
  }
```

Replace the call `const newAlerts = await persistAlerts(admin, data, candidates, …);` with:

```ts
  const newAlerts = await persistAlerts(data, candidates, evaluatedGroups, effectiveIds, ruleBy, now);
```

In `persistAlerts`, remove the `admin: AdminClient,` parameter and change `ruleBy: Map<AlertCategory, Tables["alert_rules"]["Row"]>` to `ruleBy: Map<AlertCategory, Row<"alert_rules">>`. Replace the two loading statements (`const active = await fetchAll(…)` and the `for (let i = 0; i < keys.length; i += 100) { … }` loop body's `must(…)`) with:

```ts
  const active = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workspace_id, workspaceId), inArray(alerts.status, ACTIVE)))
    .orderBy(asc(alerts.created_at));
  for (const a of active) loaded.set(a.id, a);
  const keys = candidates.map((c) => c.dedupeKey);
  for (let i = 0; i < keys.length; i += 100) {
    const rows = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.workspace_id, workspaceId), inArray(alerts.dedupe_key, keys.slice(i, i + 100))));
    for (const a of rows) loaded.set(a.id, a);
  }
```

Replace the two `await admin.from("alerts").update(…).eq("id", prior.id)` calls with:

```ts
        await db.update(alerts).set(freshFields).where(eq(alerts.id, prior.id));
```

and

```ts
        await db.update(alerts).set({ ...freshFields, status: "open", resolved_at: null }).where(eq(alerts.id, prior.id));
```

Replace the insert (`const { data: inserted, error } = await admin.from("alerts").insert({…}).select("*").single(); if (error) { … }`) with the same field list as a Drizzle insert:

```ts
    const inserted = await db
      .insert(alerts)
      .values({
        workspace_id: workspaceId,
        rule_id: rule?.id ?? null,
        category: c.category,
        severity: c.severity,
        status: muted ? "muted" : "open",
        muted_until: muted ? (groupAlerts.find((a) => a.muted_until)?.muted_until ?? null) : null,
        dedupe_key: c.dedupeKey,
        group_key: c.groupKey,
        title: c.title,
        message: c.message,
        recommended_action: c.recommendedAction,
        connection_id: c.connectionId,
        account_id: c.accountId,
        resource_id: c.resourceId,
        application_id: c.applicationId,
        quota_rule_id: c.quotaRuleId,
        metric_key: c.metricKey,
        current_value: c.currentValue,
        limit_value: c.limitValue,
        unit: c.unit,
        percent_used: c.percentUsed,
        cycle_start: c.cycleStart,
        cycle_reset_at: c.cycleResetAt,
        forecast_breach_at: c.forecastBreachAt,
        data_updated_at: c.dataUpdatedAt,
        details: c.details as Json,
      })
      .returning()
      .then(
        (rows) => rows[0],
        (e) => {
          if (isUniqueViolation(e)) return null; // a concurrent run created it first
          throw new Error(`Creating alert failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    if (!inserted) continue;
```

Replace the supersede update with:

```ts
      await db.update(alerts).set({ status: "superseded" }).where(inArray(alerts.id, supersede.map((a) => a.id)));
```

change `if (!muted) await queueDeliveries(admin, data, inserted, rule);` to `if (!muted) await queueDeliveries(data, inserted, rule);`, and replace the resolve update with:

```ts
    await db.update(alerts).set({ status: "resolved", resolved_at: nowIso }).where(inArray(alerts.id, toResolve.map((a) => a.id)));
```

Replace the `queueDeliveries` signature with `async function queueDeliveries(data: WorkspaceData, alert: AlertRow, rule: Row<"alert_rules"> | undefined) {` and its final `await admin.from("notification_deliveries").upsert([…], { onConflict: "alert_id,channel", ignoreDuplicates: true });` with:

```ts
  await db
    .insert(notification_deliveries)
    .values([
      {
        workspace_id: ws.id,
        alert_id: alert.id,
        channel: "in_app",
        status: inApp ? "sent" : "skipped",
        sent_at: inApp ? nowIso : null,
        last_error: inApp ? null : "In-app notifications are turned off",
      },
      {
        workspace_id: ws.id,
        alert_id: alert.id,
        channel: "email",
        recipient: emailReason ? null : recipient,
        status: emailReason ? "skipped" : "pending",
        last_error: emailReason,
      },
    ])
    .onConflictDoNothing({ target: [notification_deliveries.alert_id, notification_deliveries.channel] });
```

- [ ] **Step 10: Typecheck the job files and re-run the baseline tests**

```bash
npx tsc --noEmit 2>&1 | grep -E "^src/(lib/jobs|lib/audit|db)/" || echo "jobs typecheck clean"
npx vitest run tests/engine.test.ts
```

Expected: `jobs typecheck clean` and the engine tests PASS. Fix type errors in the files you edited (typical ones: a `string | undefined` where the column is `string | null`; add `?? null`).

- [ ] **Step 11: Run one scheduler pass against `dev`**

```bash
npm run worker:once
```

Expected: `[worker] synced=0 recalculated=0 emails sent=0 failed=0 (…ms)` (nothing to do yet) and it also seeds `metric_definitions`/`pricing_rules`. Confirm:

```bash
psql "$(node --env-file=.env.local -p 'process.env.DATABASE_URL_UNPOOLED')" -c 'select count(*) from metric_definitions' -c 'select count(*) from pricing_rules'
```

Expected: both counts greater than 0.

- [ ] **Step 12: Commit**

```bash
git add -A src
git commit -m "feat(jobs): port collector, alert engine and notifications to Drizzle

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Port server actions and API routes

**Files:**
- Modify: `src/app/(app)/settings/actions.ts`, `providers/actions.ts`, `alerts/actions.ts`, `applications/actions.ts`, `usage/actions.ts`
- Modify: `src/app/api/integrations/supabase/oauth/start/route.ts`, `callback/route.ts`

`getSession()` now returns `{ user, workspace, scope }`. Wherever an action used `supabase` (the RLS-bound client) it now passes `scope` to a repository; wherever it used `adminClient()` after checking ownership it now calls a repository or `db` with the same workspace. Repository modules are imported as namespaces (`import * as inventory …`) because several actions have the same names as repository functions.

- [ ] **Step 1: Replace `src/app/(app)/settings/actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { deleteUserData } from "@/db/bootstrap";
import * as account from "@/db/repos/account";
import { listConnections } from "@/db/repos/inventory";
import { audit } from "@/lib/audit";
import { auth } from "@/lib/auth/server";
import { clearAuthCookies } from "@/lib/auth/cookies";
import { deleteCredentials } from "@/lib/jobs/credentials";
import { oauthConfigured, revokeTokens } from "@/lib/providers/supabase/oauth";
import { getSession } from "@/lib/session";
import { withParams } from "@/lib/urls";

const done = (ok: string) => redirect(withParams("/settings", { ok }));
const fail = (error: string) => redirect(withParams("/settings", { error }));

export async function updateProfile(form: FormData) {
  const { scope } = await getSession();
  const name = z.string().trim().max(80).parse(form.get("displayName") ?? "");
  await account.setDisplayName(scope, name || null);
  done("Profile saved.");
}

export async function updateWorkspace(form: FormData) {
  const { scope } = await getSession();
  const parsed = z.string().trim().min(1).max(80).safeParse(form.get("name"));
  if (!parsed.success) fail("Workspace name must be 1–80 characters.");
  await account.updateWorkspace(scope, { name: parsed.data! });
  revalidatePath("/", "layout");
  done("Workspace renamed.");
}

export async function updateNotifications(form: FormData) {
  const { scope, user, workspace } = await getSession();
  const parsed = z
    .object({
      notify_in_app: z.boolean(),
      notify_email: z.boolean(),
      email_min_severity: z.enum(["info", "warning", "critical", "limit_reached"]),
      alert_email: z.union([z.literal(""), z.email()]),
      stale_after_hours: z.coerce.number().int().min(1).max(720),
    })
    .safeParse({
      notify_in_app: form.get("notify_in_app") === "on",
      notify_email: form.get("notify_email") === "on",
      email_min_severity: form.get("email_min_severity"),
      alert_email: String(form.get("alert_email") ?? "").trim(),
      stale_after_hours: form.get("stale_after_hours"),
    });
  if (!parsed.success) fail("Check the notification settings: " + (parsed.error.issues[0]?.message ?? "invalid value"));
  let failure: string | null = null;
  try {
    await account.updateWorkspace(scope, { ...parsed.data!, alert_email: parsed.data!.alert_email || null });
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (failure) fail(failure); // outside the try: redirect() works by throwing
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "settings.notifications" });
  done("Notification preferences saved.");
}

export async function changePassword(form: FormData) {
  const { user } = await getSession();
  const current = String(form.get("current") ?? "");
  const next = String(form.get("password") ?? "");
  if (next.length < 8) fail("The new password must have at least 8 characters.");
  if (next !== form.get("confirm")) fail("The new passwords do not match.");
  // Neon Auth checks the current password itself before changing a credential.
  const { error } = await auth.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
  if (error) fail(error.status === 400 ? "Your current password is incorrect." : (error.message ?? "Could not change the password."));
  await audit({ workspaceId: null, actorId: user.id, action: "auth.password_changed" });
  done("Password changed.");
}

/** Deletes the account, its workspace and all monitoring data, after revoking provider access. */
export async function deleteAccount(form: FormData) {
  const { user, scope } = await getSession();
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== (user.email ?? "").toLowerCase()) {
    fail("Type your email address exactly to confirm deletion.");
  }
  const connections = await listConnections(scope);
  for (const c of connections) {
    const creds = await deleteCredentials(c.id);
    if (creds?.kind === "oauth" && oauthConfigured()) await revokeTokens(creds.refreshToken).catch(() => undefined);
  }
  await audit({ workspaceId: null, actorId: null, action: "account.deleted", details: { connectionsRevoked: connections.length } });
  // Delete the login first: if Neon refuses, nothing of the user's data has been removed yet.
  const { error } = await auth.deleteUser();
  if (error) fail(`Could not delete the account: ${error.message ?? "unknown error"}`);
  // The SDK trusts its cached session cookie for up to 5 minutes; drop it so the deleted account
  // cannot be "resurrected" by ensureUserWorkspace() on the next request.
  await clearAuthCookies();
  await deleteUserData(user.id);
  redirect("/login?deleted=1");
}
```

- [ ] **Step 2: Edit `src/app/(app)/providers/actions.ts`**

Imports: delete the lines importing `adminClient` (`@/lib/supabase/admin`) and `Json` (`@/lib/supabase/database.types`) and add:

```ts
import * as applicationsRepo from "@/db/repos/applications";
import * as inventory from "@/db/repos/inventory";
import type { WorkspaceScope } from "@/db/scope";
import type { Json } from "@/db/json";
```

Change `import { audit } from "@/lib/audit";` to `import { audit, countRecentAudits } from "@/lib/audit";`.

Replace `ownedConnection` (the doc comment through its closing brace) with:

```ts
/** Confirms the signed-in user's workspace owns this connection. */
async function ownedConnection(connectionId: unknown) {
  const id = uuid.parse(connectionId);
  const session = await getSession();
  const connection = await inventory.getConnection(session.scope, id);
  if (!connection) throw new Error("Connection not found");
  return { ...session, connection };
}
```

In `tooManyConnectionAttempts`, keep the `const since = …` line and replace everything after it up to `return (count ?? 0) >= 20;` with:

```ts
  return (await countRecentAudits(workspaceId, ["connection.create", "connection.create_failed"], since)) >= 20;
```

Replace the whole `createConnection` function with:

```ts
async function createConnection(opts: {
  scope: WorkspaceScope;
  provider: "supabase" | "demo";
  label: string;
  authMethod: "token" | "demo" | "oauth";
  credentials: Credentials;
  grantedScopes: string[];
}) {
  const adapter = getAdapter(opts.provider)!;
  const conn = await inventory.insertConnection(opts.scope, {
    provider: opts.provider,
    label: opts.label,
    auth_method: opts.authMethod,
    status: "syncing",
    granted_scopes: opts.grantedScopes,
    capabilities: { declared: adapter.capabilities } as unknown as Json,
  });
  await saveCredentials(conn, opts.credentials);
  await audit({
    workspaceId: opts.scope.workspaceId,
    actorId: opts.scope.userId,
    action: "connection.create",
    targetType: "provider_connection",
    targetId: conn.id,
    details: { provider: opts.provider, authMethod: opts.authMethod },
  });
  // Discovery runs right away so the user can pick resources to monitor.
  await runConnectionSync(conn.id, "connect");
  await recalculateWorkspace(opts.scope.workspaceId);
  return conn.id;
}
```

In `connectSupabaseToken` and `connectDemo`: change `const { user, workspace } = await getSession();` to `const { user, workspace, scope } = await getSession();`, and in each `createConnection({ … })` call replace the two lines `workspaceId: workspace.id,` and `userId: user.id,` with the single line `scope,`.

In every other action in this file, change the destructuring of `ownedConnection(...)` (or `getSession()`) so that `supabase` becomes `scope` (keep the other names), then replace these statements:

| Old | New |
|---|---|
| `const admin = adminClient();` (anywhere) | delete the line |
| `await saveCredentials(admin, connection, X);` | `await saveCredentials(connection, X);` |
| `await deleteCredentials(admin, connection.id)` | `await deleteCredentials(connection.id)` |
| `await adminClient().from("provider_connections").update({ last_manual_sync_at: new Date().toISOString() }).eq("id", connection.id);` | `await inventory.patchConnection(scope, connection.id, { last_manual_sync_at: new Date().toISOString() });` |
| `await admin.from("provider_connections").update({ auth_method: "token", status: "syncing", … disconnected_at: null }).eq("id", connection.id);` (in `replaceToken`) | `await inventory.patchConnection(scope, connection.id, { auth_method: "token", status: "syncing", status_detail: null, status_changed_at: new Date().toISOString(), next_sync_at: new Date().toISOString(), consecutive_failures: 0, disconnected_at: null });` |
| `await supabase.from("provider_connections").update({ label }).eq("id", connection.id);` | `await inventory.patchConnection(scope, connection.id, { label });` |
| the `await admin.from("provider_connections").update({ status: "disconnected", … locked_until: null }).eq("id", connection.id);` statement in `disconnect` | `await inventory.patchConnection(scope, connection.id, { status: "disconnected", status_detail: "Disconnected by user. Stored credentials were deleted.", status_changed_at: new Date().toISOString(), disconnected_at: new Date().toISOString(), next_sync_at: null, locked_until: null });` |
| `await admin.from("provider_connections").delete().eq("id", connection.id);` | `await inventory.deleteConnection(scope, connection.id);` |
| `await admin.from("provider_connections").update({ next_sync_at: new Date().toISOString() }).eq("id", connection.id);` (in `setDemoSimulation`) | `await inventory.patchConnection(scope, connection.id, { next_sync_at: new Date().toISOString() });` |
| the two `if (on.length) await supabase.from("provider_resources").update({ is_monitored: true })…` / `if (off.length) …` lines in `saveMonitoring` | `if (on.length) await inventory.setResourcesMonitored(scope, on, true, connection.id);` and `if (off.length) await inventory.setResourcesMonitored(scope, off, false, connection.id);` |

Replace the body of the `setMonitored` action after its `monitored` constant (from `const { data } = await supabase.from("provider_resources").update(…)` through the `for` loop that calls `syncInBackground`) with:

```ts
  const connectionIds = await inventory.setResourcesMonitored(scope, ids, monitored);
  for (const connectionId of connectionIds) {
    if (monitored) syncInBackground(connectionId, workspace.id, "manual");
  }
```

and make sure its first line destructures `{ scope, workspace }`.

Replace the `assignResource` statements from `await supabase.from("application_resources").delete()…` through the `if (error) throw …` block with:

```ts
  if (typeof appId === "string" && appId) {
    try {
      await applicationsRepo.assignResources(scope, uuid.parse(appId), [resourceId]);
    } catch (e) {
      throw new Error(`Could not assign resource: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    await applicationsRepo.unassignResource(scope, resourceId);
  }
```

Replace the `updateAccountCycle` query (`const { data } = await supabase.from("provider_accounts").update(…).maybeSingle(); if (!data) throw …`) with:

```ts
  const connectionId = await inventory.setAccountCycleDay(scope, accountId, day);
  if (!connectionId) throw new Error("Account not found");
```

Confirm nothing is left:

```bash
grep -nE "supabase\.|adminClient|admin\.|lib/supabase" "src/app/(app)/providers/actions.ts" || echo clean
```

Expected: `clean` (the word `supabase` still appears in strings and the Supabase provider helpers, but never as `supabase.` or `admin.`).

- [ ] **Step 3: Edit `src/app/(app)/alerts/actions.ts`**

Replace the import `import type { Json } from "@/lib/supabase/database.types";` with `import type { Json } from "@/db/json";` and add `import * as alertsRepo from "@/db/repos/alerts";`.

Replace `loadAlert` with:

```ts
async function loadAlert(form: FormData) {
  const session = await getSession();
  const id = uuid.parse(form.get("alertId"));
  const alert = await alertsRepo.getAlert(session.scope, id);
  if (!alert) throw new Error("Alert not found");
  return { ...session, alert };
}
```

Then, in each action, replace `supabase` in the destructuring with `scope` (drop `user` if it becomes unused) and swap the queries:

| Old | New |
|---|---|
| in the acknowledge action: `await supabase.from("alerts").update({ status: "acknowledged", acknowledged_at: …, acknowledged_by: user.id }).eq("id", alert.id);` | `await alertsRepo.acknowledgeAlert(scope, alert.id);` |
| `await supabase.from("alerts").update({ status: "muted", muted_until: until.toISOString() }).eq("id", alert.id);` | `await alertsRepo.muteAlert(scope, alert.id, until.toISOString());` |
| `await supabase.from("alerts").update({ status: "open", muted_until: null }).eq("id", alert.id);` | `await alertsRepo.unmuteAlert(scope, alert.id);` |
| in `openNotification`, the `const { data } = await supabase.from("notification_deliveries").update(…).select("alert_id").maybeSingle();` statement, and the final redirect that uses `data` | the two statements shown right below this table |
| in `markAllRead`: `await supabase.from("notification_deliveries").update({ read_at: … }).eq("channel", "in_app").is("read_at", null);` | `await alertsRepo.markAllInAppRead(scope);` |

For `openNotification`:

```ts
  const alertId = await alertsRepo.markDeliveryRead(scope, deliveryId);
  revalidatePath("/", "layout");
  redirect(alertId ? `/alerts/${alertId}` : "/alerts?tab=inbox");
```

In `saveAlertRules`, replace `const { supabase, user, workspace } = await getSession();` and `const { data: rules } = await supabase.from("alert_rules").select("*");` with:

```ts
  const { scope, user, workspace } = await getSession();
  const rules = await alertsRepo.listAlertRules(scope);
```

change `for (const rule of rules ?? []) {` to `for (const rule of rules) {`, and replace the update-and-check pair (`const { error } = await supabase.from("alert_rules").update(patch).eq("id", rule.id); if (error) redirect(…)`) with:

```ts
    try {
      await alertsRepo.updateAlertRule(scope, rule.id, patch);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      break;
    }
```

with `let failure: string | null = null;` declared above the `for` loop and, right after the loop, `if (failure) redirect(withParams("/alerts/rules", { error: failure }));`.

- [ ] **Step 4: Replace `src/app/(app)/applications/actions.ts`**

Keep the file's existing imports and the `appForm`/`uuid` constants at the top; the functions become:

```ts
export async function createApplication(form: FormData) {
  const { scope } = await getSession();
  const parsed = appForm.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) redirect(withParams("/applications", { error: parsed.error.issues[0]?.message }));
  let id: string | null = null;
  let failure: string | null = null;
  try {
    id = await applicationsRepo.createApplication(scope, { name: parsed.data.name, description: parsed.data.description ?? null });
  } catch (e) {
    failure = isUniqueViolation(e) ? "An application with that name already exists." : e instanceof Error ? e.message : String(e);
  }
  if (failure || !id) redirect(withParams("/applications", { error: failure ?? "Could not create the application." }));
  revalidatePath("/", "layout");
  redirect(`/applications/${id}`);
}

export async function updateApplication(form: FormData) {
  const { scope } = await getSession();
  const id = uuid.parse(form.get("id"));
  const parsed = appForm.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) redirect(withParams(`/applications/${id}`, { error: parsed.error.issues[0]?.message }));
  let failure: string | null = null;
  try {
    await applicationsRepo.updateApplication(scope, id, { name: parsed.data.name, description: parsed.data.description ?? null });
  } catch (e) {
    failure = isUniqueViolation(e) ? "That name is already used." : e instanceof Error ? e.message : String(e);
  }
  if (failure) redirect(withParams(`/applications/${id}`, { error: failure }));
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${id}`, { ok: "Saved." }));
}

export async function deleteApplication(form: FormData) {
  const { scope, workspace } = await getSession();
  const id = uuid.parse(form.get("id"));
  await applicationsRepo.deleteApplication(scope, id);
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams("/applications", { ok: "Application deleted. Its resources are unassigned, not removed." }));
}

export async function addResources(form: FormData) {
  const { scope, workspace } = await getSession();
  const applicationId = uuid.parse(form.get("applicationId"));
  const ids = z.array(uuid).parse(form.getAll("resourceId"));
  if (ids.length) {
    // Reassigning moves the resource: a resource belongs to at most one application.
    let failure: string | null = null;
    try {
      await applicationsRepo.assignResources(scope, applicationId, ids);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (failure) redirect(withParams(`/applications/${applicationId}`, { error: failure }));
    await recalculateWorkspace(workspace.id);
  }
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${applicationId}`, { ok: `Added ${ids.length} resource${ids.length === 1 ? "" : "s"}.` }));
}

export async function removeResource(form: FormData) {
  const { scope, workspace } = await getSession();
  const applicationId = uuid.parse(form.get("applicationId"));
  const resourceId = uuid.parse(form.get("resourceId"));
  await applicationsRepo.removeResourceFromApplication(scope, applicationId, resourceId);
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${applicationId}`, { ok: "Resource removed from this application." }));
}
```

and add these imports at the top of the file (next to the existing ones): `import * as applicationsRepo from "@/db/repos/applications";` and `import { isUniqueViolation } from "@/db/errors";`. If the file's existing `appForm` import or `recalculateWorkspace` import is already there, leave it.

- [ ] **Step 5: Edit `src/app/(app)/usage/actions.ts`**

Replace `import type { Json } from "@/lib/supabase/database.types";` with `import type { Json } from "@/db/json";` and add `import * as inventory from "@/db/repos/inventory";` and `import * as quotasRepo from "@/db/repos/quotas";`.

Delete the three declarations `async function scopeContext(...)`, `type Client = …` and `async function writeUserQuota(...)` (the whole block from `async function scopeContext` to the end of `writeUserQuota`).

In `saveQuota`: change `const { supabase, user, workspace } = await getSession();` to `const { scope, user, workspace } = await getSession();`, replace `const ctx = await scopeContext(supabase, scopeType, scopeId);` with `const ctx = await inventory.getScopePlan(scope, scopeType, scopeId);`, and replace the `const { error } = await writeUserQuota(…); if (error) return {…};` pair with:

```ts
  try {
    await quotasRepo.saveUserQuota(scope, { metric_key: metricKey, scope_type: scopeType, scopeId, unit: metric.unit }, row);
  } catch (e) {
    return { error: `Could not save the limit: ${e instanceof Error ? e.message : String(e)}` };
  }
```

In `deleteQuota`: destructure `{ scope, user, workspace }` and replace the delete statement with `await quotasRepo.deleteUserQuota(scope, id);`.

In `applyPlanAllowance`: destructure `{ scope, user, workspace }` and replace from `let error: { message: string } | null = null;` through `if (error) throw new Error(\`Could not apply allowance: ${error.message}\`);` with:

```ts
  let failure: string | null = null;
  for (const scopeId of scopeIds) {
    try {
      await quotasRepo.saveUserQuota(
        scope,
        { metric_key: metricKey, scope_type: scopeType, scopeId, unit: metric.unit },
        {
          limit_value: allowance.limit,
          overage_effect: allowance.overageEffect,
          pricing_rule_id: pricing?.id ?? null,
          plan_hint: plan,
          notes: `${allowance.note} Source: ${allowance.sourceUrl} (verified ${allowance.verifiedAt}).`,
          verified_at: new Date().toISOString(),
        },
      );
    } catch (e) {
      failure ??= e instanceof Error ? e.message : String(e);
    }
  }
  if (failure) throw new Error(`Could not apply allowance: ${failure}`);
```

- [ ] **Step 6: Edit the OAuth start route `src/app/api/integrations/supabase/oauth/start/route.ts`**

Delete the imports of `adminClient` and `createUserClient`, and add:

```ts
import { lt } from "drizzle-orm";
import { z } from "zod";
import { ensureUserWorkspace } from "@/db/bootstrap";
import { db } from "@/db/client";
import { getConnection } from "@/db/repos/inventory";
import { oauth_states } from "@/db/schema";
import { requireWorkspace } from "@/db/scope";
import { auth } from "@/lib/auth/server";
```

Replace everything from `const supabase = await createUserClient();` down to the end of the `if (connectionId) { … }` block (it ends just before `const state = randomToken(32);`) with:

```ts
  const { data: session } = await auth.getSession();
  const user = session?.user;
  if (!user) return NextResponse.redirect(new URL("/login", origin));
  if (!oauthConfigured()) {
    return NextResponse.redirect(new URL("/providers/connect/supabase?error=OAuth+is+not+configured+on+this+server", origin));
  }

  const workspace = await ensureUserWorkspace({ id: user.id, email: user.email });
  const scope = await requireWorkspace(user.id, workspace.id);

  // Reauthorizing an existing connection: confirm it belongs to this workspace first.
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId && (!z.uuid().safeParse(connectionId).success || !(await getConnection(scope, connectionId)))) {
    return NextResponse.redirect(new URL("/providers?error=Connection+not+found", origin));
  }
```

Replace the state-saving part (from `const admin = adminClient();` through the `if (error) return NextResponse.redirect(…Could+not+start+authorization…)` line) with:

```ts
  await db.delete(oauth_states).where(lt(oauth_states.expires_at, new Date().toISOString()));
  try {
    await db.insert(oauth_states).values({
      state,
      workspace_id: workspace.id,
      user_id: user.id,
      provider: "supabase",
      code_verifier_ciphertext: encryptSecret(verifier, `oauth-state:${state}`),
      connection_id: connectionId,
    });
  } catch {
    return NextResponse.redirect(new URL("/providers?error=Could+not+start+authorization", origin));
  }
```

- [ ] **Step 7: Edit the OAuth callback route `src/app/api/integrations/supabase/oauth/callback/route.ts`**

Delete the imports of `adminClient`, `Json` (from `@/lib/supabase/database.types`) and `createUserClient`, and add:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import type { Json } from "@/db/json";
import { oauth_states, provider_connections } from "@/db/schema";
import { auth } from "@/lib/auth/server";
```

Replace the session lookup (`const supabase = await createUserClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return …`) with:

```ts
  const { data: session } = await auth.getSession();
  const user = session?.user;
  if (!user) return NextResponse.redirect(new URL("/login", origin));
```

Replace the one-time-state read (`const admin = adminClient(); const { data: rows } = await admin.from("oauth_states").delete()…; const saved = rows?.[0];`) with:

```ts
  const [saved] = await db.delete(oauth_states).where(eq(oauth_states.state, state)).returning();
```

In the reauthorize branch replace `await saveCredentials(admin, { id: connectionId, workspace_id: saved.workspace_id }, credentials);` and the `await admin.from("provider_connections").update({…}).eq("id", connectionId).eq("workspace_id", saved.workspace_id);` statement with:

```ts
    await saveCredentials({ id: connectionId, workspace_id: saved.workspace_id }, credentials);
    await db
      .update(provider_connections)
      .set({
        auth_method: "oauth",
        status: "syncing",
        status_detail: null,
        status_changed_at: new Date().toISOString(),
        granted_scopes: [...SUPABASE_SCOPES],
        next_sync_at: new Date().toISOString(),
        consecutive_failures: 0,
        disconnected_at: null,
      })
      .where(and(eq(provider_connections.id, connectionId), eq(provider_connections.workspace_id, saved.workspace_id)));
```

In the create branch replace the `const { data: conn, error } = await admin.from("provider_connections").insert({…}).select("id, workspace_id").single(); if (error || !conn) return fail(…); connectionId = conn.id; await saveCredentials(admin, conn, credentials);` sequence with:

```ts
    let conn: { id: string; workspace_id: string } | undefined;
    try {
      [conn] = await db
        .insert(provider_connections)
        .values({
          workspace_id: saved.workspace_id,
          provider: "supabase",
          label: "Supabase",
          auth_method: "oauth",
          granted_scopes: [...SUPABASE_SCOPES],
          capabilities: { declared: getAdapter("supabase")!.capabilities } as unknown as Json,
          created_by: user.id,
        })
        .returning({ id: provider_connections.id, workspace_id: provider_connections.workspace_id });
    } catch {
      return fail("Could not save the connection.");
    }
    if (!conn) return fail("Could not save the connection.");
    connectionId = conn.id;
    await saveCredentials(conn, credentials);
```

- [ ] **Step 8: Confirm only page and layout files still reference the old client**

```bash
grep -rlE "createUserClient|adminClient|session\.supabase|lib/supabase|\{ supabase" src | sort
```

Expected: only `src/lib/data/views.ts`, `src/app/(app)/layout.tsx` and `src/app/(app)/**/page.tsx` files (plus `src/lib/supabase/*` itself). Anything else is a missed edit.

- [ ] **Step 9: Commit**

```bash
git add -A src
git commit -m "feat(app): port server actions and OAuth routes to workspace-scoped repositories

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Port read models, pages and layout

**Files:**
- Modify: `src/lib/data/views.ts`, `src/app/(app)/layout.tsx`, and the pages listed below

Do this task last, after the user has committed or stashed the simulator/currency work and the worktree has been rebased on it (`git rebase feat/cost-simulator` from the worktree), because `layout.tsx`, `home/page.tsx`, `providers/page.tsx` and `usage/page.tsx` are touched by both pieces of work. The edits here are small and described by pattern so they apply to either version of those files.

- [ ] **Step 1: Port `src/lib/data/views.ts`**

Replace the header (everything above `export interface Inventory`) with:

```ts
import "server-only";
import { listAccounts, listApplicationMappings, listApplications, listConnections, listResources } from "../../db/repos/inventory";
import { listQuotasWithEvaluations } from "../../db/repos/quotas";
import { loadSamples as querySamples } from "../../db/repos/samples";
import type { WorkspaceScope } from "../../db/scope";
import type { Row } from "../../db/types";
import type { CostEstimate } from "../engine/cost";
import type { Forecast } from "../engine/forecast";
import { billingCycle, DAY_MS, startOfUtcDay, type Cycle } from "../engine/time";
import { currentUsage, dailySeries, type CurrentUsage, type DailyValue, type UsagePoint } from "../engine/usage";
import { getAdapter, getMetric, PROVIDER_NAMES } from "../providers/registry";
import type { MetricDefinition } from "../types";

// Read models for pages. Everything here reads stored data for the caller's workspace
// through repositories; no provider API is called while rendering.

export type ConnectionRow = Row<"provider_connections">;
export type AccountRow = Row<"provider_accounts">;
export type ResourceRow = Row<"provider_resources">;
export type ApplicationRow = Row<"applications">;
```

Replace `loadInventory` with:

```ts
export async function loadInventory(scope: WorkspaceScope): Promise<Inventory> {
  const [conns, accs, resources, apps, mappings] = await Promise.all([
    listConnections(scope),
    listAccounts(scope),
    listResources(scope),
    listApplications(scope),
    listApplicationMappings(scope),
  ]);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const appByResource = new Map<string, ApplicationRow>();
  for (const m of mappings) {
    const app = appById.get(m.application_id);
    if (app) appByResource.set(m.resource_id, app);
  }
  return {
    connections: conns,
    accounts: accs,
    resources,
    applications: apps,
    appByResource,
    connectionById: new Map(conns.map((c) => [c.id, c])),
    accountById: new Map(accs.map((a) => [a.id, a])),
    resourceById: new Map(resources.map((r) => [r.id, r])),
  };
}
```

In `loadQuotaViews` change the signature to `export async function loadQuotaViews(scope: WorkspaceScope, inv: Inventory): Promise<QuotaView[]> {`, replace the `const rows = await fetchAll(…);` statement with `const rows = await listQuotasWithEvaluations(scope);`, and replace the line `const ev = Array.isArray(q.quota_evaluations) ? q.quota_evaluations[0] : q.quota_evaluations;` with `const ev = q.quota_evaluations;`.

Replace `loadSamples` (whole function) with:

```ts
export async function loadSamples(
  scope: WorkspaceScope,
  opts: { metricKeys?: string[]; resourceIds?: string[]; accountIds?: string[]; from: Date },
): Promise<SampleRow[]> {
  return querySamples(scope, opts);
}
```

In `loadResourceUsage` replace the parameter `supabase: Client,` with `scope: WorkspaceScope,` and the call `loadSamples(supabase, { resourceIds, from })` with `loadSamples(scope, { resourceIds, from })`.

- [ ] **Step 2: Port `src/app/(app)/layout.tsx`**

Add `import { countOpenAlerts, countUnreadInApp } from "@/db/repos/alerts";`. Replace the destructuring `const { supabase, user, workspace } = await getSession();` with `const { scope, user, workspace } = await getSession();`. Replace the `Promise.all` whose first two entries are the two `supabase.from(...)` count queries with the same `Promise.all` using these two entries instead (keep `getDisplay()` as the third entry if your version of the file has it):

```tsx
  const [openAlerts, unreadCount] = await Promise.all([countOpenAlerts(scope), countUnreadInApp(scope)]);
```

(if `getDisplay()` is present: `const [openAlerts, unreadCount, { display, usdPhp }] = await Promise.all([countOpenAlerts(scope), countUnreadInApp(scope), getDisplay()]);`). Then replace every `alerts.count ?? 0` with `openAlerts` and every `unread.count ?? 0` with `unreadCount`.

- [ ] **Step 3: Port the pages**

Everywhere below, `const { supabase, … } = await getSession();` becomes `const { scope, … } = await getSession();`, and every `loadInventory(supabase)`, `loadQuotaViews(supabase, inv)`, `loadSamples(supabase, …)` and `loadResourceUsage(supabase, …)` passes `scope` instead of `supabase`. Specific query replacements:

`src/app/(app)/home/page.tsx`: add `import { listAlerts, listFutureCosts } from "@/db/repos/alerts";` and replace the `const [{ data: openAlerts }, { data: costs }] = await Promise.all([ supabase.from("alerts")…, supabase.from("cost_records")… ]);` statement with:

```tsx
  const [openAlerts, costs] = await Promise.all([
    listAlerts(scope, { statuses: ["open", "acknowledged"], limit: 200 }),
    listFutureCosts(scope, now.toISOString()),
  ]);
```

`src/app/(app)/alerts/page.tsx`: add `import { listAlerts, listInbox } from "@/db/repos/alerts";`. Replace the inbox query (`const { data } = await supabase.from("notification_deliveries")…limit(100); const items = data ?? [];`) with `const items = await listInbox(scope, 100);`. Replace the list query (`const query = supabase.from("alerts")…; const { data } = tab === "active" ? await query.in(…) : await query;`) with:

```tsx
    const data = await listAlerts(scope, {
      statuses: tab === "active" ? ["open", "acknowledged", "muted"] : undefined,
      limit: tab === "history" ? 200 : 100,
    });
```

`src/app/(app)/alerts/[id]/page.tsx`: add `import { getAlertDetail, listDeliveriesForAlert } from "@/db/repos/alerts";` and `import { z } from "zod";`. Replace `const { data: a } = await supabase.from("alerts").select(…).eq("id", id).maybeSingle(); if (!a) notFound();` with:

```tsx
  if (!z.uuid().safeParse(id).success) notFound();
  const a = await getAlertDetail(scope, id);
  if (!a) notFound();
```

and `const { data: deliveries } = await supabase.from("notification_deliveries")…order("channel");` with `const deliveries = await listDeliveriesForAlert(scope, a.id);`. (Where the page used `deliveries ?? []`, that still works.)

`src/app/(app)/alerts/rules/page.tsx`: add `import { listAlertRules } from "@/db/repos/alerts";` and replace `const { data } = await supabase.from("alert_rules").select("*");` with `const data = await listAlertRules(scope);`.

`src/app/(app)/settings/page.tsx`: add `import { getProfile } from "@/db/repos/account";` and replace `const { data: profile } = await supabase.from("profiles")…maybeSingle();` with `const profile = await getProfile(scope);`. The session's `user` is now just `{ id, email }`, so the page's "Member since" (it reads `user.created_at`) must read `profile?.created_at` instead; check the rest of the page for any other `user.*` field besides `id` and `email`.

`src/app/(app)/providers/[id]/page.tsx`: add `import { listSyncRuns } from "@/db/repos/inventory";` and replace `const { data: runs } = await supabase.from("sync_runs")…limit(10);` with `const runs = await listSyncRuns(scope, conn.id, 10);`.

`src/app/(app)/applications/page.tsx`: add `import { listAlerts } from "@/db/repos/alerts";` and replace `const { data: openAlerts } = await supabase.from("alerts").select(…)…order("created_at", { ascending: false });` with `const openAlerts = await listAlerts(scope, { statuses: ["open"], limit: 1000 });`.

`src/app/(app)/applications/[id]/page.tsx`: add `import { listAlerts } from "@/db/repos/alerts";` and replace `const { data: alerts } = await supabase.from("alerts")…limit(200);` with `const alerts = await listAlerts(scope, { statuses: ["open", "acknowledged", "muted"], limit: 200 });`.

The remaining pages need only the `scope` substitution described above: `providers/page.tsx`, `providers/resources/page.tsx`, `usage/page.tsx`, `usage/quotas/page.tsx`.

- [ ] **Step 4: Typecheck the whole project**

```bash
npm run typecheck
```

Expected: no errors. Typical leftovers: `string | undefined` passed to a `string | null` column (add `?? null`), or an old `data ?? []` on a value that is now a plain array (harmless, but delete it if lint complains). Fix until clean.

- [ ] **Step 5: Check no old client remains anywhere**

```bash
grep -rnE "createUserClient|adminClient|lib/supabase|session\.supabase|supabase\.(from|auth|rpc)" src tests scripts || echo "no references left"
```

Expected: only matches inside `src/lib/supabase/` itself and `tests/rls.integration.test.ts` (both deleted in Task 11). Everything else must be gone.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(app): port read models, layout and pages to workspace-scoped repositories

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Scripts, packages, docs and removal of Supabase

**Files:**
- Modify: `scripts/setup-env.mjs`, `package.json`, `.gitignore`, `README.md`
- Create: `scripts/db-reset.ts`
- Delete: `src/lib/supabase/`, `supabase/`, `tests/rls.integration.test.ts`

- [ ] **Step 1: Replace `scripts/setup-env.mjs`**

```js
// Prepares .env.local for development: copies the keys from .env.example and generates the
// secrets. Existing values in .env.local are preserved, so it is safe to re-run. The Neon
// connection strings and Auth URL come from the Neon console; this script cannot create them.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const parse = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
  );

const example = parse(readFileSync(".env.example", "utf8"));
const existing = existsSync(".env.local") ? parse(readFileSync(".env.local", "utf8")) : {};

const generated = {
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  CRON_SECRET: randomBytes(24).toString("base64url"),
  NEON_AUTH_COOKIE_SECRET: randomBytes(32).toString("base64"),
};

const merged = { ...example, ...generated, ...Object.fromEntries(Object.entries(existing).filter(([, v]) => v !== "")) };

const quote = (v) => (/[\s"#]/.test(v) ? JSON.stringify(v) : v);
writeFileSync(".env.local", Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n", { mode: 0o600 });

const missing = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_AUTH_BASE_URL"].filter((k) => !merged[k]);
if (missing.length) {
  console.warn(`.env.local written. Still to fill in from the Neon console: ${missing.join(", ")}`);
} else {
  console.info(".env.local is ready. Next: npm run db:migrate && npm run dev");
}
```

- [ ] **Step 2: Create `scripts/db-reset.ts`**

```ts
// `npm run db:reset -- --yes` — drops and recreates the public schema, then re-applies the
// migrations. Neon Auth users (the neon_auth schema) are kept; their workspace is re-created
// the next time they load the app. Refuses to run unless NEON_BRANCH is "dev".
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { migrate } from "../src/db/migrate";

neonConfig.webSocketConstructor = ws;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) return fail("Set DATABASE_URL_UNPOOLED in .env.local first.");
  if (process.env.NEON_BRANCH !== "dev") return fail('Refusing to reset: NEON_BRANCH is not "dev" in .env.local.');
  if (!process.argv.includes("--yes")) return fail("Add --yes to confirm that all app data on the dev branch will be deleted.");

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("drop schema public cascade; create schema public;");
  } finally {
    await pool.end();
  }
  console.info(`Reset. Applied: ${(await migrate(url)).join(", ")}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
```

- [ ] **Step 3: Update `package.json`**

Replace the `db:start`, `db:reset` and `db:types` scripts: delete `"db:start"` and `"db:types"`, and set:

```json
    "db:reset": "tsx --env-file=.env.local scripts/db-reset.ts",
```

Remove the Supabase packages:

```bash
npm uninstall @supabase/ssr @supabase/supabase-js
```

Expected: both packages removed from `package.json` and the lockfile.

- [ ] **Step 4: Point dev email at the console and drop the Supabase variables from `.env.local`**

Mailpit (the local email inbox) disappears with the Docker stack, so alert emails must not use SMTP on port 54325 any more. `.env.local` is not tracked by git; edit it directly:

```bash
sed -i '' 's/^EMAIL_TRANSPORT=.*/EMAIL_TRANSPORT=console/' .env.local
sed -i '' -E '/^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS)=/d' .env.local
```

Expected: no output. (`SUPABASE_OAUTH_*` stay: they belong to the Supabase provider integration.)

- [ ] **Step 5: Remove the Supabase leftovers**

```bash
git rm -r src/lib/supabase supabase tests/rls.integration.test.ts
```

Remove the two lines `supabase/.branches` and `supabase/.temp` from `.gitignore`. (If `git rm -r supabase` leaves untracked files such as `supabase/.temp`, delete them with `rm -rf supabase`.)

- [ ] **Step 6: Update `README.md`**

Replace the "Quick start (local)" prerequisites line with `Prerequisites: Node 20.9+ and a free Neon account (https://neon.com).` and replace the three setup code blocks (`npm install`, `npm run db:start`, `npm run setup:env`) and the paragraph under the numbered list with:

````markdown
Create a Neon project with a `dev` branch, enable **Auth** on that branch, and put its connection strings and Auth URL in `.env.local` (see `.env.example`). Then:

```bash
npm install
```

```bash
npm run setup:env
```

```bash
npm run db:migrate
```

```bash
npm run dev
```
````

Change list item 4 to `4. Explore **Home**, **Usage**, **Limits & quotas** and **Alerts**. In development alert emails are printed to the server log (`EMAIL_TRANSPORT=console`).` and replace the `setup:env` paragraph with: `` `setup:env` creates `.env.local` from `.env.example` and generates the credential encryption key, cron secret and auth cookie secret. It keeps existing values, so it is safe to re-run. ``

In the scripts table replace the `npm test`, `db:reset` and `db:types` rows with:

```markdown
| `npm test` | Unit tests, plus database integration tests when `DATABASE_URL_TEST` is set |
| `npm run db:migrate` | Apply `db/migrations/*.sql` to the branch in `DATABASE_URL_UNPOOLED` |
| `npm run db:reset -- --yes` | Wipe and re-create the app schema on the `dev` branch (refuses unless `NEON_BRANCH=dev`) |
```

In the architecture diagram change `PostgreSQL (Supabase, RLS per workspace)` to `PostgreSQL (Neon, workspace-scoped repositories)`, and replace the "Schema, RLS, privileges" table row with:

```markdown
| Schema and access control | `db/migrations/`, `src/db/` | SQL-first migrations; a Drizzle schema for typed queries. Access control lives in `src/db/scope.ts`: every user-facing query goes through a repository in `src/db/repos/` that needs a `WorkspaceScope`. Repositories never touch `provider_credentials` or `oauth_states`. |
```

Replace the "Deploying" steps 1 and 2 with:

```markdown
1. **Database and auth.** In Neon, use the `main` branch for production. Apply the schema with `DATABASE_URL_UNPOOLED=<main direct url> npm run db:migrate`. In the branch's Auth settings add your production domain as a trusted domain, set up a custom email provider, and enable email verification (see Neon's auth production checklist).
2. **App.** Deploy to Vercel or any Node host, with these env vars: `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `APP_URL`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, the email settings (`EMAIL_TRANSPORT=resend` + `RESEND_API_KEY`, or SMTP), and optionally the Supabase OAuth credentials. Set `ENABLE_DEMO_PROVIDER=false` and `RUN_SCHEDULER_IN_PROCESS=false`.
```

- [ ] **Step 7: Verify nothing references the removed pieces**

```bash
grep -rnE "supabase/(migrations|config)|db:start|db:types|NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE|@supabase/" . --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.json' --include='*.md' --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=docs || echo "clean"
```

Expected: `clean`. (The `docs/` folder keeps its historical references.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove Supabase tooling, add Neon scripts and update the README

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Verify everything

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, unit and integration tests**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean. `npm test` passes: the existing engine/simulator/currency/adapter tests plus `tests/db` (parity 1, bootstrap 3, isolation 8). If `DATABASE_URL_TEST` is unset the `tests/db` files are reported as skipped; set it and re-run, because skipped is not verified.

- [ ] **Step 2: Production build**

```bash
npm run build
```

Expected: the build completes. If it fails because `createNeonAuth` throws while collecting page data without the auth variables, make sure `.env.local` has `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` (the build loads it) and re-run.

- [ ] **Step 3: Scheduler against the demo provider**

Start the dev server (`npm run dev`), sign in, then **Providers → Add demo connection**, pick resources to monitor, and wait for the sync (or press **Sync now**). Then run one worker pass:

```bash
npm run worker:once
```

Expected: no errors in either log, and `samples`, quotas and evaluations appear (the Usage and Limits pages fill in).

- [ ] **Step 4: Click through every flow in the browser** (http://localhost:3100)

Check each and note the result:

1. Signed out: `/` redirects to `/login`; `/home` redirects to `/login?next=%2Fhome` (or `/login` if you used the middleware fallback in Task 7).
2. Sign up with a new email: lands on `/home` with a workspace named after the email; **Settings** shows the profile.
3. Sign out (header icon), sign in again with the same account: returns to `/home`.
4. Wrong password: shows "Incorrect email or password."
5. Demo provider: connect, choose resources, usage and quotas render; create an application and assign a resource; set a custom limit on **Limits & quotas**; delete it again.
6. Alerts: trigger one (set a very low limit on a monitored metric), see it in **Alerts** and the inbox, acknowledge it, mute it, unmute it, mark all read.
7. **Settings**: change display name, rename the workspace, save notification preferences, change password (wrong current password is rejected, correct one works; sign out and in with the new one).
8. Forgot password: request a link (a generic confirmation appears). Open the reset email from Neon, follow the link, set a new password, and sign in with it.
9. Delete account (type the email): redirected to `/login?deleted=1`; signing in with that email fails; `select count(*) from workspaces` for that owner is 0.
10. A second account sees none of the first account's data (look at Providers and Alerts).

Expected: every item behaves as before the migration. Record any failure and fix it before continuing; do not move on with a failing flow.

- [ ] **Step 5: Commit any fixes found in Step 4**

```bash
git add -A
git commit -m "fix: issues found while verifying the Neon migration

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Skip if there were none.)

---

### Task 13: Cutover — stop the local Docker stack

**Files:** none in the repo; updates the assistant's memory notes

Only start this task after Task 12 passes completely.

- [ ] **Step 1: Confirm which containers belong to this project**

```bash
docker ps -a --filter "name=_cloudwatch" --format '{{.Names}}\t{{.Status}}'
```

Expected: only `supabase_*_cloudwatch` containers. Other Supabase projects on this machine (for example `supabase_*_gg-reporting`) are not touched.

- [ ] **Step 2: Stop and remove them**

The `supabase/` folder is gone, so name the project explicitly:

```bash
supabase stop --project-id cloudwatch
```

Expected: the containers stop and are removed. Verify:

```bash
docker ps -a --filter "name=_cloudwatch" --format '{{.Names}}' | wc -l
```

Expected: `0`.

- [ ] **Step 3: Ask before deleting the data volumes**

```bash
docker volume ls --filter "name=cloudwatch" --format '{{.Name}}'
```

Show the user the list and ask whether to delete these volumes (they hold the old local database). Only if they say yes:

```bash
docker volume rm $(docker volume ls --filter "name=cloudwatch" -q)
```

Docker Desktop itself is left running.

- [ ] **Step 4: Update the memory note**

Rewrite `/Users/fiona/.claude/projects/-Users-fiona-Documents-Apps-Cloud-Watch/memory/cloudwatch-local-setup.md` so it says the app now uses Neon (project `limit-gauge`, branch `dev` for development, `main` empty as prod, a `test` branch for integration tests), Neon Auth instead of Supabase Auth, no Docker, the dev server still on port 3100, and the test login still in `.env.local`. Update its line in `MEMORY.md` to match.

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide how to merge `feat/neon-migration` (the simulator branch may need to land first; see the note at the top of Task 10).
