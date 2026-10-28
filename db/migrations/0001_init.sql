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
