/**
 * Shared collator. `String.prototype.localeCompare` builds/looks up an ICU
 * collator on every call, which dominates sort time for tens of thousands of
 * labels; one `Intl.Collator` instance yields the identical ordering far faster.
 */
const COLLATOR = new Intl.Collator();

export function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

export const compareStrings = compareText;

