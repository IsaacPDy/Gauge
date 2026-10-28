import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { hasTestDb, useTestDb } from "../helpers/test-db";

describe.skipIf(!hasTestDb)("drizzle schema matches the migrated database", () => {
  beforeAll(useTestDb);

  it("has exactly the tables and columns the migration created, with the same nullability", async () => {
    const { db } = await import("@/db/client");
    const { tables } = await import("@/db/schema");
    const res = await db.execute(
      sql`select table_name, column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name <> 'schema_migrations'`,
    );
    // table -> (column -> notNull)
    const actual = new Map<string, Map<string, boolean>>();
    for (const r of res.rows as { table_name: string; column_name: string; is_nullable: string }[]) {
      const cols = actual.get(r.table_name) ?? new Map<string, boolean>();
      cols.set(r.column_name, r.is_nullable === "NO");
      actual.set(r.table_name, cols);
    }
    const declared = Object.values(tables);
    expect([...actual.keys()].sort()).toEqual(declared.map((t) => getTableName(t)).sort());
    for (const t of declared) {
      const name = getTableName(t);
      const drizzleCols = Object.values(getTableColumns(t));
      const dbCols = actual.get(name) ?? new Map<string, boolean>();
      expect([...dbCols.keys()].sort(), name).toEqual(drizzleCols.map((c) => c.name).sort());
      for (const c of drizzleCols) {
        expect(dbCols.get(c.name), `${name}.${c.name} notNull`).toBe(c.notNull);
      }
    }
  });
});
