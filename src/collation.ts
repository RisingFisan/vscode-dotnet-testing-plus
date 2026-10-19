/**
 * Shared collators. `String.prototype.localeCompare` builds/looks up an ICU
 * collator on every call, which dominates sort time for tens of thousands of
 * labels; one `Intl.Collator` instance per option set yields the identical
 * ordering far faster.
 */
const COLLATOR = new Intl.Collator();

export function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

// The options solutionManager previously passed to localeCompare for the
// solution QuickPick sort (sensitivity 'base', numeric true).
const NUMERIC_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function compareTextNumeric(a: string, b: string): number {
  return NUMERIC_COLLATOR.compare(a, b);
}
