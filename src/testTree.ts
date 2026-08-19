import * as vscode from 'vscode';
import * as path from 'path';
import { PlaylistTest } from './playlistParser';
import { SourceLocation } from './sourceScan';

export const PROJECT_ITEM_PREFIX = 'proj:';
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
 * solution's known tests. Unmatched entries are reported separately by the
 * main view because every TestItem inherits the controller's run actions.
 */
export function buildTree(
  controller: vscode.TestController,
  playlistPath: string,
  entries: PlaylistTest[],
  knownTests: ReadonlySet<string>,
  locations?: Map<string, SourceLocation>,
  options?: { sourceLabel?: string; silent?: boolean }
): void {
  const roots: vscode.TestItem[] = [];
  const projectItems = new Map<string, vscode.TestItem>();
  const matched = new Set<string>();
  const notFoundCount = entries.filter(entry => !knownTests.has(entry.fullyQualifiedName)).length;

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

  for (const projectItem of projectItems.values()) {
    sortChildrenRecursively(projectItem);
  }
  roots.sort((a, b) => a.label.localeCompare(b.label));
  controller.items.replace(roots);

  if (options?.silent) {
    return;
  }
  if (options?.sourceLabel) {
    vscode.window.showInformationMessage(
      `Showing ${matched.size} test(s) from ${options.sourceLabel}.`
    );
  } else {
    vscode.window.showInformationMessage(
      `Playlist "${path.basename(playlistPath)}": ${matched.size} test(s) matched, ${notFoundCount} not found in solution.`
    );
  }
}

/**
 * Prune the existing tree in place, keeping only leaf tests whose id (FQN) is
 * in `keep` and dropping class/project nodes that become empty. Used when a
 * playlist is loaded so the project grouping of the full tree is preserved
 * and surviving items keep their run state.
 */
export function filterTree(controller: vscode.TestController, keep: ReadonlySet<string>): void {
  const roots: vscode.TestItem[] = [];
  controller.items.forEach(projectItem => {
    const keptClasses: vscode.TestItem[] = [];
    projectItem.children.forEach(classItem => {
      const keptLeaves: vscode.TestItem[] = [];
      classItem.children.forEach(leaf => {
        if (keep.has(leaf.id)) {
          keptLeaves.push(leaf);
        }
      });
      classItem.children.replace(keptLeaves);
      if (keptLeaves.length > 0) {
        keptClasses.push(classItem);
      }
    });
    projectItem.children.replace(keptClasses);
    if (keptClasses.length > 0) {
      roots.push(projectItem);
    }
  });
  controller.items.replace(roots);
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
