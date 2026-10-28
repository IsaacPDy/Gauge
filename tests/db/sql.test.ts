import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { excludedFrom } from "../../src/db/sql";

const t = pgTable("t", {
  id: text("id").primaryKey(),
  a: text("a"),
  b: text("b_col"),
  c: integer("c"),
});

describe("excludedFrom", () => {
  it("single object: takes present columns, ignores unknown keys, skip keys and undefined values", () => {
    const set = excludedFrom(t, { id: "1", a: "x", c: undefined, nope: 1 }, ["id"]);
    expect(Object.keys(set)).toEqual(["a"]);
  });

  it("uses the union of keys across rows (undefined in the first row, set in a later one)", () => {
    const set = excludedFrom(t, [{ id: "1", a: "x", b: undefined }, { id: "2", a: "y", b: "z" }], ["id"]);
    expect(Object.keys(set).sort()).toEqual(["a", "b"]);
  });

  it("still excludes skip keys and ignores unknown keys for arrays", () => {
    const set = excludedFrom(t, [{ id: "1", a: "x" }, { id: "2", extra: 1, c: 3 }], ["id", "c"]);
    expect(Object.keys(set)).toEqual(["a"]);
  });

  it("leaves a column alone when no row has a value for it", () => {
    const set = excludedFrom(t, [{ id: "1", a: "x", b: undefined }, { id: "2", a: "y" }], ["id"]);
    expect(Object.keys(set)).toEqual(["a"]);
  });

  it("renders excluded.<column name> using the database column name", () => {
    const set = excludedFrom(t, [{ id: "1", b: "z" }], ["id"]) as Record<string, SQL>;
    const { sql: text } = new PgDialect().sqlToQuery(set.b);
    expect(text).toContain('excluded."b_col"');
  });
});
