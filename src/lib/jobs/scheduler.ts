import { adminClient } from "../supabase/admin";
import { must } from "./db";
import { deliverDueNotifications } from "./notify";
import { recalculateWorkspace } from "./recalc";
import { ensureReferenceData } from "./reference";
import { runConnectionSync } from "./sync";

const HEALTH_SWEEP_MS = 10 * 60_000;
let lastHealthSweep = 0;
let running = false;

export interface TickSummary {
  synced: { connectionId: string; status: string }[];
  recalculated: number;
  delivered: { sent: number; failed: number; skipped: number };
  skipped?: boolean;
}

/**
 * One scheduler pass: collect due connections, re-evaluate affected workspaces (and,
 * periodically, every workspace so stale data is detected), then send notifications.
 */
export async function runSchedulerTick(now = new Date()): Promise<TickSummary> {
  if (running) return { synced: [], recalculated: 0, delivered: { sent: 0, failed: 0, skipped: 0 }, skipped: true };
  running = true;
  try {
    await ensureReferenceData();
    const admin = adminClient();
    const due = must(await admin.rpc("claim_due_connections", { p_limit: 10 }), "Claim due connections") ?? [];

    const synced: TickSummary["synced"] = [];
    const touched = new Set<string>();
    // Small concurrency: connections are independent, but provider rate limits are per account.
    const queue = [...due];
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          const res = await runConnectionSync(c.id, "scheduled", { alreadyClaimed: true });
          synced.push({ connectionId: c.id, status: res.status });
          touched.add(c.workspace_id);
        }
      }),
    );

    if (Date.now() - lastHealthSweep > HEALTH_SWEEP_MS) {
      lastHealthSweep = Date.now();
      const rows = must(
        await admin.from("provider_connections").select("workspace_id").neq("status", "disconnected"),
        "List monitored workspaces",
      );
      for (const r of rows) touched.add(r.workspace_id);
    }

    for (const ws of touched) {
      try {
        await recalculateWorkspace(ws, now);
      } catch (e) {
        console.error(`[scheduler] recalculation failed for workspace ${ws}:`, e);
      }
    }

    const delivered = await deliverDueNotifications();
    return { synced, recalculated: touched.size, delivered };
  } finally {
    running = false;
  }
}
