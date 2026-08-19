import * as vscode from 'vscode';
import * as path from 'path';
import { PlaylistTest } from './playlistParser';
import { SourceLocation } from './sourceScan';

export const PROJECT_ITEM_PREFIX = 'proj:';
export const NOT_FOUND_ID = 'not-found';
export const PLACEHOLDER_ID = 'placeholder';

function projectLabelOf(entry: PlaylistTest): string {
  if (entry.project) {
    return entry.project;
  }
  if (entry.namespace) {
    return entry.namespace.split('.')[0];
  }
  return 'Playlist';
}

/**
 * Build the Testing-tab tree from the playlist entries that matched the
 * solution's known tests. Unmatched entries go into a "Not found" group.
 */
export function buildTree(
  controller: vscode.TestController,
  playlistPath: string,
  entries: PlaylistTest[],
  knownTests: ReadonlySet<string>,
  locations?: Map<string, SourceLocation>,
  options?: { sourceLabel?: string }
): void {
  const roots: vscode.TestItem[] = [];
  const projectItems = new Map<string, vscode.TestItem>();
  const matched = new Set<string>();

  for (const entry of entries) {
    if (!knownTests.has(entry.fullyQualifiedName)) {
      continue;
    }
    matched.add(entry.fullyQualifiedName);

    const label = projectLabelOf(entry);
    let projectItem = projectItems.get(label);
    if (!projectItem) {
      projectItem = controller.createTestItem(`${PROJECT_ITEM_PREFIX}${label}`, label);
      projectItems.set(label, projectItem);
      roots.push(projectItem);
    }

    const fqn = entry.fullyQualifiedName;
    const lastDot = fqn.lastIndexOf('.');
    const className = lastDot === -1 ? fqn : fqn.slice(0, lastDot);
    const testName = lastDot === -1 ? fqn : fqn.slice(lastDot + 1);
    let classItem = projectItem.children.get(`${projectItem.id}:${className}`);
    if (!classItem) {
      classItem = controller.createTestItem(`${projectItem.id}:${className}`, className);
      projectItem.children.add(classItem);
    }
    const loc = locations?.get(fqn);
    const item = controller.createTestItem(fqn, testName, loc ? vscode.Uri.file(loc.file) : undefined);
    if (loc) {
      item.range = new vscode.Range(loc.line - 1, 0, loc.line - 1, 0);
    }
    classItem.children.add(item);
  }

  const notFound = entries.filter(e => !matched.has(e.fullyQualifiedName));
  if (notFound.length > 0) {
    const group = controller.createTestItem(NOT_FOUND_ID, `Not found in solution (${notFound.length})`);
    for (const entry of notFound) {
      const item = controller.createTestItem(`${NOT_FOUND_ID}:${entry.fullyQualifiedName}`, entry.testName);
      item.description = entry.fullyQualifiedName;
      group.children.add(item);
    }
    roots.push(group);
  }

  for (const projectItem of projectItems.values()) {
    sortChildrenRecursively(projectItem);
  }
  roots.sort((a, b) => a.label.localeCompare(b.label));
  controller.items.replace(roots);

  if (options?.sourceLabel) {
    vscode.window.showInformationMessage(
      `Showing ${matched.size} test(s) from ${options.sourceLabel}.`
    );
  } else {
    vscode.window.showInformationMessage(
      `Playlist "${path.basename(playlistPath)}": ${matched.size} test(s) matched, ${notFound.length} not found in solution.`
    );
  }
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
