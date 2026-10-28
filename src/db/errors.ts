/** SQLSTATE of a Postgres error, whether or not Drizzle wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === "23505";

/**
 * A message that is safe to store, show or log. Drizzle's DrizzleQueryError embeds the SQL and
 * its bound parameters ("Failed query: ... params: ..."), which can include ciphertext and
 * sample values, so for those only the underlying driver error (and its SQLSTATE) is kept.
 */
export function dbErrorMessage(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    const code = pgErrorCode(error);
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Failed query:") ? "Database error" : message;
}
