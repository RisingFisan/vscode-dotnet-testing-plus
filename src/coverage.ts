import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { asArray } from './util';

/**
 * Collects Cobertura coverage produced by `dotnet test --collect:"XPlat Code
 * Coverage"` into VS Code's native test coverage API. Details are parsed
 * eagerly and cached on the FileCoverage instance, so the underlying XML files
 * can be deleted right after collection (mirroring the TRX cleanup).
 */

interface CoverageLine {
  hits: number;
  branches: { covered: number; total: number }[];
}

export interface CoverageState {
  sinceMs: number;
  files: vscode.FileCoverage[];
}

const detailsCache = new WeakMap<vscode.FileCoverage, vscode.FileCoverageDetail[]>();
// Filesystem timestamps can lag the recorded run start slightly.
const MTIME_SLACK_MS = 2000;

export function coverageDetailsFor(fileCoverage: vscode.FileCoverage): vscode.FileCoverageDetail[] {
  return detailsCache.get(fileCoverage) ?? [];
}

export function newCoverageState(): CoverageState {
  return { sinceMs: Date.now(), files: [] };
}

/**
 * Gather every coverage report produced for the given test project since
 * `sinceMs` (a project may run in several batches, each writing its own
 * report), merge them per source file, and delete the XML files.
 */
export async function collectProjectCoverage(csprojPath: string, coverage: CoverageState): Promise<vscode.FileCoverage[]> {
  const testResultsDir = path.join(path.dirname(csprojPath), 'TestResults');
  const reports = findCoberturaFiles(testResultsDir, coverage.sinceMs);
  if (reports.length === 0) {
    return [];
  }
  const merged = new Map<string, Map<number, CoverageLine>>();
  for (const report of reports) {
    try {
      await mergeCobertura(report, path.dirname(csprojPath), merged);
    } catch {
      // An unreadable report must not fail the whole run.
    }
  }
  const files: vscode.FileCoverage[] = [];
  for (const [file, lines] of merged) {
    const details = buildDetails(lines);
    const fileCoverage = vscode.FileCoverage.fromDetails(vscode.Uri.file(file), details);
    detailsCache.set(fileCoverage, details);
    files.push(fileCoverage);
  }
  for (const report of reports) {
    try {
      fs.rmSync(report, { force: true });
      // dotnet creates one GUID folder per run; drop it once it is empty so
      // TestResults does not accumulate empty directories (rmdir refuses if
      // anything else is still inside).
      fs.rmdirSync(path.dirname(report));
    } catch {
      // Best-effort cleanup, same as TRX.
    }
  }
  return files;
}

function findCoberturaFiles(testResultsDir: string, sinceMs: number): string[] {
  if (!fs.existsSync(testResultsDir)) {
    return [];
  }
  const reports: string[] = [];
  for (const entry of fs.readdirSync(testResultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runDir = path.join(testResultsDir, entry.name);
    for (const file of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!file.isFile() || !/^coverage.*\.xml$/i.test(file.name)) {
        continue;
      }
      const full = path.join(runDir, file.name);
      try {
        if (fs.statSync(full).mtimeMs >= sinceMs - MTIME_SLACK_MS) {
          reports.push(full);
        }
      } catch {
        // Unreadable file; skip it.
      }
    }
  }
  return reports;
}

// Reports can be tens of MB: read asynchronously and let the event loop breathe
// before the (synchronous) parse so the shared extension host stays responsive.
const COBERTURA_PARSER = new XMLParser({ ignoreAttributes: false });

async function mergeCobertura(reportPath: string, projectDir: string, merged: Map<string, Map<number, CoverageLine>>): Promise<void> {
  const xml = await fs.promises.readFile(reportPath, 'utf8');
  await new Promise<void>(resolve => setImmediate(resolve));
  const doc = COBERTURA_PARSER.parse(xml) as {
    coverage?: {
      packages?: {
        package?: Record<string, unknown> | Record<string, unknown>[];
      };
    };
  };
  const packages = asArray<Record<string, unknown>>(doc.coverage?.packages?.package);
  for (const pkg of packages) {
    const classes = asArray<Record<string, unknown>>((pkg.classes as { class?: Record<string, unknown> | Record<string, unknown>[] } | undefined)?.class);
    for (const cls of classes) {
      const file = resolveSourceFile(cls.filename, projectDir);
      if (!file) {
        continue;
      }
      const lines = merged.get(file) ?? new Map<number, CoverageLine>();
      merged.set(file, lines);
      const lineEntries = asArray<Record<string, unknown>>((cls.lines as { line?: Record<string, unknown> | Record<string, unknown>[] } | undefined)?.line);
      for (const line of lineEntries) {
        const number = Number(line['@_number']);
        if (!Number.isInteger(number) || number < 1) {
          continue;
        }
        const hits = Number(line['@_hits']) || 0;
        const branches = parseConditionCoverage(line['@_condition-coverage']);
        const existing = lines.get(number);
        if (existing) {
          // The same line can appear in several class entries (partial classes).
          existing.hits += hits;
          if (branches && existing.branches.length === 0) {
            existing.branches = branches;
          }
        } else {
          lines.set(number, { hits, branches: branches ?? [] });
        }
      }
    }
  }
}

function parseConditionCoverage(value: unknown): { covered: number; total: number }[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /\((\d+)\/(\d+)\)/.exec(value);
  if (!match) {
    return undefined;
  }
  return [{ covered: Number(match[1]), total: Number(match[2]) }];
}

function resolveSourceFile(filename: unknown, projectDir: string): string | undefined {
  if (typeof filename !== 'string' || filename.length === 0) {
    return undefined;
  }
  const normalized = filename.replace(/\\/g, path.sep);
  return path.isAbsolute(normalized) ? normalized : path.resolve(projectDir, normalized);
}

function buildDetails(lines: Map<number, CoverageLine>): vscode.FileCoverageDetail[] {
  const details: vscode.FileCoverageDetail[] = [];
  for (const [number, line] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
    const range = new vscode.Range(number - 1, 0, number - 1, 0);
    const branches = line.branches
      .filter(branch => branch.total > 0)
      .map(branch => new vscode.BranchCoverage(branch.covered, range));
    details.push(new vscode.StatementCoverage(line.hits, range, branches));
  }
  return details;
}
