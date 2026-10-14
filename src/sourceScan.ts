import * as fs from 'fs';
import * as path from 'path';
import { foldMethods, ExtractedMethod } from './fileScanCache';
import { TEST_ATTRIBUTES, mayContainTests } from './testAttributes';

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
 * Synchronous listing of every .cs file under `dir`, in readdir order. Uses a
 * shared accumulator (spreading each subdirectory's array copied the results
 * once per tree level and could exceed the argument limit on huge trees).
 */
export function walkCsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDir(entry.name)) {
        walkCsFiles(full, files);
      }
    } else if (/\.cs$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Same listing and order as {@link walkCsFiles}, but yields to the event loop
 * on every directory so a big solution scan does not freeze the shared
 * extension host. Throws if `dir` itself cannot be read; unreadable
 * subdirectories are skipped (like files that disappear mid-scan).
 */
export async function walkCsFilesAsync(dir: string, files: string[] = [], isRoot = true): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) {
      throw err;
    }
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDir(entry.name)) {
        await walkCsFilesAsync(full, files, false);
      }
    } else if (/\.cs$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}
export interface SourceLocation {
  file: string;
  line: number; // 1-based; convert to 0-based Range when used
}

export interface MethodIndexResult {
  /** bare method name -> fully-qualified names */
  methodIndex: Map<string, Set<string>>;
  /** fully-qualified name -> source file + line */
  locations: Map<string, SourceLocation>;
  /** fully-qualified name -> owning csproj path */
  projects: Map<string, string>;
}

export function extractMethodsRegex(content: string): ExtractedMethod[] {
  const nsMatch = NAMESPACE_RE.exec(content);
  if (!nsMatch) {
    return [];
  }
  const ns = nsMatch[1].replace(/;$/, '');

  const methods: ExtractedMethod[] = [];
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
      const line = content.slice(0, methodIndexInFile).split('\n').length;
      methods.push({ bare: method, fullyQualifiedName: `${ns}.${className}.${method}`, line });
    }
  }
  return methods;
}

/**
 * Regex-based scanner fallback (used by harnesses and by anyone calling the
 * old API directly). The runtime fallback path in astScan.ts runs the same
 * extractor through the incremental driver, so it also benefits from the
 * per-file scan cache.
 */
export function buildMethodIndex(projectPaths: string[]): MethodIndexResult {
  const methodIndex = new Map<string, Set<string>>();
  const locations = new Map<string, SourceLocation>();
  const projects = new Map<string, string>();

  for (const csprojPath of projectPaths) {
    let files: string[];
    try {
      files = walkCsFiles(path.dirname(csprojPath));
    } catch {
      continue;
    }
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!mayContainTests(content)) {
        continue;
      }
      foldMethods(extractMethodsRegex(content), file, csprojPath, methodIndex, locations, projects);
    }
  }

  return { methodIndex, locations, projects };
}
