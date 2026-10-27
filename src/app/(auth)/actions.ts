"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createUserClient } from "@/lib/supabase/server";
import { appUrl, safeNext } from "@/lib/urls";

export type AuthState = { error?: string; ok?: string } | undefined;

const credentials = z.object({
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(8, "Use at least 8 characters").max(128),
});

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (error.status === 429) return { error: "Too many attempts. Wait a moment and try again." };
    // Same message for unknown email and wrong password: no account enumeration.
    return { error: "Incorrect email or password." };
  }
  redirect(safeNext(form.get("next")));
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: appUrl("/auth/callback?next=/home") },
  });
  if (error) {
    if (error.status === 429) return { error: "Too many sign-up attempts. Try again later." };
    return { error: error.message };
  }
  if (data.session) redirect("/home");
  return { ok: "Check your inbox to confirm your email address, then sign in." };
}

export async function requestPasswordReset(_: AuthState, form: FormData): Promise<AuthState> {
  const email = z.email().safeParse(form.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  const supabase = await createUserClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: appUrl("/auth/callback?next=/reset-password"),
  });
  if (error?.status === 429) return { error: "Too many requests. Wait a minute and try again." };
  // Always the same answer, whether or not the account exists.
  return { ok: "If an account exists for that address, a reset link is on its way." };
}

export async function updatePassword(_: AuthState, form: FormData): Promise<AuthState> {
  const password = z.string().min(8).max(128).safeParse(form.get("password"));
  if (!password.success) return { error: "Use at least 8 characters." };
  if (form.get("password") !== form.get("confirm")) return { error: "The passwords do not match." };
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: "Your reset link has expired. Request a new one." };
  const { error } = await supabase.auth.updateUser({ password: password.data });
  if (error) return { error: error.message };
  redirect("/home?ok=Password+updated");
}
