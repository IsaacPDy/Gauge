// Pure ordering helpers for inventory lists. The database collation is C.UTF-8, so SQL
// `order by name` is bytewise (uppercase before lowercase, accents last). Names are
// therefore ordered here, in code, the way people expect to read them.

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A copy sorted by name (case/accent-insensitive, natural numbers), then id. */
export function sortByName<T extends { name: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => compareText(a.name, b.name) || compareId(a.id, b.id));
}

/** A copy sorted by created_at (ISO strings), then id. */
export function sortByCreated<T extends { created_at: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => compareId(a.created_at, b.created_at) || compareId(a.id, b.id));
}
