import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './fileScanCache';

interface CacheEntry {
  slnMtimeMs: number;
  projectMtimes: Record<string, number>;
  tests: string[];
  /**
   * Scanner implementation/version that produced `tests` ('ast-1' or
   * 'regex-1'). Entries written by older releases have none, which never
   * matches a current version, so they are treated as stale once.
   */
  parserVersion?: string;
  /**
   * Digest of the FQNs the source scan found when tests was cached. A source
   * edit that adds/removes/renames a test changes it without touching any
   * .sln/.csproj mtime, so it invalidates the entry. Absent on older entries
   * (treated as stale once).
   */
  scanFingerprint?: string;
}

type CacheData = Record<string, CacheEntry>;

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

export class SolutionCache {
  private data: CacheData = {};
  private readonly file: string;
  /**
   * Stats from the most recent `get`. `set` reuses them when it targets the
   * same solution, so a discovery cycle stats each file once instead of twice.
   * Recording the pre-discovery mtimes is also the conservative choice: any
   * file changed during discovery simply misses the cache next time.
   */
  private lastStats?: { slnPath: string; projectsKey: string; slnMtimeMs: number | undefined; projectMtimes: Record<string, number | undefined> };

  constructor(storageDir: string) {
    this.file = path.join(storageDir, 'solution-cache.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.data = {};
    }
  }

  private statProjects(slnPath: string, projectPaths: string[]): { slnMtimeMs: number | undefined; projectMtimes: Record<string, number | undefined> } {
    const projectMtimes: Record<string, number | undefined> = {};
    for (const project of projectPaths) {
      projectMtimes[project] = mtimeOf(project);
    }
    return { slnMtimeMs: mtimeOf(slnPath), projectMtimes };
  }

  get(slnPath: string, projectPaths: string[], parserVersion: string | undefined, scanFingerprint?: string): string[] | undefined {
    const entry = this.data[slnPath];
    const stats = this.statProjects(slnPath, projectPaths);
    this.lastStats = { slnPath, projectsKey: projectPaths.join('\n'), ...stats };
    if (!entry) {
      return undefined;
    }
    if (
      stats.slnMtimeMs !== entry.slnMtimeMs ||
      entry.parserVersion !== parserVersion ||
      entry.scanFingerprint !== scanFingerprint
    ) {
      return undefined;
    }
    for (const [project, mtime] of Object.entries(stats.projectMtimes)) {
      if (mtime !== entry.projectMtimes[project]) {
        return undefined;
      }
    }
    // A copy: callers must not be able to mutate the persisted entry.
    return entry.tests.slice();
  }

  set(slnPath: string, projectPaths: string[], tests: string[], parserVersion: string | undefined, scanFingerprint?: string): void {
    const stats = this.lastStats && this.lastStats.slnPath === slnPath && this.lastStats.projectsKey === projectPaths.join('\n')
      ? this.lastStats
      : this.statProjects(slnPath, projectPaths);
    const slnMtimeMs = stats.slnMtimeMs;
    if (slnMtimeMs === undefined) {
      return;
    }
    const projectMtimes: Record<string, number> = {};
    for (const [project, mtime] of Object.entries(stats.projectMtimes)) {
      if (mtime !== undefined) {
        projectMtimes[project] = mtime;
      }
    }
    this.data[slnPath] = { slnMtimeMs, projectMtimes, tests, parserVersion, scanFingerprint };
  }

  invalidate(slnPath: string): void {
    delete this.data[slnPath];
  }

  save(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data));
    } catch {
      // Caching is best-effort.
    }
  }
}
