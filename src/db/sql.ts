import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

/**
 * The `set` clause of `ON CONFLICT DO UPDATE` that takes the incoming value of every column
 * present in `sample` (except `skip`). Pass every row being inserted: a column counts as present
 * when ANY row has a non-undefined value for it, so a field that is undefined in the first row
 * but set in a later one is still updated. Columns absent from all rows (for example the user's
 * own `is_monitored` choice) are left alone, which is how PostgREST upserts behaved. Keys whose
 * value is undefined are left alone too (Drizzle inserts DEFAULT for them).
 */
export function excludedFrom<T extends PgTable>(table: T, sample: object | object[], skip: string[] = []): PgUpdateSetSource<T> {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const rows = Array.isArray(sample) ? sample : [sample];
  const present = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) if (value !== undefined) present.add(key);
  }
  const set: Record<string, SQL> = {};
  for (const key of present) {
    if (!Object.hasOwn(columns, key) || skip.includes(key)) continue;
    set[key] = sql`excluded.${sql.identifier(columns[key].name)}`;
  }
  return set as PgUpdateSetSource<T>;
}
