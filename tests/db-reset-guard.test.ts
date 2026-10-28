import { describe, expect, it } from "vitest";
import { checkResetGuard } from "../src/db/reset-guard";

const URL_DEV = "postgresql://user:secret@ep-dev-123.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const HOST_DEV = "ep-dev-123.eu-central-1.aws.neon.tech";

describe("checkResetGuard", () => {
  it("allows a dev branch with --yes and the matching --host", () => {
    expect(checkResetGuard({ url: URL_DEV, branch: "dev", argv: ["--yes", `--host=${HOST_DEV}`] })).toEqual({ ok: true, host: HOST_DEV });
  });

  it("refuses without --yes and says what to type", () => {
    const r = checkResetGuard({ url: URL_DEV, branch: "dev", argv: [`--host=${HOST_DEV}`] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(`npm run db:reset -- --yes --host=${HOST_DEV}`);
  });

  it("refuses without --host and prints the real target host, never the URL or password", () => {
    const r = checkResetGuard({ url: URL_DEV, branch: "dev", argv: ["--yes"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(HOST_DEV);
      expect(r.message).not.toContain("secret");
      expect(r.message).not.toContain("user:");
    }
  });

  it("refuses a --host that differs from the target (inline DATABASE_URL_UNPOOLED override)", () => {
    const prod = "postgresql://u:p@ep-prod-999.eu-central-1.aws.neon.tech/neondb";
    const r = checkResetGuard({ url: prod, branch: "dev", argv: ["--yes", `--host=${HOST_DEV}`] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("ep-prod-999.eu-central-1.aws.neon.tech");
      expect(r.message).toContain("--host=ep-prod-999.eu-central-1.aws.neon.tech");
    }
  });

  it("refuses when NEON_BRANCH is not dev, even with --yes and the right host", () => {
    for (const branch of ["prod", "main", "", undefined]) {
      const r = checkResetGuard({ url: URL_DEV, branch, argv: ["--yes", `--host=${HOST_DEV}`] });
      expect(r.ok).toBe(false);
    }
  });

  it("refuses a missing or unparseable URL without echoing it", () => {
    expect(checkResetGuard({ url: undefined, branch: "dev", argv: ["--yes"] }).ok).toBe(false);
    const r = checkResetGuard({ url: "not a url with secret", branch: "dev", argv: ["--yes"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("secret");
  });

  it("does not accept a prefix of the host", () => {
    const r = checkResetGuard({ url: URL_DEV, branch: "dev", argv: ["--yes", "--host=ep-dev-123"] });
    expect(r.ok).toBe(false);
  });
});
