import { eq, ne } from "drizzle-orm";
import { claimDueConnections } from "../../db/claims";
import { db } from "../../db/client";
import { dbErrorMessage } from "../../db/errors";
import { provider_connections } from "../../db/schema";
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
    const due = await claimDueConnections(10);

    const synced: TickSummary["synced"] = [];
    const touched = new Set<string>();
    // Small concurrency: connections are independent, but provider rate limits are per account.
    const queue = [...due];
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          touched.add(c.workspace_id);
          try {
            const res = await runConnectionSync(c.id, "scheduled", { alreadyClaimed: true });
            synced.push({ connectionId: c.id, status: res.status });
          } catch (e) {
            console.error(`[scheduler] sync failed for connection ${c.id}: ${dbErrorMessage(e)}`);
            synced.push({ connectionId: c.id, status: "failed" });
            // Release the claim now rather than leaving the connection locked until the lock expires.
            try {
              await db.update(provider_connections).set({ locked_until: null }).where(eq(provider_connections.id, c.id));
            } catch (e2) {
              console.error(`[scheduler] could not release connection ${c.id}: ${dbErrorMessage(e2)}`);
            }
          }
        }
      }),
    );

    if (Date.now() - lastHealthSweep > HEALTH_SWEEP_MS) {
      lastHealthSweep = Date.now();
      const rows = await db
        .selectDistinct({ workspace_id: provider_connections.workspace_id })
        .from(provider_connections)
        .where(ne(provider_connections.status, "disconnected"));
      for (const r of rows) touched.add(r.workspace_id);
    }

    for (const ws of touched) {
      try {
        await recalculateWorkspace(ws, now);
      } catch (e) {
        console.error(`[scheduler] recalculation failed for workspace ${ws}: ${dbErrorMessage(e)}`);
      }
    }

    const delivered = await deliverDueNotifications();
    return { synced, recalculated: touched.size, delivered };
  } finally {
    running = false;
  }
}
