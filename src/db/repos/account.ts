import { eq } from "drizzle-orm";
import { db } from "../client";
import { profiles, workspaces } from "../schema";
import { pick } from "../pick";
import type { WorkspaceScope } from "../scope";
import type { Row } from "../types";

export async function getProfile(s: WorkspaceScope): Promise<Row<"profiles"> | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, s.userId)).limit(1);
  return row ?? null;
}

export async function setDisplayName(s: WorkspaceScope, name: string | null): Promise<void> {
  await db.update(profiles).set({ display_name: name }).where(eq(profiles.id, s.userId));
}

const WORKSPACE_PATCH_KEYS = ["name", "notify_in_app", "notify_email", "email_min_severity", "alert_email", "stale_after_hours"] as const;

/** The workspace columns a user may change (the same set the old column grants allowed). */
export type WorkspacePatch = Partial<Pick<Row<"workspaces">, (typeof WORKSPACE_PATCH_KEYS)[number]>>;

export async function updateWorkspace(s: WorkspaceScope, patch: WorkspacePatch): Promise<void> {
  const values = pick(patch, WORKSPACE_PATCH_KEYS);
  if (!Object.keys(values).length) return;
  await db.update(workspaces).set(values).where(eq(workspaces.id, s.workspaceId));
}
