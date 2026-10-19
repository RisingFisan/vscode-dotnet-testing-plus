import * as vscode from 'vscode';
import { fqnFromTestItemId } from './testTree';

export interface CodeLensSession {
  key: string;
  solutionPath: string;
  treeRoot?: vscode.TestItem;
}

export interface CodeLensHandle extends vscode.Disposable {
  /** Signal that tree contents changed and lenses should be re-evaluated. */
  notify(): void;
}

interface LocatedTest {
  item: vscode.TestItem;
  fqn: string;
}

/**
 * CodeLens ("Run Test" / "Debug Test") above every test method that is
 * currently visible in a session's (possibly pruned) tree. Because lenses are
 * derived from the tree itself, tests hidden by a playlist, text filter or
 * result filter have no lens, matching how the Test Explorer behaves.
 */
export function registerCodeLenses(getSessions: () => Iterable<CodeLensSession>): CodeLensHandle {
  const emitter = new vscode.EventEmitter<void>();
  // Lenses are requested per open document and re-requested on editor
  // changes, while the tree only changes on notify: index each session tree
  // per file lazily and drop the whole index when the tree changes.
  let indexByRoot: WeakMap<vscode.TestItem, Map<string, LocatedTest[]>> | undefined;

  const locatedTests = (root: vscode.TestItem, fsPath: string): LocatedTest[] => {
    if (!indexByRoot) {
      indexByRoot = new WeakMap<vscode.TestItem, Map<string, LocatedTest[]>>();
    }
    const byRoot = indexByRoot;
    let byFile = byRoot.get(root);
    if (!byFile) {
      byFile = new Map<string, LocatedTest[]>();
      byRoot.set(root, byFile);
    }
    const cached = byFile.get(fsPath);
    if (cached) {
      return cached;
    }
    const found = findTestsInDocument(root, fsPath);
    byFile.set(fsPath, found);
    return found;
  };

  const provider = vscode.languages.registerCodeLensProvider('csharp', {
    onDidChangeCodeLenses: emitter.event,
    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
      const lenses: vscode.CodeLens[] = [];
      for (const session of getSessions()) {
        if (token.isCancellationRequested) {
          return [];
        }
        if (!session.treeRoot) {
          continue;
        }
        for (const { item, fqn } of locatedTests(session.treeRoot, document.uri.fsPath)) {
          const range = item.range ?? new vscode.Range(0, 0, 0, 0);
          lenses.push(makeLens(range, session.key, fqn, false));
          lenses.push(makeLens(range, session.key, fqn, true));
        }
      }
      return lenses;
    }
  });
  return {
    notify: (): void => {
      indexByRoot = undefined;
      emitter.fire();
    },
    dispose: (): void => {
      provider.dispose();
      emitter.dispose();
    }
  };
}

function isSameFilePath(a: string | undefined, b: string): boolean {
  if (!a) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

function findTestsInDocument(root: vscode.TestItem, fsPath: string): LocatedTest[] {
  const found: LocatedTest[] = [];
  const walk = (item: vscode.TestItem): void => {
    if (item.children.size > 0) {
      item.children.forEach(walk);
      return;
    }
    // Compare the file first: decoding an id is far costlier than a path check,
    // and almost every leaf lives in some other document.
    if (!isSameFilePath(item.uri?.fsPath, fsPath)) {
      return;
    }
    const fqn = fqnFromTestItemId(item.id);
    if (fqn) {
      found.push({ item, fqn });
    }
  };
  walk(root);
  return found;
}

function makeLens(range: vscode.Range, sessionKey: string, fqn: string, debug: boolean): vscode.CodeLens {
  return new vscode.CodeLens(range, {
    title: debug ? 'Debug Test' : 'Run Test',
    command: debug ? 'dotnet-testing-plus.debugTestFromCodeLens' : 'dotnet-testing-plus.runTestFromCodeLens',
    arguments: [sessionKey, fqn]
  });
}
