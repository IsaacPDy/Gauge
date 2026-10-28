import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    calls: [] as string[],
    deleteUser: vi.fn(),
    deleteCredentials: vi.fn(),
    deleteUserData: vi.fn(),
    audit: vi.fn(),
    clearAuthCookies: vi.fn(),
    listConnections: vi.fn(),
    revokeTokens: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    h.calls.push("redirect");
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({
  getSession: async () => ({ user: { id: "u1", email: "ada@example.com" }, workspace: { id: "w1" }, scope: { workspaceId: "w1", userId: "u1" } }),
}));
vi.mock("@/lib/auth/server", () => ({ auth: { deleteUser: h.deleteUser, changePassword: vi.fn() } }));
vi.mock("@/lib/auth/cookies", () => ({ clearAuthCookies: h.clearAuthCookies }));
vi.mock("@/db/bootstrap", () => ({ deleteUserData: h.deleteUserData }));
vi.mock("@/db/repos/inventory", () => ({ listConnections: h.listConnections }));
vi.mock("@/db/repos/account", () => ({}));
vi.mock("@/lib/jobs/credentials", () => ({ deleteCredentials: h.deleteCredentials }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/providers/supabase/oauth", () => ({ oauthConfigured: () => true, revokeTokens: h.revokeTokens }));

import { deleteAccount } from "@/app/(app)/settings/actions";

const form = (confirm: string) => {
  const f = new FormData();
  f.set("confirm", confirm);
  return f;
};

async function run(confirm = "ada@example.com"): Promise<string> {
  try {
    await deleteAccount(form(confirm));
  } catch (e) {
    if (e instanceof h.RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("deleteAccount did not redirect");
}

/** The `error` query parameter of a redirect URL, decoded. */
const errorText = (url: string) => new URL(url, "http://x.invalid").searchParams.get("error") ?? "";

const track = (name: string, result?: unknown) => async () => {
  h.calls.push(name);
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.calls.length = 0;
  h.listConnections.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
  h.deleteUser.mockImplementation(track("deleteUser", { data: { success: true }, error: null }));
  h.deleteCredentials.mockImplementation(async (id: string) => {
    h.calls.push(`deleteCredentials:${id}`);
    return id === "c1" ? { kind: "oauth", refreshToken: "r" } : null;
  });
  h.revokeTokens.mockImplementation(track("revokeTokens"));
  h.audit.mockImplementation(track("audit"));
  h.clearAuthCookies.mockImplementation(track("clearAuthCookies"));
  h.deleteUserData.mockImplementation(track("deleteUserData"));
});

describe("deleteAccount", () => {
  it("asks for the exact email before doing anything", async () => {
    expect(errorText(await run("someone@else.com"))).toContain("Type your email address exactly");
    expect(h.deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    ["a refused login deletion", { data: null, error: { status: 500, code: "X", message: "internal detail" } }],
    ["a session that is too old", { data: null, error: { status: 400, code: "SESSION_EXPIRED", message: "Session expired. Re-authenticate to perform this action." } }],
    ["a result that reports no success", { data: { success: false }, error: null }],
  ])("touches no data when Neon refuses (%s)", async (_name, result) => {
    h.deleteUser.mockImplementation(track("deleteUser", result));
    const url = await run();
    expect(url.startsWith("/settings?error=")).toBe(true);
    expect(h.deleteCredentials).not.toHaveBeenCalled();
    expect(h.revokeTokens).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.clearAuthCookies).not.toHaveBeenCalled();
    expect(h.deleteUserData).not.toHaveBeenCalled();
    expect(errorText(url)).not.toContain("internal detail");
  });

  it("shows the sign-in-again message for SESSION_EXPIRED and a retry message otherwise", async () => {
    h.deleteUser.mockImplementation(track("deleteUser", { data: null, error: { status: 400, code: "SESSION_EXPIRED", message: "x" } }));
    expect(errorText(await run())).toContain("sign in again and then retry");
    h.deleteUser.mockImplementation(track("deleteUser", { data: null, error: { status: 500, code: "X", message: "x" } }));
    expect(errorText(await run())).toContain("Could not delete the account. Try again in a moment.");
  });

  it("deletes the login first, then cleans up in order, then redirects", async () => {
    expect(await run()).toBe("/login?deleted=1");
    expect(h.calls).toEqual([
      "deleteUser",
      "deleteCredentials:c1",
      "revokeTokens",
      "deleteCredentials:c2",
      "audit",
      "clearAuthCookies",
      "deleteUserData",
      "redirect",
    ]);
    expect(h.deleteUserData).toHaveBeenCalledWith("u1");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "account.deleted", details: { connectionsRevoked: 2 } }));
  });

  it("still redirects when the data cleanup throws, and logs without the SQL", async () => {
    h.deleteUserData.mockRejectedValue(new Error("Failed query: delete from workspaces params: secret"));
    expect(await run()).toBe("/login?deleted=1");
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("data cleanup failed after login deletion");
    expect(logged).not.toContain("secret");
  });

  it("keeps going when one connection's credentials cannot be removed", async () => {
    h.deleteCredentials.mockImplementation(async (id: string) => {
      h.calls.push(`deleteCredentials:${id}`);
      if (id === "c1") throw new Error("db down");
      return null;
    });
    expect(await run()).toBe("/login?deleted=1");
    expect(h.calls).toContain("deleteCredentials:c2");
    expect(h.deleteUserData).toHaveBeenCalled();
  });
});
