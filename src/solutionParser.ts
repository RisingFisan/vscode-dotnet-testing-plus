import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface SolutionProject {
  name: string;
  path: string;
  guid: string;
  typeGuid: string;
}

const projectLineRegex = /^Project\("([^"]+)"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/;

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
 * Find .sln files at the root of each workspace folder (the "current working
 * directory" from the user's point of view - not process.cwd()).
 */
export function findRootSolutionFiles(): string[] {
  const results: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    try {
      for (const entry of fs.readdirSync(folder.uri.fsPath, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.sln')) {
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
  return vscode.workspace.findFiles('**/*.sln', '**/{bin,obj,node_modules}/**', 100);
}
