/**
 * Normalizes an optional parser value (single value, array, or missing) to an
 * array. XML node accessors produce `null` for absent nodes, so both `null`
 * and `undefined` map to the empty array; real falsy values (0, '') are
 * wrapped, not dropped.
 */
export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
