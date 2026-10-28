import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

/**
 * The `set` clause of `ON CONFLICT DO UPDATE` that takes the incoming value of every column
 * present in `sample` (except `skip`). Columns absent from `sample` (for example the user's
 * own `is_monitored` choice) are left alone, which is how PostgREST upserts behaved. Keys whose
 * value is undefined are left alone too (Drizzle inserts DEFAULT for them).
 */
export function excludedFrom<T extends PgTable>(table: T, sample: object, skip: string[] = []): PgUpdateSetSource<T> {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sample)) {
    if (!Object.hasOwn(columns, key) || skip.includes(key) || (sample as Record<string, unknown>)[key] === undefined) continue;
    set[key] = sql`excluded.${sql.identifier(columns[key].name)}`;
  }
  return set as PgUpdateSetSource<T>;
}
