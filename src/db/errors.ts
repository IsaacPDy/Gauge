/** SQLSTATE of a Postgres error, whether or not Drizzle wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === "23505";
