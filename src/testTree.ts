import * as vscode from 'vscode';
import * as path from 'path';
import { PlaylistTest } from './playlistParser';
import { compareText } from './collation';
import { SourceLocation } from './sourceScan';
import { TestResultState } from './testResultFilter';

const PLACEHOLDER_ID = 'placeholder';

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function solutionItemId(solutionPath: string): string {
  return `solution:${keyPart(solutionPath)}`;
}

export function testItemId(solutionPath: string, fullyQualifiedName: string): string {
  return `test:${keyPart(solutionPath)}:${keyPart(fullyQualifiedName)}`;
}

// Label helpers are shared with the screenshot snapshot (screenshot.ts) so
// the tree and its screenshot can never disagree on labels.

function playlistProjectLabel(entry: PlaylistTest): string {
  if (entry.project) {
    return entry.project;
  }
  if (entry.namespace) {
    return entry.namespace.split('.')[0];
  }
  return 'Playlist';
}

/**
 * Project label for a playlist entry, preferring the owning .csproj from the
 * source scan over playlist Project/namespace metadata (playlist Project can
 * be a common product name rather than the actual test project).
 */
export function projectLabel(entry: PlaylistTest, projectPath?: string): string {
  return projectPath
    ? path.basename(projectPath, path.extname(projectPath))
    : playlistProjectLabel(entry);
}

export function solutionLabel(solutionPath: string): string {
  return path.basename(solutionPath, path.extname(solutionPath));
}

/** Class portion of a test FQN (everything before the final dot). */
function classNameOf(fqn: string): string {
  const lastDot = fqn.lastIndexOf('.');
  return lastDot === -1 ? fqn : fqn.slice(0, lastDot);
}

/** Class label: the class name with the project-label prefix stripped when present. */
export function classLabelOf(fqn: string, project: string): string {
  const className = classNameOf(fqn);
  return className.startsWith(`${project}.`) ? className.slice(project.length + 1) : className;
}

export interface SolutionTreeOptions {
  locations?: Map<string, SourceLocation>;
  projects?: Map<string, string>;
  testResultStates?: ReadonlyMap<string, TestResultState>;
}

function formatGroupLabel(baseLabel: string, passed: number, total: number): string {
  return `${baseLabel} (${passed}/${total})`;
}

/**
 * Recalculates and updates labels on all ancestor group nodes of the given test item.
 * Skips counting tests with 'skipped' state.
 */
export function updateGroupLabels(root: vscode.TestItem, testResultStates: ReadonlyMap<string, TestResultState>): void {
  function computeGroup(item: vscode.TestItem): { passed: number; total: number } {
    if (item.children.size === 0) {
      // Leaf test item
      const fqn = fqnOfItem(item);
      const state = (fqn ? testResultStates.get(fqn) : undefined) ?? 'notRun';
      if (state === 'skipped') {
        return { passed: 0, total: 0 };
      }
      return { passed: state === 'passed' ? 1 : 0, total: 1 };
    }

    let groupPassed = 0;
    let groupTotal = 0;
    item.children.forEach(child => {
      const childCounts = computeGroup(child);
      groupPassed += childCounts.passed;
      groupTotal += childCounts.total;
    });

    const base = item.sortText ?? item.label;
    item.sortText = base;
    const label = formatGroupLabel(base, groupPassed, groupTotal);
    if (item.label !== label) {
      item.label = label;
    }

    return { passed: groupPassed, total: groupTotal };
  }

  computeGroup(root);
}

// Decoding an id (split + decodeURIComponent) per leaf per label pass is the
// hot spot of group-label updates; an item's id never changes, so memoize it.
const fqnByItem = new WeakMap<vscode.TestItem, string | undefined>();

function fqnOfItem(item: vscode.TestItem): string | undefined {
  if (fqnByItem.has(item)) {
    return fqnByItem.get(item);
  }
  const fqn = fqnFromTestItemId(item.id);
  fqnByItem.set(item, fqn);
  return fqn;
}

export function fqnFromTestItemId(id: string): string | undefined {
  if (!id.startsWith('test:')) {
    return undefined;
  }
  const parts = id.split(':');
  if (parts.length < 3) {
    return undefined;
  }
  return decodeURIComponent(parts.slice(2).join(':'));
}

/**
 * Create one solution root for the shared TestController. Every item ID is
 * scoped by the absolute solution path so identical FQNs in loaded solutions
 * can coexist and be routed back to the right dotnet invocation.
 */
export function buildSolutionTree(
  controller: vscode.TestController,
  solutionPath: string,
  entries: PlaylistTest[],
  knownTests: ReadonlySet<string>,
  options?: SolutionTreeOptions
): vscode.TestItem {
  const root = controller.createTestItem(solutionItemId(solutionPath), solutionLabel(solutionPath));
  root.description = path.dirname(solutionPath);
  const projectItems = new Map<string, vscode.TestItem>();

  for (const entry of entries) {
    if (!knownTests.has(entry.fullyQualifiedName)) {
      continue;
    }
    const projectPath = options?.projects?.get(entry.fullyQualifiedName);
    const label = projectLabel(entry, projectPath);
    const projectId = `${root.id}:project:${keyPart(projectPath ?? label)}`;
    let projectItem = projectItems.get(projectId);
    if (!projectItem) {
      projectItem = controller.createTestItem(projectId, label);
      projectItems.set(projectId, projectItem);
      root.children.add(projectItem);
    }

    const fqn = entry.fullyQualifiedName;
    const lastDot = fqn.lastIndexOf('.');
    const className = lastDot === -1 ? fqn : fqn.slice(0, lastDot);
    const classLabel = classLabelOf(fqn, label);
    const testName = lastDot === -1 ? fqn : fqn.slice(lastDot + 1);
    const classId = `${projectItem.id}:class:${keyPart(className)}`;
    let classItem = projectItem.children.get(classId);
    if (!classItem) {
      classItem = controller.createTestItem(classId, classLabel);
      projectItem.children.add(classItem);
    }
    const loc = options?.locations?.get(fqn);
    const item = controller.createTestItem(testItemId(solutionPath, fqn), testName, loc ? vscode.Uri.file(loc.file) : undefined);
    if (loc) {
      item.range = new vscode.Range(loc.line - 1, 0, loc.line - 1, 0);
    }
    classItem.children.add(item);
  }

  sortChildrenRecursively(root);
  updateGroupLabels(root, options?.testResultStates ?? new Map());
  return root;
}

export function buildSolutionPlaceholder(
  controller: vscode.TestController,
  solutionPath: string,
  message: string
): vscode.TestItem {
  const root = controller.createTestItem(solutionItemId(solutionPath), solutionLabel(solutionPath));
  root.description = path.dirname(solutionPath);
  root.children.add(controller.createTestItem(`${root.id}:${PLACEHOLDER_ID}`, message));
  return root;
}

function sortChildrenRecursively(item: vscode.TestItem): void {
  const sorted: vscode.TestItem[] = [];
  item.children.forEach(child => sorted.push(child));
  sorted.sort((a, b) => compareText(a.label, b.label));
  item.children.replace(sorted);
  for (const child of sorted) {
    if (child.children.size > 0) {
      sortChildrenRecursively(child);
    }
  }
}
