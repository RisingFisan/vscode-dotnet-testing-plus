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
const INPUT_EXTENSIONS = new Set(['.cs', '.csproj', '.props', '.targets', '.resx', '.xaml', '.sln', '.slnf', '.slnx']);
/** Inputs that carry no useful extension, plus the shared ones without a wildcard match. */
const INPUT_NAMES = new Set(['packages.lock.json', 'global.json', 'nuget.config']);
/** Build and VCS directories: pruned for speed, and they churn on every build. */
const PRUNED_DIRS = new Set(['bin', 'obj', 'TestResults', '.git', '.vs', 'node_modules']);
/** MSBuild and the SDK read these from ancestor directories, outside the solution tree. */
const ANCESTOR_NAMES = ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'global.json', 'nuget.config'];
/** A solution too large to summarize quickly falls back to building. */
const WALK_BUDGET_MS = 2000;

function isInput(name: string): boolean {
  return INPUT_NAMES.has(name) || INPUT_EXTENSIONS.has(path.extname(name).toLowerCase());
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
 * sources and project files under it, plus the MSBuild/NuGet files inherited
 * from its ancestor directories (which the file watcher cannot attribute to
 * this solution).
 *
 * Over-approximates on purpose: a file that does not affect the build only
 * makes the stamp stale, which costs one rebuild, never a stale binary.
 * Returns `undefined` when the walk cannot finish in budget, and the caller
 * then treats the build as dirty.
 */
export async function summarizeBuildInputs(solutionPath: string): Promise<InputSummary | undefined> {
  const summary: InputSummary = { newestMtimeMs: 0, count: 0 };
  const root = path.dirname(solutionPath);
  const pending = [root];
  const startedAt = Date.now();
  try {
    while (pending.length > 0) {
      if (Date.now() - startedAt > WALK_BUDGET_MS) {
        return undefined;
      }
      const dir = pending.pop()!;
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!PRUNED_DIRS.has(entry.name)) {
            pending.push(full);
          }
        } else if (entry.isFile() && isInput(entry.name)) {
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
