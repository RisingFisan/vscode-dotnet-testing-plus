import * as vscode from 'vscode';
import * as path from 'path';
import { PlaylistTest } from './playlistParser';
import { SourceLocation } from './sourceScan';
import { TestResultState } from './testResultFilter';

export const PLACEHOLDER_ID = 'placeholder';

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function solutionItemId(solutionPath: string): string {
  return `solution:${keyPart(solutionPath)}`;
}

export function testItemId(solutionPath: string, fullyQualifiedName: string): string {
  return `test:${keyPart(solutionPath)}:${keyPart(fullyQualifiedName)}`;
}

function projectLabelOf(entry: PlaylistTest): string {
  if (entry.project) {
    return entry.project;
  }
  if (entry.namespace) {
    return entry.namespace.split('.')[0];
  }
  return 'Playlist';
}

function solutionLabel(solutionPath: string): string {
  return path.basename(solutionPath, path.extname(solutionPath));
}

export interface SolutionTreeOptions {
  locations?: Map<string, SourceLocation>;
  projects?: Map<string, string>;
  testResultStates?: ReadonlyMap<string, TestResultState>;
}

export function formatGroupLabel(baseLabel: string, passed: number, total: number): string {
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
      const fqn = fqnFromTestItemId(item.id);
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
    item.label = formatGroupLabel(base, groupPassed, groupTotal);

    return { passed: groupPassed, total: groupTotal };
  }

  computeGroup(root);
}

/**
 * Updates group labels from the test item up through all of its ancestors (class, project, solution root).
 * Skips counting tests with 'skipped' state.
 */
export function updateAncestorGroupLabels(test: vscode.TestItem, testResultStates: ReadonlyMap<string, TestResultState>): void {
  let current = test.parent;
  while (current) {
    updateSingleGroupLabel(current, testResultStates);
    current = current.parent;
  }
}

function countGroupTests(group: vscode.TestItem, testResultStates: ReadonlyMap<string, TestResultState>): { passed: number; total: number } {
  let passed = 0;
  let total = 0;

  function walk(item: vscode.TestItem): void {
    if (item.children.size === 0) {
      const fqn = fqnFromTestItemId(item.id);
      const state = (fqn ? testResultStates.get(fqn) : undefined) ?? 'notRun';
      if (state !== 'skipped') {
        total += 1;
        if (state === 'passed') {
          passed += 1;
        }
      }
      return;
    }
    item.children.forEach(child => walk(child));
  }

  walk(group);
  return { passed, total };
}

export function updateSingleGroupLabel(group: vscode.TestItem, testResultStates: ReadonlyMap<string, TestResultState>): void {
  const counts = countGroupTests(group, testResultStates);
  const base = group.sortText ?? group.label;
  group.sortText = base;
  group.label = formatGroupLabel(base, counts.passed, counts.total);
}

function fqnFromTestItemId(id: string): string | undefined {
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
    // Playlist Project metadata can be a common product name rather than the
    // actual test project. The source scan identifies the owning .csproj.
    const label = projectPath
      ? path.basename(projectPath, path.extname(projectPath))
      : projectLabelOf(entry);
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
    const classLabel = className.startsWith(`${label}.`) ? className.slice(label.length + 1) : className;
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
  sorted.sort((a, b) => a.label.localeCompare(b.label));
  item.children.replace(sorted);
  for (const child of sorted) {
    if (child.children.size > 0) {
      sortChildrenRecursively(child);
    }
  }
}
