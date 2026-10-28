import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/auth/paths";

describe("isPublicPath", () => {
  it.each(["/", "/login", "/login/x", "/signup", "/forgot-password", "/reset-password", "/auth/signout", "/api/cron/tick", "/api/integrations/supabase/oauth/start"])(
    "%s is public",
    (path) => expect(isPublicPath(path)).toBe(true),
  );

  it.each(["/loginx", "//home", "/home", "/api/authx", "/api/auth/get-session", "/api/cron-evil", "/alerts"])("%s is protected", (path) =>
    expect(isPublicPath(path)).toBe(false),
  );
});
