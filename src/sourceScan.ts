import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git']);

// Class declarations anchored at line start (with modifiers) so that the
// word "class" inside comments or strings does not create bogus segments.
const CLASS_RE = /^\s*(?:(?:public|private|internal|protected|static|sealed|abstract|partial|new)\s+)*class\s+(\w+)/gm;
const METHOD_RE = /\[(?:TestMethod|DataTestMethod)(?:\([^\]]*\))?(?:\s*,[^\]]*)?\][\s\S]*?(?:async\s+)?(?:void|Task(?:<\w+>)?)\s+(\w+)\s*\(/g;
const NAMESPACE_RE = /namespace\s+([\w.]+)/;

function walkCsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        files.push(...walkCsFiles(full));
      }
    } else if (entry.name.endsWith('.cs')) {
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

/**
 * Scan the solution's projects for [TestMethod]/[DataTestMethod] declarations
 * in any class (including partial classes whose [TestClass] attribute lives in
 * another file) and build:
 * - a map of bare method name -> fully-qualified names (namespace.class.method)
 * - a map of fully-qualified name -> source file and line number
 *
 * `dotnet test --list-tests` on SDKs using Microsoft.Testing.Platform only
 * prints bare method names; the index lets us map them back to the
 * fully-qualified names playlists use, and the locations let VS Code navigate
 * to the test source and attach locations to results.
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
      const nsMatch = NAMESPACE_RE.exec(content);
      if (!nsMatch) {
        continue;
      }
      const ns = nsMatch[1].replace(/;$/, '');

      const classMatches = [...content.matchAll(CLASS_RE)];
      for (let i = 0; i < classMatches.length; i++) {
        const className = classMatches[i][1];
        const start = classMatches[i].index ?? 0;
        const end = i + 1 < classMatches.length ? (classMatches[i + 1].index ?? content.length) : content.length;
        const classBody = content.slice(start, end);

        for (const m of classBody.matchAll(METHOD_RE)) {
          const method = m[1];
          const fqn = `${ns}.${className}.${method}`;
          const set = methodIndex.get(method) ?? new Set<string>();
          set.add(fqn);
          methodIndex.set(method, set);

          if (!locations.has(fqn)) {
            // m[0] starts at the [TestMethod] attribute; offset to the
            // captured method name (just before the opening parenthesis) so
            // navigation lands on the method declaration line.
            const matchText = m[0];
            const parenIdx = matchText.lastIndexOf('(');
            const nameIdx = parenIdx >= 0 ? matchText.lastIndexOf(method, parenIdx) : matchText.lastIndexOf(method);
            const methodIndexInFile = start + (m.index ?? 0) + Math.max(nameIdx, 0);
            const line = content.slice(0, methodIndexInFile).split('\n').length;
            locations.set(fqn, { file, line });
          }
          if (!projects.has(fqn)) {
            projects.set(fqn, csprojPath);
          }
        }
      }
    }
  }

  return { methodIndex, locations, projects };
}
