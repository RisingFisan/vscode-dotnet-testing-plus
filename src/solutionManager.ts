import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findAllSolutionFiles, findRootSolutionFiles } from './solutionParser';
import { log } from './logger';

const CS_DEVKIT_ID = 'ms-dotnettools.csdevkit';

function isUsableSolutionPath(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate.toLowerCase().endsWith('.sln') &&
    fs.existsSync(candidate)
  );
}

/**
 * Best-effort attempt to read the solution currently opened by C# Dev Kit.
 * Dev Kit exposes no public API for this, so we probe its exports for an
 * environment-state-like object. Any failure is non-fatal.
 */
export async function detectDevKitSolution(): Promise<string | undefined> {
  const extension = vscode.extensions.getExtension(CS_DEVKIT_ID);
  if (!extension) {
    log('C# Dev Kit not installed; skipping solution detection');
    return undefined;
  }

  try {
    if (!extension.isActive) {
      await extension.activate();
    }
    const exports = extension.exports as Record<string, unknown> | undefined;
    if (!exports) {
      log('C# Dev Kit exposes no exports; cannot read its solution');
      return undefined;
    }

    const candidates: unknown[] = [];
    const environmentStateManager = exports['environmentStateManager'] as
      | Record<string, unknown>
      | undefined;
    if (environmentStateManager && typeof environmentStateManager['getOpenedSolution'] === 'function') {
      candidates.push(
        (environmentStateManager['getOpenedSolution'] as () => unknown).call(environmentStateManager)
      );
    }
    for (const key of ['getOpenedSolution', 'getCurrentSolution', 'solutionPath', 'openedSolution']) {
      const value = exports[key];
      candidates.push(typeof value === 'function' ? (value as () => unknown)() : value);
    }

    for (const candidate of candidates) {
      if (isUsableSolutionPath(candidate)) {
        log(`C# Dev Kit solution detected: ${candidate}`);
        return candidate;
      }
    }
    log('C# Dev Kit solution path not readable from its exports');
  } catch (err) {
    log(`C# Dev Kit solution detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

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
 * Silent resolution chain: C# Dev Kit -> root-level .sln. Never prompts.
 */
export async function resolveSolutionSilently(): Promise<string | undefined> {
  return (await detectDevKitSolution()) ?? detectRootSolution();
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
