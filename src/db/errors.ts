/** SQLSTATE of a Postgres error, whether or not Drizzle wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === "23505";

const isDrizzleQueryError = (e: unknown): e is Error =>
  e instanceof Error && (e.name === "DrizzleQueryError" || e.message.startsWith("Failed query:"));

/**
 * A message that is safe to store, show or log. Drizzle's DrizzleQueryError embeds the SQL and
 * its bound parameters ("Failed query: ... params: ..."), which can include ciphertext and
 * sample values, so for those only the underlying driver error (and its SQLSTATE) is kept.
 * Any other Error is returned unchanged.
 *
 * Note: Postgres messages can still echo an offending input value (for example
 * `invalid input syntax for type uuid: "<text>"`), but never the bound ciphertext columns'
 * values from other statements. Do not feed this text back to untrusted users verbatim.
 */
export function dbErrorMessage(error: unknown): string {
  if (!isDrizzleQueryError(error)) return error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    // AggregateError (for example a failed multi-address connect) has an empty message.
    const text = cause.message || cause.name;
    const code = pgErrorCode(error);
    return code ? `${code}: ${text}` : text;
  }
  return "Database error";
}

const FRIENDLY_BY_SQLSTATE: Record<string, string> = {
  "23505": "That already exists.",
  "23503": "That item no longer exists or belongs to another workspace.",
  "23514": "One of the values is not allowed.",
  "22P02": "One of the values is not allowed.",
  "22007": "One of the values is not allowed.",
  "22023": "One of the values is not allowed.",
  "22001": "One of the values is too long.",
};

/**
 * Text that is safe to show a user for a failed database call: chosen from the SQLSTATE only,
 * never from the driver message (which can name tables, constraints or values). Log the real
 * cause separately with dbErrorMessage().
 */
export function friendlyDbError(error: unknown, fallback = "Something went wrong. Try again in a moment."): string {
  const code = pgErrorCode(error);
  return (code && FRIENDLY_BY_SQLSTATE[code]) || fallback;
}
