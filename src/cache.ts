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
   * Digest of the FQNs the source scan found when 	ests was cached. A source
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

  constructor(storageDir: string) {
    this.file = path.join(storageDir, 'solution-cache.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.data = {};
    }
  }

  get(slnPath: string, projectPaths: string[], parserVersion: string | undefined, scanFingerprint?: string): string[] | undefined {
    const entry = this.data[slnPath];
    if (!entry) {
      return undefined;
    }
    if (
      mtimeOf(slnPath) !== entry.slnMtimeMs ||
      entry.parserVersion !== parserVersion ||
      entry.scanFingerprint !== scanFingerprint
    ) {
      return undefined;
    }
    for (const project of projectPaths) {
      if (mtimeOf(project) !== entry.projectMtimes[project]) {
        return undefined;
      }
    }
    return entry.tests;
  }

  set(slnPath: string, projectPaths: string[], tests: string[], parserVersion: string | undefined, scanFingerprint?: string): void {
    const slnMtimeMs = mtimeOf(slnPath);
    if (slnMtimeMs === undefined) {
      return;
    }
    const projectMtimes: Record<string, number> = {};
    for (const project of projectPaths) {
      const mtime = mtimeOf(project);
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
