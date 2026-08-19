import * as fs from 'fs';
import * as path from 'path';

interface CacheEntry {
  slnMtimeMs: number;
  projectMtimes: Record<string, number>;
  tests: string[];
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
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(slnPath: string, projectPaths: string[]): string[] | undefined {
    const entry = this.data[slnPath];
    if (!entry) {
      return undefined;
    }
    if (mtimeOf(slnPath) !== entry.slnMtimeMs) {
      return undefined;
    }
    for (const project of projectPaths) {
      if (mtimeOf(project) !== entry.projectMtimes[project]) {
        return undefined;
      }
    }
    return entry.tests;
  }

  set(slnPath: string, projectPaths: string[], tests: string[]): void {
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
    this.data[slnPath] = { slnMtimeMs, projectMtimes, tests };
  }

  invalidate(slnPath: string): void {
    delete this.data[slnPath];
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      // Caching is best-effort.
    }
  }
}
