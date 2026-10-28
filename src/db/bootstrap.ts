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
