import { eq } from "drizzle-orm";
import { selectAlertWithRelations } from "../../db/alert-relations";
import { claimDueDeliveries } from "../../db/claims";
import { db } from "../../db/client";
import { dbErrorMessage } from "../../db/errors";
import { alerts, notification_deliveries } from "../../db/schema";
import { renderAlertEmail } from "../email/alert-email";
import { sendEmail } from "../email/transport";
import { getMetric, PROVIDER_NAMES } from "../providers/registry";

const MAX_ATTEMPTS = 5;

/**
 * Sends due email deliveries. Each delivery row is unique per (alert, channel), so a retry
 * after a crash or failure can never produce a second alert or a second row.
 */
export async function deliverDueNotifications(): Promise<{ sent: number; failed: number; skipped: number }> {
  const claimed = await claimDueDeliveries(25);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const update = (id: string, patch: Partial<typeof notification_deliveries.$inferInsert>) =>
    db.update(notification_deliveries).set(patch).where(eq(notification_deliveries.id, id));

  for (const d of claimed) {
    // One bad row (a failed read, a render error) must never abort the rest of the batch.
    try {
      if (d.attempts > MAX_ATTEMPTS) {
        await update(d.id, { status: "failed", last_error: "Gave up after repeated failures" });
        failed++;
        continue;
      }

      const alert = await selectAlertWithRelations(eq(alerts.id, d.alert_id));
      if (!alert || alert.status === "muted" || alert.status === "resolved" || !d.recipient) {
        await update(d.id, { status: "skipped", last_error: !d.recipient ? "No recipient" : `Alert is ${alert?.status ?? "deleted"}` });
        skipped++;
        continue;
      }

      try {
        const conn = alert.provider_connections;
        await sendEmail(
          renderAlertEmail({
            to: d.recipient,
            appUrl: process.env.APP_URL ?? "http://localhost:3000",
            alert,
            metricName: alert.metric_key ? (getMetric(alert.metric_key)?.name ?? alert.metric_key) : null,
            providerLabel: conn ? `${PROVIDER_NAMES[conn.provider] ?? conn.provider} · ${conn.label}` : null,
            scopeName: alert.provider_resources?.name ?? alert.provider_accounts?.name ?? null,
            applicationName: alert.applications?.name ?? null,
          }),
        );
      } catch (e) {
        const giveUp = d.attempts >= MAX_ATTEMPTS;
        await update(d.id, {
          status: giveUp ? "failed" : "pending",
          last_error: dbErrorMessage(e).slice(0, 300),
          next_attempt_at: new Date(Date.now() + 2 ** d.attempts * 60_000).toISOString(),
        });
        failed++;
        continue;
      }

      // The email is out. Recording that is best effort: never turn a sent email back into
      // 'pending' (that would send it again). A row stuck in 'sending' is reclaimed after 10 minutes.
      sent++;
      try {
        await update(d.id, { status: "sent", sent_at: new Date().toISOString(), last_error: null });
      } catch (e) {
        console.error(`[notify] sent delivery ${d.id} but could not record it: ${dbErrorMessage(e)}`);
      }
    } catch (e) {
      failed++;
      console.error(`[notify] delivery ${d.id} failed: ${dbErrorMessage(e)}`);
    }
  }
  return { sent, failed, skipped };
}
