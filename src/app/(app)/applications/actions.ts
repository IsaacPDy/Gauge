"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { getSession } from "@/lib/session";
import { withParams } from "@/lib/urls";

const uuid = z.uuid();
const appForm = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
});

export async function createApplication(form: FormData) {
  const { supabase, workspace } = await getSession();
  const parsed = appForm.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) redirect(withParams("/applications", { error: parsed.error.issues[0]?.message }));
  const { data, error } = await supabase
    .from("applications")
    .insert({ workspace_id: workspace.id, name: parsed.data.name, description: parsed.data.description ?? null })
    .select("id")
    .single();
  if (error) {
    redirect(withParams("/applications", { error: error.code === "23505" ? "An application with that name already exists." : error.message }));
  }
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${data.id}`, { ok: "Application created. Add the resources it uses." }));
}

export async function updateApplication(form: FormData) {
  const { supabase } = await getSession();
  const id = uuid.parse(form.get("id"));
  const parsed = appForm.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) redirect(withParams(`/applications/${id}`, { error: parsed.error.issues[0]?.message }));
  const { error } = await supabase
    .from("applications")
    .update({ name: parsed.data.name, description: parsed.data.description ?? null })
    .eq("id", id);
  if (error) redirect(withParams(`/applications/${id}`, { error: error.code === "23505" ? "That name is already used." : error.message }));
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${id}`, { ok: "Saved." }));
}

export async function deleteApplication(form: FormData) {
  const { supabase, workspace } = await getSession();
  const id = uuid.parse(form.get("id"));
  await supabase.from("applications").delete().eq("id", id);
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams("/applications", { ok: "Application deleted. Its resources are unassigned, not removed." }));
}

export async function addResources(form: FormData) {
  const { supabase, workspace } = await getSession();
  const applicationId = uuid.parse(form.get("applicationId"));
  const ids = z.array(uuid).parse(form.getAll("resourceId"));
  if (ids.length) {
    // Reassigning moves the resource: a resource belongs to at most one application.
    await supabase.from("application_resources").delete().in("resource_id", ids);
    const { error } = await supabase
      .from("application_resources")
      .insert(ids.map((resource_id) => ({ application_id: applicationId, resource_id, workspace_id: workspace.id })));
    if (error) redirect(withParams(`/applications/${applicationId}`, { error: error.message }));
    await recalculateWorkspace(workspace.id);
  }
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${applicationId}`, { ok: `Added ${ids.length} resource${ids.length === 1 ? "" : "s"}.` }));
}

export async function removeResource(form: FormData) {
  const { supabase, workspace } = await getSession();
  const applicationId = uuid.parse(form.get("applicationId"));
  const resourceId = uuid.parse(form.get("resourceId"));
  await supabase.from("application_resources").delete().eq("application_id", applicationId).eq("resource_id", resourceId);
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${applicationId}`, { ok: "Resource removed from this application." }));
}
