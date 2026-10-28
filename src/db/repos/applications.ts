import { and, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { application_resources, applications } from "../schema";
import type { WorkspaceScope } from "../scope";

/** Throws a unique-violation (see isUniqueViolation) when the name is already used. */
export async function createApplication(s: WorkspaceScope, v: { name: string; description: string | null }): Promise<string> {
  const [row] = await db
    .insert(applications)
    .values({ workspace_id: s.workspaceId, name: v.name, description: v.description })
    .returning({ id: applications.id });
  return row.id;
}

export async function updateApplication(s: WorkspaceScope, id: string, v: { name: string; description: string | null }): Promise<void> {
  await db
    .update(applications)
    .set(v)
    .where(and(eq(applications.id, id), eq(applications.workspace_id, s.workspaceId)));
}

export async function deleteApplication(s: WorkspaceScope, id: string): Promise<void> {
  await db.delete(applications).where(and(eq(applications.id, id), eq(applications.workspace_id, s.workspaceId)));
}

/**
 * Moves resources into an application (a resource belongs to at most one). Composite foreign
 * keys make this throw, and roll back, if the application or any resource is in another workspace.
 */
export async function assignResources(s: WorkspaceScope, applicationId: string, resourceIds: string[]): Promise<void> {
  if (!resourceIds.length) return;
  await db.transaction(async (tx) => {
    await tx
      .delete(application_resources)
      .where(and(inArray(application_resources.resource_id, resourceIds), eq(application_resources.workspace_id, s.workspaceId)));
    await tx
      .insert(application_resources)
      .values(resourceIds.map((resource_id) => ({ application_id: applicationId, resource_id, workspace_id: s.workspaceId })));
  });
}

export async function unassignResource(s: WorkspaceScope, resourceId: string): Promise<void> {
  await db
    .delete(application_resources)
    .where(and(eq(application_resources.resource_id, resourceId), eq(application_resources.workspace_id, s.workspaceId)));
}

export async function removeResourceFromApplication(s: WorkspaceScope, applicationId: string, resourceId: string): Promise<void> {
  await db
    .delete(application_resources)
    .where(
      and(
        eq(application_resources.application_id, applicationId),
        eq(application_resources.resource_id, resourceId),
        eq(application_resources.workspace_id, s.workspaceId),
      ),
    );
}
