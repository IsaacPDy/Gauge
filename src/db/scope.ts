import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { workspace_members } from "./schema";

declare const brand: unique symbol;

/**
 * Proof that a user belongs to a workspace. The only way to obtain one is `requireWorkspace()`,
 * and every repository function takes one, so user-facing code cannot query a workspace table
 * without a workspace filter. This replaces row-level security.
 */
export type WorkspaceScope = Readonly<{ workspaceId: string; userId: string }> & { readonly [brand]: true };

export class WorkspaceAccessError extends Error {
  constructor() {
    super("You do not have access to this workspace");
    this.name = "WorkspaceAccessError";
  }
}

export async function requireWorkspace(userId: string, workspaceId: string): Promise<WorkspaceScope> {
  const [member] = await db
    .select({ workspace_id: workspace_members.workspace_id })
    .from(workspace_members)
    .where(and(eq(workspace_members.workspace_id, workspaceId), eq(workspace_members.user_id, userId)))
    .limit(1);
  if (!member) throw new WorkspaceAccessError();
  return { workspaceId, userId } as WorkspaceScope;
}
