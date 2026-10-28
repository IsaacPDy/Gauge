/** The part of a Neon Auth error that the password-change message depends on. */
export type AuthErrorLike = { code?: string | null; message?: string | null; status?: number | null };

// A wrong current password is "invalid_credentials" (401) in the Supabase-style adapter and
// "INVALID_PASSWORD" (400) from the Better Auth endpoint that `auth.changePassword` calls.
const WRONG_PASSWORD = new Set(["INVALID_CREDENTIALS", "INVALID_PASSWORD", "INVALID_EMAIL_OR_PASSWORD"]);
const RATE_LIMITED = new Set(["OVER_REQUEST_RATE_LIMIT", "TOO_MANY_REQUESTS"]);
const SERVER_FAILURE = new Set(["INTERNAL_ERROR", "UNEXPECTED_FAILURE"]);
const REJECTED_PASSWORD = new Set(["WEAK_PASSWORD", "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "VALIDATION_FAILED"]);

const REJECTED = "The new password was rejected. Choose a longer or less common password.";

/** Plain sentence text only: no SQL, JSON, stack traces or other machine output. */
function isHumanMessage(message: string | null | undefined): message is string {
  return !!message && /^[A-Za-z][A-Za-z0-9 ,.'()-]{2,119}$/.test(message);
}

/** Maps a failed `auth.changePassword` call to text that is safe to show the user. */
export function passwordChangeMessage(error: AuthErrorLike): string {
  const code = (error.code ?? "").toUpperCase();
  const status = error.status ?? 0;
  if (WRONG_PASSWORD.has(code)) return "Your current password is incorrect.";
  if (status === 429 || RATE_LIMITED.has(code)) return "Too many attempts. Wait a minute and try again.";
  if (status >= 500 || SERVER_FAILURE.has(code)) return "Password change is temporarily unavailable. Try again in a moment.";
  if (REJECTED_PASSWORD.has(code) || status === 400 || status === 422) {
    return isHumanMessage(error.message) ? (error.message.endsWith(".") ? error.message : `${error.message}.`) : REJECTED;
  }
  return "Could not change the password.";
}

/** Maps a failed `auth.deleteUser` call to text that is safe to show the user (never the upstream message). */
export function deleteAccountMessage(error: AuthErrorLike): string {
  if (/session[_ ]expired/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) {
    return "For security, sign in again and then retry deleting your account.";
  }
  return "Could not delete the account. Try again in a moment.";
}
