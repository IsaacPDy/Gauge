import { randomUUID } from "node:crypto";
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
  let accA: { id: string };
  let syncA: { id: string };
  let deliveryA: { id: string };
  let costA: { id: string };

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

    [connA] = await db.insert(t.provider_connections).values({ workspace_id: a.workspaceId, provider: "demo", label: "A", auth_method: "demo", status: "connected", next_sync_at: null }).returning();
    await db.insert(t.provider_credentials).values({ connection_id: connA.id, workspace_id: a.workspaceId, ciphertext: "v1:secret" });
    [accA] = await db
      .insert(t.provider_accounts)
      .values({ workspace_id: a.workspaceId, connection_id: connA.id, provider: "demo", external_id: "acc-x", name: "a-acc" })
      .returning();
    [resA] = await db
      .insert(t.provider_resources)
      .values({ workspace_id: a.workspaceId, connection_id: connA.id, account_id: accA.id, provider: "demo", external_id: "x", name: "a-res", resource_type: "project" })
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
    [syncA] = await db.insert(t.sync_runs).values({ workspace_id: a.workspaceId, connection_id: connA.id, trigger: "manual" }).returning();
    [deliveryA] = await db
      .insert(t.notification_deliveries)
      .values({ workspace_id: a.workspaceId, alert_id: alertA.id, channel: "in_app", status: "sent" })
      .returning();
    const inOneDay = new Date(Date.now() + 86_400_000).toISOString();
    [costA] = await db
      .insert(t.cost_records)
      .values({ workspace_id: a.workspaceId, connection_id: connA.id, period_start: new Date().toISOString(), period_end: inOneDay, amount: 1, currency: "USD", kind: "estimated" })
      .returning();
    await db.insert(t.usage_samples).values({
      workspace_id: a.workspaceId,
      connection_id: connA.id,
      resource_id: resA.id,
      account_id: accA.id,
      metric_key: "demo.database_size",
      bucket_start: new Date(Date.now() - 3_600_000).toISOString(),
      bucket_end: new Date().toISOString(),
      value: 1,
      unit: "bytes",
      aggregation: "gauge",
      observed_at: new Date().toISOString(),
      source: "provider",
    });
  });

  afterAll(async () => {
    const { deleteUserData } = await import("@/db/bootstrap");
    // Delete every user we created even if one deletion fails, then surface the first failure.
    const results = await Promise.allSettled(userIds.map((id) => deleteUserData(id)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
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

  it("no repository function leaks or mutates across workspaces", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const inv = await import("@/db/repos/inventory");
    const apps = await import("@/db/repos/applications");
    const alerts = await import("@/db/repos/alerts");
    const samples = await import("@/db/repos/samples");
    const account = await import("@/db/repos/account");
    const [ruleA] = await db.select().from(t.alert_rules).where(eq(t.alert_rules.workspace_id, a.workspaceId)).limit(1);
    const snapApp = await apps.createApplication(a.scope, { name: "snapshot app", description: null });
    await apps.assignResources(a.scope, snapApp, [resA.id]);
    const [mappingA] = await db.select().from(t.application_resources).where(eq(t.application_resources.resource_id, resA.id));
    expect(ruleA).toBeDefined();
    expect(mappingA?.application_id).toBe(snapApp);

    const snapshot = async () => ({
      workspace: await db.select().from(t.workspaces).where(eq(t.workspaces.id, a.workspaceId)),
      profile: await db.select().from(t.profiles).where(eq(t.profiles.id, a.userId)),
      connection: await db.select().from(t.provider_connections).where(eq(t.provider_connections.workspace_id, a.workspaceId)),
      accounts: await db.select().from(t.provider_accounts).where(eq(t.provider_accounts.workspace_id, a.workspaceId)),
      resources: await db.select().from(t.provider_resources).where(eq(t.provider_resources.workspace_id, a.workspaceId)),
      applications: await db.select().from(t.applications).where(eq(t.applications.workspace_id, a.workspaceId)),
      mappings: await db.select().from(t.application_resources).where(eq(t.application_resources.workspace_id, a.workspaceId)),
      alerts: await db.select().from(t.alerts).where(eq(t.alerts.workspace_id, a.workspaceId)),
      rules: await db.select().from(t.alert_rules).where(eq(t.alert_rules.workspace_id, a.workspaceId)),
      deliveries: await db.select().from(t.notification_deliveries).where(eq(t.notification_deliveries.workspace_id, a.workspaceId)),
      syncRuns: await db.select().from(t.sync_runs).where(eq(t.sync_runs.workspace_id, a.workspaceId)),
      costs: await db.select().from(t.cost_records).where(eq(t.cost_records.workspace_id, a.workspaceId)),
      samples: await db.select().from(t.usage_samples).where(eq(t.usage_samples.workspace_id, a.workspaceId)),
      quotas: await db.select().from(t.quota_rules).where(eq(t.quota_rules.workspace_id, a.workspaceId)),
    });
    const before = await snapshot();
    const day = 5;
    const yesterday = new Date(Date.now() - 86_400_000);

    // Reads, as user B with A's ids: nothing may come back.
    expect(await inv.getScopePlan(b.scope, "account", accA.id)).toBeNull();
    expect(await inv.getScopePlan(b.scope, "resource", resA.id)).toBeNull();
    expect(await inv.listSyncRuns(b.scope, connA.id, 10)).toEqual([]);
    expect(await alerts.listInbox(b.scope, 10)).toEqual([]);
    expect(await alerts.listDeliveriesForAlert(b.scope, alertA.id)).toEqual([]);
    expect(await alerts.getAlert(b.scope, alertA.id)).toBeNull();
    expect(await alerts.listFutureCosts(b.scope, new Date().toISOString())).toEqual([]);
    expect(await samples.loadSamples(b.scope, { from: yesterday })).toEqual([]);
    expect(await samples.loadSamples(b.scope, { from: yesterday, resourceIds: [resA.id] })).toEqual([]);
    expect(await samples.loadSamples(b.scope, { from: yesterday, accountIds: [accA.id] })).toEqual([]);
    expect(await samples.loadSamples(b.scope, { from: yesterday, resourceIds: [resA.id], accountIds: [accA.id] })).toEqual([]);
    expect(await alerts.countOpenAlerts(b.scope)).toBe(0);
    expect(await alerts.countUnreadInApp(b.scope)).toBe(0);
    expect(await inv.listAccounts(b.scope)).toEqual([]);
    expect(await inv.listApplicationMappings(b.scope)).toEqual([]);
    expect((await inv.listApplications(b.scope)).map((x) => x.id)).not.toContain(appA.id);
    expect((await alerts.listAlertRules(b.scope)).map((x) => x.id)).not.toContain(ruleA.id);

    // Writes, as user B with A's ids: all no-ops.
    expect(await inv.setAccountCycleDay(b.scope, accA.id, day)).toBeNull();
    await inv.deleteConnection(b.scope, connA.id);
    await alerts.updateAlertRule(b.scope, ruleA.id, { enabled: false, notify_email: false });
    expect(await alerts.markDeliveryRead(b.scope, deliveryA.id)).toBeNull();
    await alerts.markAllInAppRead(b.scope);
    await apps.unassignResource(b.scope, mappingA.resource_id);
    await apps.removeResourceFromApplication(b.scope, mappingA.application_id, mappingA.resource_id);
    await apps.updateApplication(b.scope, appA.id, { name: "hacked", description: "hacked" });
    await alerts.muteAlert(b.scope, alertA.id, new Date(Date.now() + 3_600_000).toISOString());
    await alerts.unmuteAlert(b.scope, alertA.id);
    await alerts.acknowledgeAlert(b.scope, alertA.id);

    // B's own settings change, A's do not.
    await account.updateWorkspace(b.scope, { name: "B again" });
    await account.setDisplayName(b.scope, "B person");

    expect(await snapshot()).toEqual(before);
    const [deliveryAfter] = await db.select().from(t.notification_deliveries).where(eq(t.notification_deliveries.id, deliveryA.id));
    expect(deliveryAfter.read_at).toBeNull();
    expect(syncA.id).toBeDefined();
    expect(costA.id).toBeDefined();
    const [profileB] = await db.select().from(t.profiles).where(eq(t.profiles.id, b.userId));
    expect(profileB.display_name).toBe("B person");

    // Control: the owner can see the same rows through the same functions.
    expect((await inv.getScopePlan(a.scope, "resource", resA.id))).not.toBeNull();
    expect((await inv.listSyncRuns(a.scope, connA.id, 10)).map((r) => r.id)).toEqual([syncA.id]);
    expect((await alerts.listInbox(a.scope, 10)).map((r) => r.id)).toEqual([deliveryA.id]);
    expect((await alerts.listFutureCosts(a.scope, new Date().toISOString())).map((r) => r.id)).toEqual([costA.id]);
    expect(await samples.loadSamples(a.scope, { from: yesterday })).toHaveLength(1);
  });

  it("ignores smuggled keys at runtime", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const inv = await import("@/db/repos/inventory");
    const alerts = await import("@/db/repos/alerts");
    const account = await import("@/db/repos/account");
    const [rule] = await db.select().from(t.alert_rules).where(eq(t.alert_rules.workspace_id, a.workspaceId)).limit(1);

    await account.updateWorkspace(b.scope, { name: "x", owner_id: "evil" } as never);
    const [wb] = await db.select().from(t.workspaces).where(eq(t.workspaces.id, b.workspaceId));
    expect(wb.name).toBe("x");
    expect(wb.owner_id).toBe(b.userId);

    await alerts.updateAlertRule(a.scope, rule.id, { enabled: false, workspace_id: b.workspaceId } as never);
    const [ruleAfter] = await db.select().from(t.alert_rules).where(eq(t.alert_rules.id, rule.id));
    expect(ruleAfter.enabled).toBe(false); // the allowed key went through
    expect(ruleAfter.workspace_id).toBe(a.workspaceId); // the smuggled one did not

    await inv.patchConnection(a.scope, connA.id, { label: "ok", granted_scopes: ["evil"] } as never);
    const [conn] = await db.select().from(t.provider_connections).where(eq(t.provider_connections.id, connA.id));
    expect(conn.label).toBe("ok");
    expect(conn.granted_scopes).toEqual([]);
    await inv.patchConnection(a.scope, connA.id, { label: "A" });

    const quotas = await import("@/db/repos/quotas");
    const key = { metric_key: "demo.database_size", scope_type: "resource" as const, scopeId: resA.id, unit: "bytes" };
    const values = { limit_value: 3, overage_effect: "none", pricing_rule_id: null, notes: null, verified_at: new Date().toISOString() };
    const smuggled = { ...values, source: "provider", workspace_id: b.workspaceId };
    await quotas.saveUserQuota(a.scope, key, smuggled); // insert path
    await quotas.saveUserQuota(a.scope, key, { ...smuggled, limit_value: 4 }); // update path
    const stored = await db.select().from(t.quota_rules).where(and(eq(t.quota_rules.resource_id, resA.id), eq(t.quota_rules.created_by, a.userId)));
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("user");
    expect(stored[0].workspace_id).toBe(a.workspaceId);
    expect(stored[0].limit_value).toBe(4);
    await quotas.deleteUserQuota(a.scope, stored[0].id);
  });

  it("does not reopen a resolved alert and treats two empty id lists as matching nothing", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const alerts = await import("@/db/repos/alerts");
    const samples = await import("@/db/repos/samples");
    const [resolved] = await db
      .insert(t.alerts)
      .values({
        workspace_id: a.workspaceId,
        category: "quota_threshold",
        severity: "warning",
        status: "resolved",
        dedupe_key: "resolved-k",
        group_key: "g",
        title: "Resolved",
        message: "m",
        resolved_at: new Date().toISOString(),
      })
      .returning();

    await alerts.muteAlert(a.scope, resolved.id, new Date(Date.now() + 3_600_000).toISOString());
    await alerts.unmuteAlert(a.scope, resolved.id);
    await alerts.acknowledgeAlert(a.scope, resolved.id);
    const [after] = await db.select().from(t.alerts).where(eq(t.alerts.id, resolved.id));
    expect(after.status).toBe("resolved");

    const from = new Date(Date.now() - 86_400_000);
    expect(await samples.loadSamples(a.scope, { from, resourceIds: [], accountIds: [] })).toEqual([]);
    expect(await samples.loadSamples(a.scope, { from })).toHaveLength(1); // no id filter: still sees its own
  });

  describe("join constraints (cross-workspace references are not followed)", () => {
    it("getAlertDetail returns the populated relations for valid data", async () => {
      const { db } = await import("@/db/client");
      const t = await import("@/db/schema");
      const alerts = await import("@/db/repos/alerts");
      const [full] = await db
        .insert(t.alerts)
        .values({
          workspace_id: a.workspaceId,
          category: "quota_threshold",
          severity: "warning",
          dedupe_key: "full-k",
          group_key: "g",
          title: "Full",
          message: "m",
          connection_id: connA.id,
          resource_id: resA.id,
          account_id: accA.id,
          application_id: appA.id,
        })
        .returning();
      const detail = await alerts.getAlertDetail(a.scope, full.id);
      expect(detail?.id).toBe(full.id);
      expect(detail?.provider_connections).toEqual({ id: connA.id, label: "A", provider: "demo" });
      expect(detail?.provider_resources).toEqual({ id: resA.id, name: "a-res", dashboard_url: null });
      expect(detail?.provider_accounts).toEqual({ id: accA.id, name: "a-acc", dashboard_url: null });
      expect(detail?.applications).toEqual({ id: appA.id, name: "A app" });
    });

    it("getAlertDetail ignores relations that live in another workspace", async () => {
      const { db } = await import("@/db/client");
      const t = await import("@/db/schema");
      const alerts = await import("@/db/repos/alerts");
      const [connB] = await db.insert(t.provider_connections).values({ workspace_id: b.workspaceId, provider: "demo", label: "B", auth_method: "demo", status: "connected", next_sync_at: null }).returning();
      const [accB] = await db.insert(t.provider_accounts).values({ workspace_id: b.workspaceId, connection_id: connB.id, provider: "demo", external_id: "acc-b", name: "b-acc" }).returning();
      const [resB] = await db.insert(t.provider_resources).values({ workspace_id: b.workspaceId, connection_id: connB.id, provider: "demo", external_id: "rb", name: "b-res", resource_type: "project" }).returning();
      const [appB] = await db.insert(t.applications).values({ workspace_id: b.workspaceId, name: "B app" }).returning();
      const [pointing] = await db
        .insert(t.alerts)
        .values({
          workspace_id: a.workspaceId,
          category: "quota_threshold",
          severity: "warning",
          dedupe_key: "cross-k",
          group_key: "g",
          title: "Points at B",
          message: "m",
          connection_id: connB.id,
          resource_id: resB.id,
          account_id: accB.id,
          application_id: appB.id,
        })
        .returning();
      const detail = await alerts.getAlertDetail(a.scope, pointing.id);
      expect(detail?.id).toBe(pointing.id);
      expect(detail?.provider_connections).toBeNull();
      expect(detail?.provider_resources).toBeNull();
      expect(detail?.provider_accounts).toBeNull();
      expect(detail?.applications).toBeNull();
    });

    it("listInbox does not follow an alert in another workspace", async () => {
      const { db } = await import("@/db/client");
      const t = await import("@/db/schema");
      const alerts = await import("@/db/repos/alerts");
      const [alertB] = await db
        .insert(t.alerts)
        .values({ workspace_id: b.workspaceId, category: "quota_threshold", severity: "warning", dedupe_key: "kb", group_key: "g", title: "B alert", message: "m" })
        .returning();
      const [foreign] = await db
        .insert(t.notification_deliveries)
        .values({ workspace_id: a.workspaceId, alert_id: alertB.id, channel: "in_app", status: "sent" })
        .returning();
      const inbox = await alerts.listInbox(a.scope, 50);
      const row = inbox.find((r) => r.id === foreign.id);
      expect(row).toBeDefined();
      expect(row?.alerts).toBeNull();
      expect(inbox.find((r) => r.id === deliveryA.id)?.alerts?.id).toBe(alertA.id); // control
    });

    it("getScopePlan does not read the plan of an account in another workspace", async () => {
      const { db } = await import("@/db/client");
      const t = await import("@/db/schema");
      const inv = await import("@/db/repos/inventory");
      const [accB] = await db.select().from(t.provider_accounts).where(eq(t.provider_accounts.workspace_id, b.workspaceId)).limit(1);
      await db.update(t.provider_accounts).set({ plan: "enterprise" }).where(eq(t.provider_accounts.id, accB.id));
      await db.update(t.provider_accounts).set({ plan: "pro" }).where(eq(t.provider_accounts.id, accA.id));
      const [linked] = await db
        .insert(t.provider_resources)
        .values({ workspace_id: a.workspaceId, connection_id: connA.id, account_id: accB.id, provider: "demo", external_id: "linked-b", name: "linked-b", resource_type: "project" })
        .returning();
      expect(await inv.getScopePlan(a.scope, "resource", linked.id)).toEqual({ plan: null });
      expect(await inv.getScopePlan(a.scope, "resource", resA.id)).toEqual({ plan: "pro" }); // control
    });

    it("listQuotasWithEvaluations ignores an evaluation stamped with another workspace", async () => {
      const { db } = await import("@/db/client");
      const t = await import("@/db/schema");
      const quotas = await import("@/db/repos/quotas");
      await db.insert(t.quota_evaluations).values({ quota_rule_id: providerQuotaA.id, workspace_id: b.workspaceId, data_state: "fresh" });
      const foreign = (await quotas.listQuotasWithEvaluations(a.scope)).find((q) => q.id === providerQuotaA.id);
      expect(foreign).toBeDefined();
      expect(foreign?.quota_evaluations).toBeNull();

      await db.update(t.quota_evaluations).set({ workspace_id: a.workspaceId }).where(eq(t.quota_evaluations.quota_rule_id, providerQuotaA.id));
      const own = (await quotas.listQuotasWithEvaluations(a.scope)).find((q) => q.id === providerQuotaA.id);
      expect(own?.quota_evaluations?.quota_rule_id).toBe(providerQuotaA.id); // control
    });
  });

  describe("alert status guards", () => {
    const fresh = async (key: string) => {
      const { db } = await import("@/db/client");
      const t = await import("@/db/schema");
      const [row] = await db
        .insert(t.alerts)
        .values({ workspace_id: a.workspaceId, category: "quota_threshold", severity: "warning", dedupe_key: key, group_key: "g", title: key, message: "m" })
        .returning();
      const read = async () => (await db.select().from(t.alerts).where(eq(t.alerts.id, row.id)))[0];
      return { id: row.id, read };
    };

    it("walks open -> acknowledged -> muted -> open", async () => {
      const alerts = await import("@/db/repos/alerts");
      const { id, read } = await fresh("walk");
      await alerts.acknowledgeAlert(a.scope, id);
      let row = await read();
      expect(row.status).toBe("acknowledged");
      expect(row.acknowledged_by).toBe(a.userId);

      const first = new Date(Date.now() + 3_600_000).toISOString();
      await alerts.muteAlert(a.scope, id, first);
      row = await read();
      expect(row.status).toBe("muted");
      expect(Date.parse(row.muted_until!)).toBe(Date.parse(first));

      const later = new Date(Date.now() + 7_200_000).toISOString();
      await alerts.muteAlert(a.scope, id, later); // re-mute extends
      row = await read();
      expect(row.status).toBe("muted");
      expect(Date.parse(row.muted_until!)).toBe(Date.parse(later));

      await alerts.unmuteAlert(a.scope, id);
      row = await read();
      expect(row.status).toBe("open");
      expect(row.muted_until).toBeNull();
    });

    it("unmute only applies to muted alerts, and acknowledge only to open ones", async () => {
      const alerts = await import("@/db/repos/alerts");
      const open = await fresh("guard-open");
      await alerts.unmuteAlert(a.scope, open.id);
      expect((await open.read()).status).toBe("open");

      const acked = await fresh("guard-acked");
      await alerts.acknowledgeAlert(a.scope, acked.id);
      const stamp = (await acked.read()).acknowledged_at;
      await alerts.acknowledgeAlert(a.scope, acked.id); // second ack: no-op
      expect((await acked.read()).acknowledged_at).toBe(stamp);
      await alerts.unmuteAlert(a.scope, acked.id);
      expect((await acked.read()).status).toBe("acknowledged");

      const muted = await fresh("guard-muted");
      await alerts.muteAlert(a.scope, muted.id, new Date(Date.now() + 3_600_000).toISOString());
      await alerts.acknowledgeAlert(a.scope, muted.id);
      expect((await muted.read()).status).toBe("muted");
    });
  });
});
