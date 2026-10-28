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
