import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    auth: {
      signIn: { email: vi.fn() },
      signUp: { email: vi.fn() },
      requestPasswordReset: vi.fn(),
      resetPassword: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth/server", () => ({ auth: h.auth }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));

import { requestPasswordReset, signIn, signUp, updatePassword } from "@/app/(auth)/actions";

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

/** The URL an action redirected to, or null when it returned normally. */
async function redirectedTo(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
  } catch (e) {
    if (e instanceof h.RedirectSignal) return e.url;
    throw e;
  }
  return null;
}

const ok = { data: {}, error: null };
const fail = (status: number | undefined, extra: Record<string, unknown> = {}) => ({
  data: null,
  error: { status, message: "upstream detail that must not be shown", code: "UPSTREAM_CODE", ...extra },
});
const creds = { email: "ada@example.com", password: "correct horse" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("signIn", () => {
  it("rejects an invalid form without calling Neon Auth", async () => {
    expect(await signIn(undefined, form({ email: "nope", password: "x" }))).toEqual({ error: "Enter your email and password." });
    expect(h.auth.signIn.email).not.toHaveBeenCalled();
  });

  it("gives one generic message for a 401 (no account enumeration)", async () => {
    h.auth.signIn.email.mockResolvedValue(fail(401));
    expect(await signIn(undefined, form(creds))).toEqual({ error: "Incorrect email or password." });
  });

  it("reports rate limiting and outages", async () => {
    h.auth.signIn.email.mockResolvedValue(fail(429));
    expect((await signIn(undefined, form(creds)))?.error).toMatch(/Too many attempts/);
    h.auth.signIn.email.mockResolvedValue(fail(500));
    expect((await signIn(undefined, form(creds)))?.error).toMatch(/temporarily unavailable/);
    h.auth.signIn.email.mockResolvedValue(fail(undefined)); // network failure carries no status
    expect((await signIn(undefined, form(creds)))?.error).toMatch(/temporarily unavailable/);
  });

  it("redirects to the requested same-site page on success and blocks open redirects", async () => {
    h.auth.signIn.email.mockResolvedValue(ok);
    expect(await redirectedTo(signIn(undefined, form({ ...creds, next: "/usage?tab=quotas" })))).toBe("/usage?tab=quotas");
    expect(await redirectedTo(signIn(undefined, form({ ...creds, next: "//evil.example" })))).toBe("/home");
    expect(await redirectedTo(signIn(undefined, form({ ...creds, next: "https://evil.example" })))).toBe("/home");
    expect(await redirectedTo(signIn(undefined, form(creds)))).toBe("/home");
  });
});

describe("signUp", () => {
  it("shows the check-your-inbox state, without redirecting, when no session token is issued", async () => {
    h.auth.signUp.email.mockResolvedValue({ data: { token: null }, error: null });
    const state = await signUp(undefined, form(creds));
    expect(state?.ok).toMatch(/Check your inbox/);
    expect(state?.error).toBeUndefined();
  });

  it("answers every 4xx (such as an existing account) with one message that omits the upstream text", async () => {
    h.auth.signUp.email.mockResolvedValue(fail(422, { message: "User already exists" }));
    const state = await signUp(undefined, form(creds));
    expect(state?.error).toMatch(/Could not create the account/);
    expect(state?.error).not.toMatch(/already exists/i);
    expect(state?.error).not.toContain("upstream");
  });

  it("reports rate limiting and outages", async () => {
    h.auth.signUp.email.mockResolvedValue(fail(429));
    expect((await signUp(undefined, form(creds)))?.error).toMatch(/Too many sign-up attempts/);
    h.auth.signUp.email.mockResolvedValue(fail(503));
    expect((await signUp(undefined, form(creds)))?.error).toMatch(/temporarily unavailable/);
  });

  it("validates the form first", async () => {
    expect((await signUp(undefined, form({ email: "ada@example.com", password: "short" })))?.error).toBe("Use at least 8 characters");
    expect(h.auth.signUp.email).not.toHaveBeenCalled();
  });

  it("redirects to /home when the new account is signed in", async () => {
    h.auth.signUp.email.mockResolvedValue({ data: { token: "t" }, error: null });
    expect(await redirectedTo(signUp(undefined, form(creds)))).toBe("/home");
  });
});

describe("requestPasswordReset", () => {
  const same = { ok: "If an account exists for that address, a reset link is on its way." };

  it("rejects an invalid email", async () => {
    expect((await requestPasswordReset(undefined, form({ email: "nope" })))?.error).toBe("Enter a valid email address.");
    expect(h.auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("gives the same answer whether the call succeeds or fails", async () => {
    h.auth.requestPasswordReset.mockResolvedValue(ok);
    expect(await requestPasswordReset(undefined, form({ email: "ada@example.com" }))).toEqual(same);
    h.auth.requestPasswordReset.mockResolvedValue(fail(404));
    expect(await requestPasswordReset(undefined, form({ email: "ada@example.com" }))).toEqual(same);
  });

  it("logs a non-429 failure without the email address", async () => {
    h.auth.requestPasswordReset.mockResolvedValue(fail(500));
    await requestPasswordReset(undefined, form({ email: "ada@example.com" }));
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("password reset request failed");
    expect(logged).not.toContain("ada@example.com");
  });

  it("is the one case that reveals itself: rate limiting", async () => {
    h.auth.requestPasswordReset.mockResolvedValue(fail(429));
    expect((await requestPasswordReset(undefined, form({ email: "ada@example.com" })))?.error).toMatch(/Too many requests/);
  });
});

describe("updatePassword", () => {
  const good = { token: "tok", password: "new password 1", confirm: "new password 1" };

  it("needs a token, a long enough password and a matching confirmation", async () => {
    expect((await updatePassword(undefined, form({ ...good, token: "" })))?.error).toMatch(/invalid or has expired/);
    expect((await updatePassword(undefined, form({ ...good, password: "short", confirm: "short" })))?.error).toBe("Use at least 8 characters.");
    expect((await updatePassword(undefined, form({ ...good, confirm: "different one" })))?.error).toBe("The passwords do not match.");
    expect(h.auth.resetPassword).not.toHaveBeenCalled();
  });

  it("maps rate limiting, outages and a bad token", async () => {
    h.auth.resetPassword.mockResolvedValue(fail(429));
    expect((await updatePassword(undefined, form(good)))?.error).toMatch(/Too many attempts/);
    h.auth.resetPassword.mockResolvedValue(fail(502));
    expect((await updatePassword(undefined, form(good)))?.error).toMatch(/temporarily unavailable/);
    h.auth.resetPassword.mockResolvedValue(fail(400));
    expect((await updatePassword(undefined, form(good)))?.error).toMatch(/invalid or has expired/);
  });

  it("redirects to /login?reset=1 on success", async () => {
    h.auth.resetPassword.mockResolvedValue(ok);
    expect(await redirectedTo(updatePassword(undefined, form(good)))).toBe("/login?reset=1");
    expect(h.auth.resetPassword).toHaveBeenCalledWith({ newPassword: "new password 1", token: "tok" });
  });
});
