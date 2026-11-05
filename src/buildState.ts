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
 * it did not include.
 */
export interface BuildStamp extends InputSummary {
  builtAt: number;
  /** Test projects the build covered, or `null` when it built the whole solution. */
  projects: string[] | null;
}

/**
 * - `current`: the last build covered these projects and the inputs are unchanged.
 * - `coverage`: the inputs are unchanged, but the last build did not include
 *   every requested project.
 * - `inputs`: a build input changed (or is unreadable), so nothing is vouched for.
 * - `unknown`: no build is on record.
 */
export type BuildState = 'current' | 'coverage' | 'inputs' | 'unknown';

const STORE_VERSION = 2;
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
 * unchanged, nothing was modified at or after the build started, and every
 * requested project was built. A sweep (not the watcher) is the evidence, so a
 * missed event cannot produce a stale build.
 */
export async function checkBuild(solutionPath: string, projects: readonly string[]): Promise<BuildState> {
  const stamp = getBuildStamp(solutionPath);
  if (!stamp) {
    return 'unknown';
  }
  const summary = await summarizeBuildInputs(solutionPath);
  if (!summary) {
    return 'unknown';
  }
  if (summary.count !== stamp.count || summary.newestMtimeMs >= stamp.builtAt) {
    markBuildDirty(solutionPath);
    return 'inputs';
  }
  return covers(stamp, projects) ? 'current' : 'coverage';
}
