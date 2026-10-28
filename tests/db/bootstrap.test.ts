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
    const { alert_rules, workspace_members, workspaces } = await import("@/db/schema");
    const user = newUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureUserWorkspace(user)));
    expect(new Set(results.map((w) => w.id)).size).toBe(1);
    expect(await db.select().from(workspaces).where(eq(workspaces.owner_id, user.id))).toHaveLength(1);
    expect(await db.select().from(workspace_members).where(eq(workspace_members.workspace_id, results[0].id))).toHaveLength(1);
    expect(await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, results[0].id))).toHaveLength(4);
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

  it("deleteUserData leaves other users untouched", async () => {
    const { ensureUserWorkspace, deleteUserData } = await import("@/db/bootstrap");
    const { db } = await import("@/db/client");
    const { alert_rules, profiles, workspaces } = await import("@/db/schema");
    const first = newUser();
    const second = newUser();
    const wsFirst = await ensureUserWorkspace(first);
    const wsSecond = await ensureUserWorkspace(second);
    await deleteUserData(first.id);

    expect(await db.select().from(workspaces).where(eq(workspaces.id, wsFirst.id))).toHaveLength(0);
    expect(await db.select().from(profiles).where(eq(profiles.id, first.id))).toHaveLength(0);
    expect(await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, wsFirst.id))).toHaveLength(0);

    expect(await db.select().from(workspaces).where(eq(workspaces.id, wsSecond.id))).toHaveLength(1);
    expect(await db.select().from(profiles).where(eq(profiles.id, second.id))).toHaveLength(1);
    expect(await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, wsSecond.id))).toHaveLength(4);
  });

  it("the seeded quota thresholds match the app default", async () => {
    const { ensureUserWorkspace } = await import("@/db/bootstrap");
    const { db } = await import("@/db/client");
    const { alert_rules } = await import("@/db/schema");
    const { DEFAULT_THRESHOLDS } = await import("@/lib/types");
    const ws = await ensureUserWorkspace(newUser());
    const rules = await db.select().from(alert_rules).where(eq(alert_rules.workspace_id, ws.id));
    expect(rules.find((r) => r.category === "quota_threshold")?.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it("deleteUserData rejects a blank user id", async () => {
    const { deleteUserData } = await import("@/db/bootstrap");
    await expect(deleteUserData("   ")).rejects.toThrow(/userId is required/);
  });
});
