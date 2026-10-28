import { customType } from "drizzle-orm/pg-core";

/**
 * timestamptz as an ISO-8601 string. PostgREST returned ISO strings and the whole app
 * (engine, views, pages) parses them with `new Date(...)`/`Date.parse`, so we keep that shape.
 * Warning: keeps millisecond precision (Postgres has microseconds), so do not use a round-tripped
 * value in equality or watermark comparisons.
 */
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamptz",
  fromDriver: (value) => new Date(value).toISOString(),
  toDriver: (value) => value,
});

/** numeric as a JS number. node-postgres returns numeric as text; PostgREST returned numbers.
 * Warning: a JS double (about 15 significant digits), fine for usage and cost values. */
export const num = customType<{ data: number; driverData: string | number }>({
  dataType: () => "numeric",
  fromDriver: (value) => Number(value),
  toDriver: (value) => String(value),
});
