import { and, count, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { dbErrorMessage } from "../db/errors";
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
    console.error(`[audit] failed to record ${entry.action}: ${dbErrorMessage(e)}`);
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
