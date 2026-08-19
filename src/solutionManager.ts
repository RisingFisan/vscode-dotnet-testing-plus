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

  const picked = await vscode.window.showQuickPick(
    solutions.map(u => ({
      label: path.basename(u.fsPath),
      detail: u.fsPath
    })),
    { placeHolder: 'Select the solution (.sln) to discover tests from' }
  );
  return picked?.detail;
}
