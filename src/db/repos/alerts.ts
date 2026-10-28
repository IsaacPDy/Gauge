import { and, asc, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { selectAlertWithRelations } from "../alert-relations";
import { db } from "../client";
import { alert_rules, alerts, cost_records, notification_deliveries } from "../schema";
import type { WorkspaceScope } from "../scope";
import type { Row } from "../types";

export const listAlerts = (s: WorkspaceScope, opts: { statuses?: string[]; limit: number }) =>
  db
    .select()
    .from(alerts)
    .where(and(eq(alerts.workspace_id, s.workspaceId), opts.statuses ? inArray(alerts.status, opts.statuses) : undefined))
    .orderBy(desc(alerts.created_at))
    .limit(opts.limit);

export async function getAlert(s: WorkspaceScope, id: string): Promise<Row<"alerts"> | null> {
  const [row] = await db.select().from(alerts).where(and(eq(alerts.id, id), eq(alerts.workspace_id, s.workspaceId))).limit(1);
  return row ?? null;
}

export const getAlertDetail = (s: WorkspaceScope, id: string) =>
  selectAlertWithRelations(and(eq(alerts.id, id), eq(alerts.workspace_id, s.workspaceId))!);

export const listDeliveriesForAlert = (s: WorkspaceScope, alertId: string) =>
  db
    .select()
    .from(notification_deliveries)
    .where(and(eq(notification_deliveries.alert_id, alertId), eq(notification_deliveries.workspace_id, s.workspaceId)))
    .orderBy(asc(notification_deliveries.channel));

/** In-app notifications with the alert each one is about (null if the alert is gone). */
export async function listInbox(s: WorkspaceScope, limit: number) {
  const rows = await db
    .select({
      id: notification_deliveries.id,
      created_at: notification_deliveries.created_at,
      read_at: notification_deliveries.read_at,
      alert: { id: alerts.id, title: alerts.title, severity: alerts.severity, category: alerts.category, status: alerts.status },
    })
    .from(notification_deliveries)
    .leftJoin(alerts, eq(notification_deliveries.alert_id, alerts.id))
    .where(
      and(
        eq(notification_deliveries.workspace_id, s.workspaceId),
        eq(notification_deliveries.channel, "in_app"),
        eq(notification_deliveries.status, "sent"),
      ),
    )
    .orderBy(desc(notification_deliveries.created_at))
    .limit(limit);
  return rows.map(({ alert, ...rest }) => ({ ...rest, alerts: alert }));
}

const mine = (s: WorkspaceScope, id: string) => and(eq(alerts.id, id), eq(alerts.workspace_id, s.workspaceId));

export async function acknowledgeAlert(s: WorkspaceScope, id: string): Promise<void> {
  await db
    .update(alerts)
    .set({ status: "acknowledged", acknowledged_at: new Date().toISOString(), acknowledged_by: s.userId })
    .where(mine(s, id));
}

export async function muteAlert(s: WorkspaceScope, id: string, untilIso: string): Promise<void> {
  await db.update(alerts).set({ status: "muted", muted_until: untilIso }).where(mine(s, id));
}

export async function unmuteAlert(s: WorkspaceScope, id: string): Promise<void> {
  await db.update(alerts).set({ status: "open", muted_until: null }).where(mine(s, id));
}

/** Marks one notification read. Returns the alert it points at, or null if it is not in this workspace. */
export async function markDeliveryRead(s: WorkspaceScope, deliveryId: string): Promise<string | null> {
  const [row] = await db
    .update(notification_deliveries)
    .set({ read_at: new Date().toISOString() })
    .where(and(eq(notification_deliveries.id, deliveryId), eq(notification_deliveries.workspace_id, s.workspaceId)))
    .returning({ alert_id: notification_deliveries.alert_id });
  return row?.alert_id ?? null;
}

export async function markAllInAppRead(s: WorkspaceScope): Promise<void> {
  await db
    .update(notification_deliveries)
    .set({ read_at: new Date().toISOString() })
    .where(
      and(
        eq(notification_deliveries.workspace_id, s.workspaceId),
        eq(notification_deliveries.channel, "in_app"),
        isNull(notification_deliveries.read_at),
      ),
    );
}

export async function countOpenAlerts(s: WorkspaceScope): Promise<number> {
  const [row] = await db.select({ n: count() }).from(alerts).where(and(eq(alerts.workspace_id, s.workspaceId), eq(alerts.status, "open")));
  return row.n;
}

export async function countUnreadInApp(s: WorkspaceScope): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notification_deliveries)
    .where(
      and(
        eq(notification_deliveries.workspace_id, s.workspaceId),
        eq(notification_deliveries.channel, "in_app"),
        eq(notification_deliveries.status, "sent"),
        isNull(notification_deliveries.read_at),
      ),
    );
  return row.n;
}

export const listAlertRules = (s: WorkspaceScope) => db.select().from(alert_rules).where(eq(alert_rules.workspace_id, s.workspaceId));

type AlertRulePatch = Partial<Pick<Row<"alert_rules">, "enabled" | "thresholds" | "notify_in_app" | "notify_email">>;

export async function updateAlertRule(s: WorkspaceScope, id: string, patch: AlertRulePatch): Promise<void> {
  await db.update(alert_rules).set(patch).where(and(eq(alert_rules.id, id), eq(alert_rules.workspace_id, s.workspaceId)));
}

/** Cost records whose period has not ended yet. */
export const listFutureCosts = (s: WorkspaceScope, nowIso: string) =>
  db.select().from(cost_records).where(and(eq(cost_records.workspace_id, s.workspaceId), gt(cost_records.period_end, nowIso)));
