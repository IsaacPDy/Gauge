/**
 * Copies only the listed keys that are own properties of `obj` and not undefined. Used to
 * whitelist what reaches SQL at runtime: TypeScript types do not stop extra properties
 * (a `workspace_id`, an `owner_id`) arriving through casts or untyped input.
 */
export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
