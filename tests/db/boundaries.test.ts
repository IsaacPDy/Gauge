import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static architecture rules for the repository layer (no database needed).

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

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

/** Matches static imports, side-effect imports, dynamic import() and require() of `@/db/<names>` or a relative path ending in `db/<names>`. */
const dbImport = (names: string[]) => {
  const alt = names.join("|");
  return new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](?:@\\/db\\/(?:${alt})|(?:\\.{1,2}\\/)+(?:[\\w.-]+\\/)*db\\/(?:${alt}))(?:\\.[tj]sx?)?["']`,
  );
};

/** Matches imports of a bare package name (or a subpath of it). */
const packageImport = (names: string[]) =>
  new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](?:${names.join("|")})(?:\\/[^"']*)?["']`);

const offenders = (rule: RegExp, allowedPrefixes: string[]) =>
  files.filter((f) => !startsWithAny(f.path, allowedPrefixes) && rule.test(f.source)).map((f) => f.path);

describe("import patterns", () => {
  const client = dbImport(["client", "schema"]);

  it.each([
    'import { db } from "@/db/client";',
    'const { db } = await import("@/db/client");',
    'import "@/db/client";',
    'const { db } = require("@/db/client");',
    'import { x } from "../../db/client.ts";',
    "import { x } from '@/db/schema';",
    'export * from "../db/schema";',
  ])("matches %s", (line) => {
    expect(client.test(line)).toBe(true);
  });

  it.each([
    'import { listAlerts } from "@/db/repos/alerts";',
    'import { requireWorkspace } from "@/db/scope";',
    'import { x } from "./client";',
    'import { x } from "@/lib/db/clientele";',
  ])("does not match %s", (line) => {
    expect(client.test(line)).toBe(false);
  });

  it("matches package imports and subpaths only", () => {
    const pkg = packageImport(["@neondatabase\\/serverless", "pg"]);
    expect(pkg.test('import { Pool } from "pg";')).toBe(true);
    expect(pkg.test('await import("@neondatabase/serverless")')).toBe(true);
    expect(pkg.test('import x from "pg-format";')).toBe(false);
    expect(pkg.test('import x from "pgvector";')).toBe(false);
  });
});

describe("repository boundaries", () => {
  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path === "db/scope.ts")).toBe(true);
  });

  it("only db code, background jobs, audit and the OAuth routes import the db client or schema", () => {
    const allowed = ["db/", "lib/jobs/", "lib/audit.ts", "app/api/integrations/supabase/oauth/"];
    expect(offenders(dbImport(["client", "schema"]), allowed)).toEqual([]);
  });

  it("only db code and background jobs import claims or alert-relations", () => {
    expect(offenders(dbImport(["claims", "alert-relations"]), ["db/", "lib/jobs/"])).toEqual([]);
  });

  it("keeps claim functions out of pages and components", () => {
    const pagesAndComponents = files.filter((f) => startsWithAny(f.path, ["app/", "components/"]));
    const claims = dbImport(["claims"]);
    expect(pagesAndComponents.filter((f) => claims.test(f.source)).map((f) => f.path)).toEqual([]);
  });

  it("only db code uses the Postgres drivers directly", () => {
    expect(offenders(packageImport(["@neondatabase\\/serverless", "pg"]), ["db/"])).toEqual([]);
  });

  it("only scope.ts creates a WorkspaceScope", () => {
    const found = files.filter((f) => f.path !== "db/scope.ts" && f.source.includes("as WorkspaceScope")).map((f) => f.path);
    expect(found).toEqual([]);
  });

  it("keeps stored secrets out of repositories, scope, alert relations and claims", () => {
    const guarded = files.filter(
      (f) => f.path.startsWith("db/repos/") || ["db/scope.ts", "db/alert-relations.ts", "db/claims.ts"].includes(f.path),
    );
    expect(guarded.length).toBeGreaterThan(0);
    const found = guarded.filter((f) => /provider_credentials|oauth_states|ciphertext|code_verifier/.test(f.source)).map((f) => f.path);
    expect(found).toEqual([]);
  });
});
