import * as fs from 'fs';
import * as path from 'path';
import { ExtractedMethod } from './fileScanCache';
import { TEST_ATTRIBUTES } from './testAttributes';

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git']);

// Class declarations anchored at line start (with modifiers) so that the
// word "class" inside comments or strings does not create bogus segments.
const CLASS_RE = /^\s*(?:(?:public|private|internal|protected|static|sealed|abstract|partial|new)\s+)*class\s+(\w+)/gm;
// Test markers may be combined in either order, for example
// [TestCategory("Smoke"), TestMethod]. Every bracket is scanned, so a marker
// in any of a method's attribute lists matches even when other lists precede
// it ([MaxTime(2000)] [Test] ...). Lifecycle attributes (SetUp, TearDown, ...)
// never need excluding: none of them contain a marker word as a whole token,
// so their brackets simply never trigger the lookahead.
const METHOD_RE = new RegExp(
  `\\[(?=[^\\]]*\\b(?:${[...TEST_ATTRIBUTES].join('|')})\\b)[^\\]]*\\][\\s\\S]*?(?:async\\s+)?(?:void|Task(?:<\\w+>)?)\\s+(\\w+)\\s*\\(`,
  'g'
);
const NAMESPACE_RE = /namespace\s+([\w.]+)/;

function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

/**
 * Async listing of every .cs file under `dir`, in readdir order: each entry
 * maps to its own file-or-subtree list and the lists are flattened back in
 * entry order, so the first-wins fold contract keeps seeing exactly the
 * order a sequential depth-first walk produced. Subdirectories are read
 * concurrently — one awaited readdir at a time is what dominates scan time
 * on this filesystem — and the awaits yield to the event loop so a big
 * solution scan does not freeze the shared extension host. Throws if `dir`
 * itself cannot be read; unreadable subdirectories are skipped (like files
 * that disappear mid-scan). `visited`, shared across calls, lets overlapping
 * project roots skip re-walking subtrees an earlier root already listed.
 */
export async function walkCsFilesAsync(
  dir: string,
  isRoot = true,
  visited?: Set<string>
): Promise<string[]> {
  if (visited?.has(dir)) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) {
      throw err;
    }
    return [];
  }
  visited?.add(dir);
  const listings = await Promise.all(entries.map(async entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return isSkippedDir(entry.name) ? [] : walkCsFilesAsync(full, false, visited);
    }
    return /\.cs$/i.test(entry.name) ? [full] : [];
  }));
  return listings.flat();
}

export interface SourceLocation {
  file: string;
  line: number; // 1-based; convert to 0-based Range when used
}

export function extractMethodsRegex(content: string): ExtractedMethod[] {
  // Limitation: NAMESPACE_RE is non-global, so every class in the file is
  // attributed to the first block namespace; a file with several block
  // namespaces mis-names the later classes. (The AST scanner resolves each
  // class's real namespace.)
  const nsMatch = NAMESPACE_RE.exec(content);
  if (!nsMatch) {
    return [];
  }
  const ns = nsMatch[1].replace(/;$/, '');

  const methods: ExtractedMethod[] = [];
  // matchAll yields matches in ascending index order — within a class body,
  // and across classes because the bodies are consecutive slices of the
  // file — so one running newline count replaces the per-method
  // slice/split, which was quadratic on files with many test methods.
  let nextNewline = content.indexOf('\n');
  let newlinesBefore = 0;
  const classMatches = [...content.matchAll(CLASS_RE)];
  for (let i = 0; i < classMatches.length; i++) {
    const className = classMatches[i][1];
    const start = classMatches[i].index ?? 0;
    const end = i + 1 < classMatches.length ? (classMatches[i + 1].index ?? content.length) : content.length;
    const classBody = content.slice(start, end);

    for (const m of classBody.matchAll(METHOD_RE)) {
      const method = m[1];
      // m[0] starts at the [TestMethod] attribute; offset to the captured
      // method name (just before the opening parenthesis) so navigation
      // lands on the method declaration line.
      const matchText = m[0];
      const parenIdx = matchText.lastIndexOf('(');
      const nameIdx = parenIdx >= 0 ? matchText.lastIndexOf(method, parenIdx) : matchText.lastIndexOf(method);
      const methodIndexInFile = start + (m.index ?? 0) + Math.max(nameIdx, 0);
      while (nextNewline >= 0 && nextNewline < methodIndexInFile) {
        newlinesBefore++;
        nextNewline = content.indexOf('\n', nextNewline + 1);
      }
      const line = newlinesBefore + 1;
      methods.push({ bare: method, fullyQualifiedName: `${ns}.${className}.${method}`, line });
    }
  }
  return methods;
}
