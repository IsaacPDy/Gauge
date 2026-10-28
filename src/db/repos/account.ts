import { eq } from "drizzle-orm";
import { db } from "../client";
import { profiles, workspaces } from "../schema";
import type { WorkspaceScope } from "../scope";
import type { Row } from "../types";

export async function getProfile(s: WorkspaceScope): Promise<Row<"profiles"> | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, s.userId)).limit(1);
  return row ?? null;
}

export async function setDisplayName(s: WorkspaceScope, name: string | null): Promise<void> {
  await db.update(profiles).set({ display_name: name }).where(eq(profiles.id, s.userId));
}

/** The workspace columns a user may change (the same set the old column grants allowed). */
export type WorkspacePatch = Partial<
  Pick<Row<"workspaces">, "name" | "notify_in_app" | "notify_email" | "email_min_severity" | "alert_email" | "stale_after_hours">
>;

export async function updateWorkspace(s: WorkspaceScope, patch: WorkspacePatch): Promise<void> {
  await db.update(workspaces).set(patch).where(eq(workspaces.id, s.workspaceId));
}
