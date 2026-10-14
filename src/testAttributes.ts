/**
 * Test marker attributes shared by the regex scan (sourceScan.ts) and the
 * AST scan (astScan.ts). Both compare attribute names exactly (last dotted
 * segment, `Attribute` suffix stripped, case-insensitive), so lifecycle
 * attributes like SetUp/TestInitialize never match and need no denylist.
 */
export const TEST_ATTRIBUTES: ReadonlySet<string> = new Set([
  'TestMethod', 'DataTestMethod',      // MSTest
  'Fact', 'Theory',                    // xUnit
  'Test', 'TestCase', 'TestCaseSource' // NUnit
]);

/**
 * Cheap superset pre-check: a file without any marker as a whole word (with or
 * without the Attribute suffix, any case) cannot contain a test method under
 * either scanner, so it can be cached as empty without a parse or regex pass.
 * Matches in comments and strings are fine; they only cost a normal scan.
 */
const TEST_MARKER_RE = new RegExp(`\\b(?:${[...TEST_ATTRIBUTES].join('|')})(?:Attribute)?\\b`, 'i');

export function mayContainTests(content: string): boolean {
  return TEST_MARKER_RE.test(content);
}
