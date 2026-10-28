import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, lte, ne, notInArray, or, isNull, lt, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasTestDb, useTestDb } from "../helpers/test-db";

// Exercises the background jobs (sync, recalculation, notifications, scheduler) end to end
// against the real database, using the built-in demo provider and no auth account.
describe.skipIf(!hasTestDb)("background jobs", { timeout: 60_000 }, () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let workspaceId: string;
  let connectionId: string;
  const previousTransport = process.env.EMAIL_TRANSPORT;

  beforeAll(async () => {
    await useTestDb();
    process.env.EMAIL_TRANSPORT = "console";
    vi.spyOn(console, "info").mockImplementation(() => {}); // the console email transport logs every message

    const { ensureUserWorkspace } = await import("@/db/bootstrap");
    const { db } = await import("@/db/client");
    const { provider_connections } = await import("@/db/schema");
    const { saveCredentials } = await import("@/lib/jobs/credentials");
    const id = randomUUID();
    users.push(id);
    const ws = await ensureUserWorkspace({ id, email: `jobs-${id}@limitgauge.test` });
    workspaceId = ws.id;
    workspaces.push(ws.id);
    const [conn] = await db
      .insert(provider_connections)
      .values({ workspace_id: ws.id, provider: "demo", label: "jobs test", auth_method: "demo", status: "syncing", capabilities: { declared: {} } })
      .returning();
    connectionId = conn.id;
    await saveCredentials(conn, { kind: "demo", simulate: "none" });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousTransport === undefined) delete process.env.EMAIL_TRANSPORT;
    else process.env.EMAIL_TRANSPORT = previousTransport;
    const { deleteUserData } = await import("@/db/bootstrap");
    for (const id of users) await deleteUserData(id);
  });

  const sampleCount = async () => {
    const { db } = await import("@/db/client");
    const { usage_samples } = await import("@/db/schema");
    return (await db.select({ n: count() }).from(usage_samples).where(eq(usage_samples.connection_id, connectionId)))[0].n;
  };

  /** Connections or email deliveries from outside this test that a global claim would also pick up. */
  const foreignWork = async () => {
    const { db } = await import("@/db/client");
    const { notification_deliveries, provider_connections } = await import("@/db/schema");
    const [conns] = await db
      .select({ n: count() })
      .from(provider_connections)
      .where(
        and(
          notInArray(provider_connections.workspace_id, workspaces),
          ne(provider_connections.status, "disconnected"),
          lte(provider_connections.next_sync_at, sql`now()`),
          or(isNull(provider_connections.locked_until), lt(provider_connections.locked_until, sql`now()`)),
        ),
      );
    const [mails] = await db
      .select({ n: count() })
      .from(notification_deliveries)
      .where(
        and(
          notInArray(notification_deliveries.workspace_id, workspaces),
          eq(notification_deliveries.channel, "email"),
          inArray(notification_deliveries.status, ["pending", "sending"]),
          lte(notification_deliveries.next_attempt_at, sql`now()`),
        ),
      );
    return conns.n + mails.n;
  };

  it("connect sync discovers accounts and resources and records a finished run", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const { runConnectionSync } = await import("@/lib/jobs/sync");

    const res = await runConnectionSync(connectionId, "connect");
    expect(["succeeded", "partial"]).toContain(res.status);
    expect(res.workspaceId).toBe(workspaceId);

    expect((await db.select({ n: count() }).from(t.provider_accounts).where(eq(t.provider_accounts.connection_id, connectionId)))[0].n).toBeGreaterThan(0);
    expect((await db.select({ n: count() }).from(t.provider_resources).where(eq(t.provider_resources.connection_id, connectionId)))[0].n).toBeGreaterThan(0);

    const [conn] = await db.select().from(t.provider_connections).where(eq(t.provider_connections.id, connectionId));
    expect(conn.status).toBe("connected");
    expect(conn.locked_until).toBeNull();
    expect(conn.consecutive_failures).toBe(0);

    const runs = await db.select().from(t.sync_runs).where(eq(t.sync_runs.connection_id, connectionId));
    expect(runs).toHaveLength(1);
    expect(["succeeded", "partial"]).toContain(runs[0].status);
    expect(runs[0].finished_at).not.toBeNull();
  });

  it("re-syncing is idempotent and keeps the user's monitoring choice", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const { runConnectionSync } = await import("@/lib/jobs/sync");

    const resources = await db.select().from(t.provider_resources).where(eq(t.provider_resources.connection_id, connectionId));
    const picked = resources.slice(0, 2).map((r) => r.id);
    expect(picked).toHaveLength(2);
    await db.update(t.provider_resources).set({ is_monitored: true }).where(inArray(t.provider_resources.id, picked));

    expect(["succeeded", "partial"]).toContain((await runConnectionSync(connectionId, "manual")).status);
    const first = await sampleCount();
    expect(first).toBeGreaterThan(0);
    expect(["succeeded", "partial"]).toContain((await runConnectionSync(connectionId, "manual")).status);
    expect(await sampleCount()).toBe(first);

    const monitored = await db
      .select({ id: t.provider_resources.id })
      .from(t.provider_resources)
      .where(and(eq(t.provider_resources.connection_id, connectionId), eq(t.provider_resources.is_monitored, true)));
    expect(monitored.map((r) => r.id).sort()).toEqual([...picked].sort());
  });

  it("recalculation stores evaluations, raises alerts with deliveries, and never duplicates them", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const { recalculateWorkspace } = await import("@/lib/jobs/recalc");

    const [sample] = await db.select().from(t.usage_samples).where(eq(t.usage_samples.connection_id, connectionId)).limit(1);
    const [quota] = await db
      .insert(t.quota_rules)
      .values({
        workspace_id: workspaceId,
        metric_key: sample.metric_key,
        scope_type: "resource",
        resource_id: sample.resource_id,
        account_id: null,
        limit_value: 1,
        unit: sample.unit,
        source: "user",
        overage_effect: "none",
      })
      .returning();

    const first = await recalculateWorkspace(workspaceId);
    expect(first.quotas).toBeGreaterThan(0);
    const evals = await db.select().from(t.quota_evaluations).where(eq(t.quota_evaluations.workspace_id, workspaceId));
    expect(evals).toHaveLength(first.quotas);
    const mine = evals.find((e) => e.quota_rule_id === quota.id);
    expect(mine?.is_effective).toBe(true);
    expect(mine?.percent_used ?? 0).toBeGreaterThan(0);

    expect(first.newAlerts).toBeGreaterThanOrEqual(1);
    const alertsBefore = await db.select().from(t.alerts).where(eq(t.alerts.workspace_id, workspaceId));
    expect(alertsBefore.length).toBe(first.newAlerts);
    const deliveries = await db.select().from(t.notification_deliveries).where(eq(t.notification_deliveries.workspace_id, workspaceId));
    const inApp = deliveries.filter((d) => d.channel === "in_app");
    expect(inApp.length).toBeGreaterThanOrEqual(1);
    expect(inApp.every((d) => d.status === "sent")).toBe(true);
    expect(deliveries.filter((d) => d.channel === "email").length).toBeGreaterThanOrEqual(1);
    // Every alert has exactly one row per channel.
    expect(deliveries).toHaveLength(alertsBefore.length * 2);

    const second = await recalculateWorkspace(workspaceId);
    expect(second.newAlerts).toBe(0);
    expect(await db.select().from(t.alerts).where(eq(t.alerts.workspace_id, workspaceId))).toHaveLength(alertsBefore.length);
    expect(await db.select().from(t.notification_deliveries).where(eq(t.notification_deliveries.workspace_id, workspaceId))).toHaveLength(deliveries.length);
  });

  it("deliverDueNotifications sends pending emails and skips those whose alert is resolved", async (ctx) => {
    if ((await foreignWork()) > 0) ctx.skip(); // never touch someone else's deliveries on a shared database
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const { deliverDueNotifications } = await import("@/lib/jobs/notify");

    const [resolved] = await db
      .insert(t.alerts)
      .values({
        workspace_id: workspaceId,
        category: "quota_threshold",
        severity: "warning",
        status: "resolved",
        dedupe_key: "jobs-test-resolved",
        group_key: "jobs-test",
        title: "Resolved",
        message: "m",
        resolved_at: new Date().toISOString(),
      })
      .returning();
    const [stale] = await db
      .insert(t.notification_deliveries)
      .values({ workspace_id: workspaceId, alert_id: resolved.id, channel: "email", recipient: "jobs@limitgauge.test", status: "pending" })
      .returning();

    const result = await deliverDueNotifications();
    expect(result.failed).toBe(0);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const emails = await db
      .select()
      .from(t.notification_deliveries)
      .where(and(eq(t.notification_deliveries.workspace_id, workspaceId), eq(t.notification_deliveries.channel, "email")));
    expect(emails.filter((d) => d.status === "pending" || d.status === "sending")).toHaveLength(0);
    expect(emails.filter((d) => d.status === "sent").length).toBeGreaterThanOrEqual(1);
    const skippedRow = emails.find((d) => d.id === stale.id);
    expect(skippedRow?.status).toBe("skipped");
    expect(skippedRow?.last_error).toBe("Alert is resolved");
  });

  it("the scheduler claims a due connection, syncs it and recalculates its workspace", async (ctx) => {
    if ((await foreignWork()) > 0) ctx.skip();
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const { runSchedulerTick } = await import("@/lib/jobs/scheduler");

    await db
      .update(t.provider_connections)
      .set({ status: "syncing", next_sync_at: new Date(Date.now() - 60_000).toISOString(), locked_until: null })
      .where(eq(t.provider_connections.id, connectionId));
    const runsBefore = (await db.select({ n: count() }).from(t.sync_runs).where(eq(t.sync_runs.connection_id, connectionId)))[0].n;

    // The first tick of a process also sweeps every workspace with a connection (it compares
    // Date.now() with 0). Pin Date.now() to 0 so the sweep is skipped and only our own,
    // freshly synced workspace is recalculated; other tests' workspaces stay untouched.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    let tick: Awaited<ReturnType<typeof runSchedulerTick>>;
    try {
      tick = await runSchedulerTick();
    } finally {
      nowSpy.mockRestore();
    }

    expect(tick.skipped).toBeUndefined();
    const mineSynced = tick.synced.filter((s) => s.connectionId === connectionId);
    expect(mineSynced).toHaveLength(1);
    expect(["succeeded", "partial"]).toContain(mineSynced[0].status);
    expect(tick.recalculated).toBeGreaterThanOrEqual(1);

    const [conn] = await db.select().from(t.provider_connections).where(eq(t.provider_connections.id, connectionId));
    expect(conn.status).toBe("connected");
    expect(conn.locked_until).toBeNull();
    const runs = await db.select().from(t.sync_runs).where(eq(t.sync_runs.connection_id, connectionId));
    expect(runs).toHaveLength(runsBefore + 1);
    expect(runs.some((r) => r.trigger === "scheduled")).toBe(true);
  });

  it("a failing sync leaves the connection needing re-authorization, unlocked, with a failed run", async () => {
    const { db } = await import("@/db/client");
    const t = await import("@/db/schema");
    const { saveCredentials } = await import("@/lib/jobs/credentials");
    const { runConnectionSync } = await import("@/lib/jobs/sync");

    const [bad] = await db
      .insert(t.provider_connections)
      .values({ workspace_id: workspaceId, provider: "demo", label: "jobs test (expired)", auth_method: "demo", status: "syncing", capabilities: { declared: {} } })
      .returning();
    await saveCredentials(bad, { kind: "demo", simulate: "auth_expired" });

    const res = await runConnectionSync(bad.id, "connect");
    expect(res.status).toBe("failed");
    expect(res.errorCode).toBe("auth_invalid");

    const [conn] = await db.select().from(t.provider_connections).where(eq(t.provider_connections.id, bad.id));
    expect(conn.status).toBe("reauth_required");
    expect(conn.locked_until).toBeNull();
    expect(conn.consecutive_failures).toBe(1);
    expect(conn.last_error_code).toBe("auth_invalid");
    expect(conn.next_sync_at).toBeNull();

    const runs = await db.select().from(t.sync_runs).where(eq(t.sync_runs.connection_id, bad.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error_code).toBe("auth_invalid");
    expect(runs[0].finished_at).not.toBeNull();
  });
});
