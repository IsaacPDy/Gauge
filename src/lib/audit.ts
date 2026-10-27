import type { Json } from "./supabase/database.types";
import { adminClient } from "./supabase/admin";

/** Record a security-relevant action. Never pass secrets in `details`. */
export async function audit(entry: {
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}) {
  const { error } = await adminClient()
    .from("audit_logs")
    .insert({
      workspace_id: entry.workspaceId,
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: (entry.details ?? {}) as Json,
    });
  if (error) console.error(`[audit] failed to record ${entry.action}: ${error.message}`);
}
