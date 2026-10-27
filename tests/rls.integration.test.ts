// Workspace isolation against a real (local) Supabase database.
// Runs when .env.local points at a running stack; skipped otherwise.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const reachable = url && anon && service ? await fetch(`${url}/auth/v1/health`, { headers: { apikey: anon } }).then((r) => r.ok, () => false) : false;

type Client = SupabaseClient<Database>;

describe.skipIf(!reachable)("workspace isolation (RLS)", () => {
  const admin = createClient<Database>(url!, service!, { auth: { persistSession: false } });
  const users: { id: string; client: Client; workspaceId: string }[] = [];
  let connectionA = "";
  let resourceA = "";

  async function makeUser() {
    const email = `rls-${randomUUID()}@cloudwatch.test`;
    const password = `T-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const client = createClient<Database>(url!, anon!, { auth: { persistSession: false } });
    await client.auth.signInWithPassword({ email, password });
    const { data: ws } = await client.from("workspaces").select("id").single();
    return { id: data.user.id, client, workspaceId: ws!.id };
  }

  beforeAll(async () => {
    users.push(await makeUser(), await makeUser());
    const [a] = users;
    // Seed workspace A with a connection, credentials and a resource (as the collector would).
    const { data: conn } = await admin
      .from("provider_connections")
      .insert({ workspace_id: a.workspaceId, provider: "demo", label: "A", auth_method: "demo" })
      .select("id")
      .single();
    connectionA = conn!.id;
    await admin.from("provider_credentials").insert({ connection_id: connectionA, workspace_id: a.workspaceId, ciphertext: "v1:secret" });
    const { data: res } = await admin
      .from("provider_resources")
      .insert({ workspace_id: a.workspaceId, connection_id: connectionA, provider: "demo", external_id: "x", name: "a-res", resource_type: "project" })
      .select("id")
      .single();
    resourceA = res!.id;
  });

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  it("creates one private workspace per user", async () => {
    const [a, b] = users;
    expect(a.workspaceId).not.toBe(b.workspaceId);
    const { data } = await b.client.from("workspaces").select("id");
    expect(data!.map((w) => w.id)).toEqual([b.workspaceId]);
  });

  it("hides another workspace's connections and resources", async () => {
    const [, b] = users;
    const { data: conns } = await b.client.from("provider_connections").select("id").eq("id", connectionA);
    const { data: res } = await b.client.from("provider_resources").select("id").eq("id", resourceA);
    expect(conns).toEqual([]);
    expect(res).toEqual([]);
  });

  it("never exposes stored credentials, even to their owner", async () => {
    const [a] = users;
    const { data, error } = await a.client.from("provider_credentials").select("*");
    expect(data ?? []).toEqual([]);
    expect(error?.code).toBe("42501"); // permission denied
  });

  it("blocks writes into another workspace", async () => {
    const [, b] = users;
    const { error: appErr } = await b.client.from("applications").insert({ workspace_id: users[0].workspaceId, name: "intrusion" });
    expect(appErr).not.toBeNull();
    const { data: updated } = await b.client.from("provider_resources").update({ is_monitored: true }).eq("id", resourceA).select("id");
    expect(updated ?? []).toEqual([]);
  });

  it("prevents mapping a foreign resource into one's own application", async () => {
    const [, b] = users;
    const { data: app } = await b.client.from("applications").insert({ workspace_id: b.workspaceId, name: "mine" }).select("id").single();
    const { error } = await b.client
      .from("application_resources")
      .insert({ application_id: app!.id, resource_id: resourceA, workspace_id: b.workspaceId });
    expect(error).not.toBeNull();
  });

  it("lets users write only user-sourced quotas and only granted columns", async () => {
    const [a] = users;
    await admin.from("metric_definitions").upsert({
      key: "demo.database_size", provider: "demo", name: "Database size", unit: "bytes", aggregation: "gauge", scope_level: "resource", derivation: "reported",
    });
    const base = { workspace_id: a.workspaceId, metric_key: "demo.database_size", scope_type: "resource", resource_id: resourceA, limit_value: 1, unit: "bytes" };
    const { error: providerErr } = await a.client.from("quota_rules").insert({ ...base, source: "provider" });
    expect(providerErr).not.toBeNull();
    const { error: userErr } = await a.client.from("quota_rules").insert({ ...base, source: "user" });
    expect(userErr).toBeNull();
    // Status is not a user-writable column on connections.
    const { error: colErr } = await a.client.from("provider_connections").update({ status: "connected" }).eq("id", connectionA);
    expect(colErr?.code).toBe("42501");
  });

  it("keeps the worker functions away from end users", async () => {
    const [a] = users;
    const { error } = await a.client.rpc("claim_due_connections", { p_limit: 1 });
    expect(error).not.toBeNull();
  });
});
