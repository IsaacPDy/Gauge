import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Static architecture rules for the repository layer (no database needed).

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
  });
}

const files = walk(SRC).map((full) => ({
  path: relative(SRC, full).split(sep).join("/"),
  source: readFileSync(full, "utf8"),
}));

const startsWithAny = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p));

describe("repository boundaries", () => {
  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path === "db/scope.ts")).toBe(true);
  });

  it("only db code, background jobs, audit and the OAuth routes import the db client or schema", () => {
    const allowed = ["db/", "lib/jobs/", "lib/audit.ts", "app/api/integrations/supabase/oauth/"];
    const importsDb = /from\s+["'](?:@\/db\/(?:client|schema)|(?:\.{1,2}\/)+(?:[\w.-]+\/)*db\/(?:client|schema))["']/;
    const offenders = files.filter((f) => !startsWithAny(f.path, allowed) && importsDb.test(f.source)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("only scope.ts creates a WorkspaceScope", () => {
    const offenders = files.filter((f) => f.path !== "db/scope.ts" && f.source.includes("as WorkspaceScope")).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("keeps stored secrets out of repositories, scope, alert relations and claims", () => {
    const guarded = files.filter(
      (f) => f.path.startsWith("db/repos/") || ["db/scope.ts", "db/alert-relations.ts", "db/claims.ts"].includes(f.path),
    );
    expect(guarded.length).toBeGreaterThan(0);
    const offenders = guarded.filter((f) => /provider_credentials|oauth_states|ciphertext|code_verifier/.test(f.source)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("keeps claim functions out of pages and components", () => {
    const claimsImport = /@\/db\/claims|(?:\.{1,2}\/)+(?:[\w.-]+\/)*db\/claims/;
    const offenders = files
      .filter((f) => startsWithAny(f.path, ["app/", "components/"]) && claimsImport.test(f.source))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
