import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { hasTestDb, useTestDb } from "../helpers/test-db";

describe.skipIf(!hasTestDb)("drizzle schema matches the migrated database", () => {
  beforeAll(useTestDb);

  it("has exactly the tables and columns the migration created", async () => {
    const { db } = await import("@/db/client");
    const { tables } = await import("@/db/schema");
    const res = await db.execute(
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public' and table_name <> 'schema_migrations'`,
    );
    const actual = new Map<string, string[]>();
    for (const r of res.rows as { table_name: string; column_name: string }[]) {
      actual.set(r.table_name, [...(actual.get(r.table_name) ?? []), r.column_name]);
    }
    const declared = Object.values(tables);
    expect([...actual.keys()].sort()).toEqual(declared.map((t) => getTableName(t)).sort());
    for (const t of declared) {
      const columns = Object.values(getTableColumns(t)).map((c) => c.name).sort();
      expect((actual.get(getTableName(t)) ?? []).sort(), getTableName(t)).toEqual(columns);
    }
  });
});
