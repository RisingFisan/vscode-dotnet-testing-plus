import * as fs from 'fs';
import * as path from 'path';
import { InputSummary, summarizeBuildInputs } from './buildInputs';

/**
 * What is known about the last successful build of a solution.
 *
 * `builtAt` is the build's *start*: an input modified at or after it may not
 * have been compiled, or may have been compiled from a version this stamp
 * cannot vouch for, so it invalidates the stamp. `count` catches files being
 * added or removed, which a timestamp comparison alone cannot see. `projects`
 * records what the build covered: a slice build cannot vouch for the projects
 * it did not include. `configuration` records what the outputs were built for,
 * so a different configuration can never reuse another one's stamp.
 */
export interface BuildStamp extends InputSummary {
  builtAt: number;
  /** Test projects the build covered, or `null` when it built the whole solution. */
  projects: string[] | null;
  /** Build configuration the outputs were produced for (we always build Debug). */
  configuration: string;
}

/**
 * - `current`: the last build covered these projects and the inputs are unchanged.
 * - `coverage`: the inputs are unchanged, but the last build did not include
 *   every requested project.
 * - `inputs`: a build input changed (or is unreadable), so nothing is vouched for.
 * - `unknown`: no build is on record.
 */
export type BuildState = 'current' | 'coverage' | 'inputs' | 'unknown';

const STORE_VERSION = 3;
const stamps = new Map<string, BuildStamp>();
let storeFile: string | undefined;

/**
 * Points the store at a file (global storage) and loads what it holds, so a
 * window reload does not force a rebuild of an untouched solution.
 */
export function configureBuildState(file: string | undefined): void {
  storeFile = file;
  stamps.clear();
  if (!file) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version?: number;
      stamps?: Record<string, BuildStamp>;
    };
    if (parsed.version !== STORE_VERSION || !parsed.stamps) {
      return;
    }
    for (const [solutionPath, stamp] of Object.entries(parsed.stamps)) {
      if (isStamp(stamp)) {
        stamps.set(solutionPath, stamp);
      }
    }
  } catch {
    // A missing or unreadable store just means no solution is known to be clean.
  }
}

function isStamp(value: unknown): value is BuildStamp {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const stamp = value as Partial<BuildStamp>;
  return typeof stamp.builtAt === 'number' &&
    typeof stamp.count === 'number' &&
    typeof stamp.newestMtimeMs === 'number' &&
    typeof stamp.configuration === 'string' &&
    (stamp.projects === null ||
      (Array.isArray(stamp.projects) && stamp.projects.every(project => typeof project === 'string')));
}

function persist(): void {
  if (!storeFile) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ version: STORE_VERSION, stamps: Object.fromEntries(stamps) }));
  } catch {
    // Persisting is an optimization; the in-memory stamps still serve this session.
  }
}

function covers(stamp: BuildStamp, projects: readonly string[]): boolean {
  if (stamp.projects == null) {
    return true;
  }
  if (projects.length === 0) {
    return false;
  }
  const built = new Set(stamp.projects);
  return projects.every(project => built.has(path.resolve(project)));
}

export function getBuildStamp(solutionPath: string): BuildStamp | undefined {
  return stamps.get(path.resolve(solutionPath));
}

/**
 * Whether a test project still has the assembly last built for it. The input
 * sweep cannot see a wiped `bin`/`obj` (both are pruned, because a build
 * rewrites them), and `dotnet test --no-build` would then fail against a stamp
 * that still says the build is current.
 */
async function hasBuildOutput(projectPath: string, configuration: string): Promise<boolean> {
  const binDir = path.join(path.dirname(projectPath), 'bin', configuration);
  let targets: fs.Dirent[];
  try {
    targets = await fs.promises.readdir(binDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const target of targets) {
    if (!target.isDirectory()) {
      continue;
    }
    try {
      const files = await fs.promises.readdir(path.join(binDir, target.name));
      if (files.some(name => name.endsWith('.dll'))) {
        return true;
      }
    } catch {
      // An unreadable output directory is simply not evidence of a built assembly.
    }
  }
  return false;
}

async function outputsPresent(projects: readonly string[], configuration: string): Promise<boolean> {
  for (const project of projects) {
    if (!(await hasBuildOutput(project, configuration))) {
      return false;
    }
  }
  return true;
}

export function markBuildClean(solutionPath: string, stamp: BuildStamp): void {
  stamps.set(path.resolve(solutionPath), stamp);
  persist();
}

export function markBuildDirty(solutionPath: string): void {
  if (stamps.delete(path.resolve(solutionPath))) {
    persist();
  }
}

/**
 * Whether the last build still covers a run of `projects`: the input set is
 * unchanged, nothing was modified at or after the build started, every
 * requested project was built, and its assembly is still on disk. A sweep (not
 * the watcher) is the evidence, so a missed event cannot produce a stale build.
 */
export async function checkBuild(
  solutionPath: string,
  projects: readonly string[],
  configuration: string
): Promise<BuildState> {
  const stamp = getBuildStamp(solutionPath);
  if (!stamp) {
    return 'unknown';
  }
  if (stamp.configuration !== configuration) {
    markBuildDirty(solutionPath);
    return 'inputs';
  }
  const summary = await summarizeBuildInputs(solutionPath);
  if (!summary) {
    return 'unknown';
  }
  if (summary.count !== stamp.count || summary.newestMtimeMs >= stamp.builtAt) {
    markBuildDirty(solutionPath);
    return 'inputs';
  }
  if (!covers(stamp, projects)) {
    return 'coverage';
  }
  if (!(await outputsPresent(projects, configuration))) {
    // bin/obj were wiped or cleaned: the sources are unchanged, but there is
    // nothing left to run.
    markBuildDirty(solutionPath);
    return 'inputs';
  }
  return 'current';
}
