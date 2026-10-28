import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

/**
 * The `set` clause of `ON CONFLICT DO UPDATE` that takes the incoming value of every column
 * present in `sample` (except `skip`). Columns absent from `sample` (for example the user's
 * own `is_monitored` choice) are left alone, which is how PostgREST upserts behaved.
 */
export function excludedFrom<T extends PgTable>(table: T, sample: object, skip: string[] = []): PgUpdateSetSource<T> {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sample)) {
    if (!(key in columns) || skip.includes(key)) continue;
    set[key] = sql.raw(`excluded."${columns[key].name}"`);
  }
  return set as PgUpdateSetSource<T>;
}
