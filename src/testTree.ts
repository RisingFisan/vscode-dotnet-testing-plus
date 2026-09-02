import * as vscode from 'vscode';
import * as path from 'path';
import { PlaylistTest } from './playlistParser';
import { SourceLocation } from './sourceScan';

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
