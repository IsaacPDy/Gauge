import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ensureUserWorkspace } from "@/db/bootstrap";
import { requireWorkspace } from "@/db/scope";
import { auth } from "@/lib/auth/server";

/**
 * The signed-in user, their workspace and a WorkspaceScope for querying it.
 * MVP: one workspace per user, created on first sign-in.
 */
export const getSession = cache(async () => {
  const { data } = await auth.getSession();
  const authUser = data?.user;
  if (!authUser) redirect("/login");
  const user = { id: authUser.id, email: authUser.email };
  const workspace = await ensureUserWorkspace(user);
  const scope = await requireWorkspace(user.id, workspace.id);
  return { user, workspace, scope };
});

export type Session = Awaited<ReturnType<typeof getSession>>;
