import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

export interface SolutionProject {
  name: string;
  path: string;
  guid: string;
  typeGuid: string;
}

export interface SolutionFile {
  projects: SolutionProject[];
  /**
   * Additional files whose content affects the project list but are not
   * projects themselves (e.g. the base .sln a .slnf filters). Included in
   * cache validation so edits to them invalidate cached test lists.
   */
  cacheDependencies: string[];
}

const projectLineRegex = /^Project\("([^"]+)"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/;

/**
 * Parse any supported solution file format (.sln, .slnf, .slnx) into its
 * C# project list.
 */
export function parseSolutionFile(slnPath: string): SolutionFile {
  switch (path.extname(slnPath).toLowerCase()) {
    case '.slnf':
      return parseSolutionFilter(slnPath);
    case '.slnx':
      return parseSlnx(slnPath);
    default:
      return { projects: parseSolution(slnPath), cacheDependencies: [] };
  }
}

function parseSolutionFilter(slnfPath: string): SolutionFile {
  const slnfDir = path.dirname(slnfPath);
  const filter = JSON.parse(fs.readFileSync(slnfPath, 'utf8')) as {
    solution?: { path?: string; projects?: string[] };
  };
  const baseRel = filter.solution?.path;
  if (!baseRel) {
    throw new Error(`Solution filter ${path.basename(slnfPath)} declares no base solution`);
  }
  const basePath = path.resolve(slnfDir, baseRel);
  const allowed = new Set(
    (filter.solution?.projects ?? []).map(p => path.resolve(path.dirname(basePath), p.replace(/\\/g, path.sep)).toLowerCase())
  );
  const projects = parseSolution(basePath).filter(p => allowed.has(p.path.toLowerCase()));
  return { projects, cacheDependencies: [basePath] };
}

function parseSlnx(slnxPath: string): SolutionFile {
  const slnxDir = path.dirname(slnxPath);
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(fs.readFileSync(slnxPath, 'utf8')) as {
    Solution?: { Project?: unknown };
  };
  const raw = doc.Solution?.Project;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const projects: SolutionProject[] = [];
  for (const entry of entries) {
    const attrs = entry as Record<string, unknown>;
    const relPath = typeof attrs['@_Path'] === 'string' ? attrs['@_Path'] : undefined;
    if (!relPath || path.extname(relPath).toLowerCase() !== '.csproj') {
      continue;
    }
    projects.push({
      typeGuid: typeof attrs['@_Type'] === 'string' ? attrs['@_Type'] : '',
      name: path.basename(relPath, '.csproj'),
      guid: '',
      path: path.resolve(slnxDir, relPath.replace(/\\/g, path.sep))
    });
  }
  return { projects, cacheDependencies: [] };
}

export function parseSolution(slnPath: string): SolutionProject[] {
  const slnDir = path.dirname(slnPath);
  const text = fs.readFileSync(slnPath, 'utf8');
  const projects: SolutionProject[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = projectLineRegex.exec(line);
    if (!match) {
      continue;
    }
    const [, typeGuid, name, relPath, guid] = match;
    if (path.extname(relPath).toLowerCase() !== '.csproj') {
      continue;
    }
    projects.push({
      typeGuid,
      name,
      guid,
      path: path.resolve(slnDir, relPath.replace(/\\/g, path.sep))
    });
  }

  return projects;
}

/**
 * Find .sln, .slnf and .slnx files at the root of each workspace folder (the
 * "current working directory" from the user's point of view - not process.cwd()).
 */
export function findRootSolutionFiles(): string[] {
  const solutionExtensions = new Set(['.sln', '.slnf', '.slnx']);
  const results: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    try {
      for (const entry of fs.readdirSync(folder.uri.fsPath, { withFileTypes: true })) {
        if (entry.isFile() && solutionExtensions.has(path.extname(entry.name).toLowerCase())) {
          results.push(path.join(folder.uri.fsPath, entry.name));
        }
      }
    } catch {
      // Unreadable folder; skip it.
    }
  }
  return results;
}

export async function findAllSolutionFiles(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles('**/*.{sln,slnf,slnx}', '**/{bin,obj,node_modules}/**', 100);
}
