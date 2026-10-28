import { eq, type SQL } from "drizzle-orm";
import { db } from "./client";
import { alerts, applications, provider_accounts, provider_connections, provider_resources } from "./schema";

/**
 * One alert plus the connection, resource, account and application it points at (each null
 * when unset). Same shape the PostgREST embedded select returned. `where` must already
 * constrain the workspace when called on behalf of a user (see repos/alerts.ts).
 */
export async function selectAlertWithRelations(where: SQL) {
  const [r] = await db
    .select({
      alert: alerts,
      conn: { id: provider_connections.id, label: provider_connections.label, provider: provider_connections.provider },
      res: { id: provider_resources.id, name: provider_resources.name, dashboard_url: provider_resources.dashboard_url },
      acc: { id: provider_accounts.id, name: provider_accounts.name, dashboard_url: provider_accounts.dashboard_url },
      app: { id: applications.id, name: applications.name },
    })
    .from(alerts)
    .leftJoin(provider_connections, eq(alerts.connection_id, provider_connections.id))
    .leftJoin(provider_resources, eq(alerts.resource_id, provider_resources.id))
    .leftJoin(provider_accounts, eq(alerts.account_id, provider_accounts.id))
    .leftJoin(applications, eq(alerts.application_id, applications.id))
    .where(where)
    .limit(1);
  if (!r) return null;
  return { ...r.alert, provider_connections: r.conn, provider_resources: r.res, provider_accounts: r.acc, applications: r.app };
}
