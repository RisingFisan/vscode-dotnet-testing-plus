import * as vscode from 'vscode';
import * as path from 'path';
import { findAllSolutionFiles, findRootSolutionFiles } from './solutionParser';
import { log } from './logger';

/**
 * If exactly one .sln exists at a workspace folder root, use it.
 */
export function detectRootSolution(): string | undefined {
  const roots = findRootSolutionFiles();
  if (roots.length === 1) {
    log(`Single root-level solution found: ${roots[0]}`);
    return roots[0];
  }
  if (roots.length > 1) {
    log(`Multiple root-level solutions found (${roots.length}); user must pick`);
  }
  return undefined;
}

/**
 * Silently resolve a single root-level .sln. Never prompts.
 */
export async function resolveSolutionSilently(): Promise<string | undefined> {
  return detectRootSolution();
}

/**
 * Interactive resolution: QuickPick of workspace .sln files, falling back to
 * an open dialog when the workspace contains none.
 */
export async function pickSolutionInteractively(): Promise<string | undefined> {
  const solutions = await findAllSolutionFiles();
  if (solutions.length === 0) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Visual Studio Solution': ['sln'] },
      title: 'Select a Visual Studio .sln file'
    });
    return uris?.[0]?.fsPath;
  }

  // Sort solutions alphabetically by relative path (or fsPath if outside workspace)
  const items = solutions
    .map(u => {
      const relPath = vscode.workspace.asRelativePath(u, false);
      return {
        label: path.basename(u.fsPath),
        description: relPath !== path.basename(u.fsPath) ? path.dirname(relPath) : '',
        detail: relPath,
        fsPath: u.fsPath
      };
    })
    .sort((a, b) => a.detail.localeCompare(b.detail, undefined, { sensitivity: 'base', numeric: true }));

  const picked = await vscode.window.showQuickPick(
    items,
    {
      placeHolder: 'Select the solution (.sln) to discover tests from',
      matchOnDescription: true,
      matchOnDetail: true
    }
  );
  return picked?.fsPath;
}
