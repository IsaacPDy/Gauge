import { renderAlertEmail } from "../email/alert-email";
import { sendEmail } from "../email/transport";
import { getMetric, PROVIDER_NAMES } from "../providers/registry";
import { adminClient } from "../supabase/admin";
import { must } from "./db";

const MAX_ATTEMPTS = 5;

/**
 * Sends due email deliveries. Each delivery row is unique per (alert, channel), so a retry
 * after a crash or failure can never produce a second alert or a second row.
 */
export async function deliverDueNotifications(): Promise<{ sent: number; failed: number; skipped: number }> {
  const admin = adminClient();
  const claimed = must(await admin.rpc("claim_due_deliveries", { p_limit: 25 }), "Claim deliveries") ?? [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const d of claimed) {
    const alert = must(
      await admin
        .from("alerts")
        .select(
          "*, provider_connections(label, provider), provider_resources(name), provider_accounts(name), applications(name)",
        )
        .eq("id", d.alert_id)
        .maybeSingle(),
      "Load alert",
    );
    if (!alert || alert.status === "muted" || alert.status === "resolved" || !d.recipient) {
      await admin
        .from("notification_deliveries")
        .update({ status: "skipped", last_error: !d.recipient ? "No recipient" : `Alert is ${alert?.status ?? "deleted"}` })
        .eq("id", d.id);
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
      await admin
        .from("notification_deliveries")
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
        .eq("id", d.id);
      sent++;
    } catch (e) {
      const giveUp = d.attempts >= MAX_ATTEMPTS;
      await admin
        .from("notification_deliveries")
        .update({
          status: giveUp ? "failed" : "pending",
          last_error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
          next_attempt_at: new Date(Date.now() + 2 ** d.attempts * 60_000).toISOString(),
        })
        .eq("id", d.id);
      failed++;
    }
  }
  return { sent, failed, skipped };
}
