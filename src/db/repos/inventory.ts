import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { application_resources, applications, provider_accounts, provider_connections, provider_resources, sync_runs } from "../schema";
import { pick } from "../pick";
import type { WorkspaceScope } from "../scope";
import type { NewRow, Row } from "../types";

export const listConnections = (s: WorkspaceScope) =>
  db.select().from(provider_connections).where(eq(provider_connections.workspace_id, s.workspaceId)).orderBy(asc(provider_connections.created_at));

export const listAccounts = (s: WorkspaceScope) =>
  db.select().from(provider_accounts).where(eq(provider_accounts.workspace_id, s.workspaceId)).orderBy(asc(provider_accounts.name));

export const listResources = (s: WorkspaceScope) =>
  db.select().from(provider_resources).where(eq(provider_resources.workspace_id, s.workspaceId)).orderBy(asc(provider_resources.name));

export const listApplications = (s: WorkspaceScope) =>
  db.select().from(applications).where(eq(applications.workspace_id, s.workspaceId)).orderBy(asc(applications.name));

export const listApplicationMappings = (s: WorkspaceScope) =>
  db
    .select({ application_id: application_resources.application_id, resource_id: application_resources.resource_id })
    .from(application_resources)
    .where(eq(application_resources.workspace_id, s.workspaceId));

export async function getConnection(s: WorkspaceScope, id: string): Promise<Row<"provider_connections"> | null> {
  const [row] = await db
    .select()
    .from(provider_connections)
    .where(and(eq(provider_connections.id, id), eq(provider_connections.workspace_id, s.workspaceId)))
    .limit(1);
  return row ?? null;
}

const CONNECTION_PATCH_KEYS = [
  "label",
  "status",
  "status_detail",
  "status_changed_at",
  "next_sync_at",
  "locked_until",
  "consecutive_failures",
  "disconnected_at",
  "auth_method",
  "last_manual_sync_at",
] as const;

type ConnectionPatch = Partial<Pick<Row<"provider_connections">, (typeof CONNECTION_PATCH_KEYS)[number]>>;

export async function patchConnection(s: WorkspaceScope, id: string, patch: ConnectionPatch): Promise<void> {
  const values = pick(patch, CONNECTION_PATCH_KEYS);
  if (!Object.keys(values).length) return;
  await db
    .update(provider_connections)
    .set(values)
    .where(and(eq(provider_connections.id, id), eq(provider_connections.workspace_id, s.workspaceId)));
}

export async function insertConnection(
  s: WorkspaceScope,
  values: Omit<NewRow<"provider_connections">, "workspace_id" | "created_by">,
): Promise<{ id: string; workspace_id: string }> {
  const [row] = await db
    .insert(provider_connections)
    .values({ ...values, workspace_id: s.workspaceId, created_by: s.userId })
    .returning({ id: provider_connections.id, workspace_id: provider_connections.workspace_id });
  return row;
}

export async function deleteConnection(s: WorkspaceScope, id: string): Promise<void> {
  await db.delete(provider_connections).where(and(eq(provider_connections.id, id), eq(provider_connections.workspace_id, s.workspaceId)));
}

/** Turns monitoring on or off. Returns the connections whose resources changed. */
export async function setResourcesMonitored(
  s: WorkspaceScope,
  ids: string[],
  monitored: boolean,
  onlyConnectionId?: string,
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .update(provider_resources)
    .set({ is_monitored: monitored })
    .where(
      and(
        inArray(provider_resources.id, ids),
        eq(provider_resources.workspace_id, s.workspaceId),
        onlyConnectionId !== undefined ? eq(provider_resources.connection_id, onlyConnectionId) : undefined,
      ),
    )
    .returning({ connection_id: provider_resources.connection_id });
  return [...new Set(rows.map((r) => r.connection_id))];
}

/** Returns the account's connection id, or null when the account is not in this workspace. */
export async function setAccountCycleDay(s: WorkspaceScope, accountId: string, day: number): Promise<string | null> {
  const [row] = await db
    .update(provider_accounts)
    .set({ billing_cycle_anchor_day: day })
    .where(and(eq(provider_accounts.id, accountId), eq(provider_accounts.workspace_id, s.workspaceId)))
    .returning({ connection_id: provider_accounts.connection_id });
  return row?.connection_id ?? null;
}

export const listSyncRuns = (s: WorkspaceScope, connectionId: string, limit: number) =>
  db
    .select()
    .from(sync_runs)
    .where(and(eq(sync_runs.connection_id, connectionId), eq(sync_runs.workspace_id, s.workspaceId)))
    .orderBy(desc(sync_runs.started_at))
    .limit(limit);

/** The plan of an account, or of the account a resource belongs to. Null when not in this workspace. */
export async function getScopePlan(
  s: WorkspaceScope,
  scopeType: "account" | "resource",
  scopeId: string,
): Promise<{ plan: string | null } | null> {
  if (scopeType === "account") {
    const [row] = await db
      .select({ plan: provider_accounts.plan })
      .from(provider_accounts)
      .where(and(eq(provider_accounts.id, scopeId), eq(provider_accounts.workspace_id, s.workspaceId)))
      .limit(1);
    return row ? { plan: row.plan } : null;
  }
  const [row] = await db
    .select({ plan: provider_accounts.plan })
    .from(provider_resources)
    .leftJoin(provider_accounts, and(eq(provider_resources.account_id, provider_accounts.id), eq(provider_accounts.workspace_id, provider_resources.workspace_id)))
    .where(and(eq(provider_resources.id, scopeId), eq(provider_resources.workspace_id, s.workspaceId)))
    .limit(1);
  return row ? { plan: row.plan ?? null } : null;
}
