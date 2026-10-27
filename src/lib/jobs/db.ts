/**
 * PostgREST caps responses (1000 rows by default). Page through a query built by `build`
 * until a short page comes back.
 */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type AnyResult = { data: unknown; error: { message: string } | null };

/** Unwrap a Supabase response, turning an error into an exception with context. */
export function must<R extends AnyResult>(res: R, what: string): Extract<R, { error: null }>["data"] {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as Extract<R, { error: null }>["data"];
}
