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
