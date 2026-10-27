import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createUserClient } from "./supabase/server";

/**
 * The signed-in user, their RLS-bound Supabase client and their workspace.
 * MVP: one workspace per user, created automatically at sign-up.
 */
export const getSession = cache(async () => {
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("*")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load workspace: ${error.message}`);
  if (!workspace) throw new Error("No workspace found for this account");
  return { supabase, user, workspace };
});

export type Session = Awaited<ReturnType<typeof getSession>>;
