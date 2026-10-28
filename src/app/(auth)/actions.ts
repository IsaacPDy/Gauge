"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import { appUrl, safeNext } from "@/lib/urls";

export type AuthState = { error?: string; ok?: string } | undefined;

const credentials = z.object({
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(8, "Use at least 8 characters").max(128),
});

const EXPIRED_LINK = "Your reset link is invalid or has expired. Request a new one.";

/** Upstream failures: a 5xx, or an error that carries no HTTP status at all (network problems). */
const isServerError = (error: { status?: number }) => !error.status || error.status >= 500;

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const { error } = await auth.signIn.email(parsed.data);
  if (error) {
    if (error.status === 429) return { error: "Too many attempts. Wait a moment and try again." };
    if (isServerError(error)) return { error: "Sign-in is temporarily unavailable. Try again in a moment." };
    // Same message for unknown email and wrong password: no account enumeration.
    return { error: "Incorrect email or password." };
  }
  redirect(safeNext(form.get("next")));
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const { data, error } = await auth.signUp.email({ ...parsed.data, name: parsed.data.email.split("@")[0] || "User" });
  if (error) {
    if (error.status === 429) return { error: "Too many sign-up attempts. Try again later." };
    if (isServerError(error)) return { error: "Sign-up is temporarily unavailable. Try again in a moment." };
    // One answer for every 4xx (including "already registered"): no account enumeration, no upstream text.
    return { error: "Could not create the account. If you already have one, sign in or reset your password." };
  }
  // With email verification on, the account exists but no session token is issued yet.
  if (!data?.token) return { ok: "Check your inbox to confirm your email address, then sign in." };
  // Signed in. The workspace is created on first load.
  redirect("/home");
}

export async function requestPasswordReset(_: AuthState, form: FormData): Promise<AuthState> {
  const email = z.email().safeParse(form.get("email"));
  if (!email.success) return { error: "Enter a valid email address." };
  const { error } = await auth.requestPasswordReset({ email: email.data, redirectTo: appUrl("/reset-password") });
  if (error?.status === 429) return { error: "Too many requests. Wait a minute and try again." };
  if (error) console.error("[auth] password reset request failed:", error.status, error.code);
  // Always the same answer, whether or not the account exists.
  return { ok: "If an account exists for that address, a reset link is on its way." };
}

export async function updatePassword(_: AuthState, form: FormData): Promise<AuthState> {
  const token = z.string().min(1).safeParse(form.get("token"));
  if (!token.success) return { error: EXPIRED_LINK };
  const password = z.string().min(8).max(128).safeParse(form.get("password"));
  if (!password.success) return { error: "Use at least 8 characters." };
  if (form.get("password") !== form.get("confirm")) return { error: "The passwords do not match." };
  const { error } = await auth.resetPassword({ newPassword: password.data, token: token.data });
  if (error) {
    if (error.status === 429) return { error: "Too many attempts. Wait a minute and try again." };
    if (isServerError(error)) return { error: "Password reset is temporarily unavailable. Try again in a moment." };
    return { error: EXPIRED_LINK };
  }
  redirect("/login?reset=1");
}
