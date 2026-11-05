import * as fs from 'fs';
import * as path from 'path';

/** What a build's inputs looked like, as far as staleness is concerned. */
export interface InputSummary {
  /** Newest modification time among the build inputs, in epoch milliseconds. */
  newestMtimeMs: number;
  /** Number of build inputs, so creations and deletions are noticed too. */
  count: number;
}

/** Extensions of files whose content can change a compiled output. */
const INPUT_EXTENSIONS = new Set([
  '.cs', '.csproj', '.props', '.targets', '.resx', '.xaml', '.sln', '.slnf', '.slnx',
  // Embedded/content inputs and source-generator inputs compiled into an output.
  '.razor', '.cshtml', '.tt', '.sql', '.xml', '.json', '.html', '.css', '.js', '.txt', '.ini', '.config'
]);
/** Inputs that carry no useful extension, plus the shared ones without a wildcard match. */
const INPUT_NAMES = new Set(['packages.lock.json', 'global.json', 'nuget.config']);
/** Build and VCS directories: pruned for speed, and they churn on every build. */
const PRUNED_DIRS = new Set(['bin', 'obj', 'TestResults', '.git', '.vs', 'node_modules']);
/** MSBuild and the SDK read these from ancestor directories, outside the solution tree. */
const ANCESTOR_NAMES = ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'global.json', 'nuget.config'];
/** A solution too large to summarize quickly falls back to building. */
const WALK_BUDGET_MS = 2000;
/** Bound on the project-reference closure, so a pathological graph cannot stall a run. */
const MAX_REFERENCED_PROJECTS = 4000;

function isInput(name: string): boolean {
  return INPUT_NAMES.has(name) || INPUT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Resolve an MSBuild-relative path (backslash-separated even on Unix) from `base`. */
function resolveMsBuildPath(base: string, value: string): string {
  return path.resolve(base, value.replace(/\\/g, '/'));
}

/**
 * Directories of the projects a solution lists, resolved from its own text.
 * `.slnf` files name a base solution instead of projects, so they are followed
 * once to that file (a filter cannot introduce projects the base does not have).
 */
function solutionProjectFiles(solutionPath: string): string[] {
  try {
    const text = fs.readFileSync(solutionPath, 'utf8');
    if (path.extname(solutionPath).toLowerCase() === '.slnf') {
      const base = JSON.parse(text)?.solution?.path;
      return typeof base === 'string'
        ? solutionProjectFiles(path.resolve(path.dirname(solutionPath), base))
        : [];
    }
    const dir = path.dirname(solutionPath);
    return [...text.matchAll(/"([^"]*\.csproj)"/g)]
      .map(match => resolveMsBuildPath(dir, match[1]))
      .filter(file => fs.existsSync(file));
  } catch {
    return [];
  }
}

/** Projects a project file references, resolved and relative to its own directory. */
function projectReferences(projectFile: string): string[] {
  try {
    const text = fs.readFileSync(projectFile, 'utf8');
    return [...text.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/g)]
      .map(match => resolveMsBuildPath(path.dirname(projectFile), match[1]))
      .filter(file => fs.existsSync(file));
  } catch {
    return [];
  }
}

/**
 * Every directory whose files can change this solution's build outputs: the
 * solution's own tree, plus the projects it lists and everything those
 * reference. The reference closure matters because e2e test projects routinely
 * reference page objects or shared helpers that live outside the solution
 * directory, and a change there must not be mistaken for "nothing changed".
 */
function inputRoots(solutionPath: string): string[] {
  const roots = new Set<string>([path.dirname(solutionPath)]);
  const queue = solutionProjectFiles(solutionPath);
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < MAX_REFERENCED_PROJECTS) {
    const project = queue.pop()!;
    if (visited.has(project)) {
      continue;
    }
    visited.add(project);
    roots.add(path.dirname(project));
    queue.push(...projectReferences(project));
  }
  return [...roots];
}

async function record(summary: InputSummary, file: string): Promise<void> {
  const stat = await fs.promises.stat(file);
  summary.count += 1;
  if (stat.mtimeMs > summary.newestMtimeMs) {
    summary.newestMtimeMs = stat.mtimeMs;
  }
}

/**
 * Summarizes every file that can invalidate a solution's build outputs: the
 * sources and project files under the solution and its referenced projects,
 * plus the MSBuild/NuGet files inherited from its ancestor directories (which
 * the file watcher cannot attribute to this solution).
 *
 * Over-approximates on purpose: a file that does not affect the build only
 * makes the stamp stale, which costs one rebuild, never a stale binary.
 * Returns `undefined` when the walk cannot finish in budget, and the caller
 * then treats the build as dirty.
 */
export async function summarizeBuildInputs(solutionPath: string): Promise<InputSummary | undefined> {
  const summary: InputSummary = { newestMtimeMs: 0, count: 0 };
  const root = path.dirname(solutionPath);
  const pending = inputRoots(solutionPath);
  // A project directory can be inside another root (and several projects can
  // share one), so files must be counted once.
  const visitedDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const startedAt = Date.now();
  try {
    while (pending.length > 0) {
      if (Date.now() - startedAt > WALK_BUDGET_MS) {
        return undefined;
      }
      const dir = pending.pop()!;
      if (visitedDirs.has(dir)) {
        continue;
      }
      visitedDirs.add(dir);
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!PRUNED_DIRS.has(entry.name)) {
            pending.push(full);
          }
        } else if (entry.isFile() && isInput(entry.name) && !seenFiles.has(full)) {
          seenFiles.add(full);
          await record(summary, full);
        }
      }
    }
    for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
      for (const name of ANCESTOR_NAMES) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) {
          await record(summary, file);
        }
      }
      if (dir === path.dirname(dir)) {
        break;
      }
    }
    return summary;
  } catch {
    return undefined;
  }
}
