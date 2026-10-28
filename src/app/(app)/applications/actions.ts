"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { isUniqueViolation, dbErrorMessage } from "@/db/errors";
import * as applicationsRepo from "@/db/repos/applications";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { getSession } from "@/lib/session";
import { withParams } from "@/lib/urls";

const uuid = z.uuid();
const appForm = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
});

export async function createApplication(form: FormData) {
  const { scope } = await getSession();
  const parsed = appForm.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) redirect(withParams("/applications", { error: parsed.error.issues[0]?.message }));
  let id: string | null = null;
  let failure: string | null = null;
  try {
    id = await applicationsRepo.createApplication(scope, { name: parsed.data.name, description: parsed.data.description ?? null });
  } catch (e) {
    failure = isUniqueViolation(e) ? "An application with that name already exists." : dbErrorMessage(e);
  }
  if (failure || !id) redirect(withParams("/applications", { error: failure ?? "Could not create the application." }));
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${id}`, { ok: "Application created. Add the resources it uses." }));
}

export async function updateApplication(form: FormData) {
  const { scope } = await getSession();
  const id = uuid.parse(form.get("id"));
  const parsed = appForm.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) redirect(withParams(`/applications/${id}`, { error: parsed.error.issues[0]?.message }));
  let failure: string | null = null;
  try {
    await applicationsRepo.updateApplication(scope, id, { name: parsed.data.name, description: parsed.data.description ?? null });
  } catch (e) {
    failure = isUniqueViolation(e) ? "That name is already used." : dbErrorMessage(e);
  }
  if (failure) redirect(withParams(`/applications/${id}`, { error: failure }));
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${id}`, { ok: "Saved." }));
}

export async function deleteApplication(form: FormData) {
  const { scope, workspace } = await getSession();
  const id = uuid.parse(form.get("id"));
  await applicationsRepo.deleteApplication(scope, id);
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams("/applications", { ok: "Application deleted. Its resources are unassigned, not removed." }));
}

export async function addResources(form: FormData) {
  const { scope, workspace } = await getSession();
  const applicationId = uuid.parse(form.get("applicationId"));
  const ids = z.array(uuid).parse(form.getAll("resourceId"));
  if (ids.length) {
    // Reassigning moves the resource: a resource belongs to at most one application.
    let failure: string | null = null;
    try {
      await applicationsRepo.assignResources(scope, applicationId, ids);
    } catch (e) {
      failure = dbErrorMessage(e);
    }
    if (failure) redirect(withParams(`/applications/${applicationId}`, { error: failure }));
    await recalculateWorkspace(workspace.id);
  }
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${applicationId}`, { ok: `Added ${ids.length} resource${ids.length === 1 ? "" : "s"}.` }));
}

export async function removeResource(form: FormData) {
  const { scope, workspace } = await getSession();
  const applicationId = uuid.parse(form.get("applicationId"));
  const resourceId = uuid.parse(form.get("resourceId"));
  await applicationsRepo.removeResourceFromApplication(scope, applicationId, resourceId);
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(`/applications/${applicationId}`, { ok: "Resource removed from this application." }));
}
