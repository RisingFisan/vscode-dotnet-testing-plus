import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parsePlaylist, PlaylistTest } from './playlistParser';
import { runPlaylistTests } from './testRunner';
import { SolutionCache } from './cache';
import { parseSolution } from './solutionParser';
import { resolveSolutionSilently, pickSolutionInteractively } from './solutionManager';
import { discoverSolutionTests, stripTestParameters } from './solutionDiscovery';
import { buildMethodIndex, SourceLocation } from './sourceScan';
import { buildTree, PLACEHOLDER_ID, NOT_FOUND_ID } from './testTree';
import { initLogger, showLog, log } from './logger';
import { MainViewProvider, MainViewAction } from './mainView';
import { TestFilter, parseTestFilter, filterEntries } from './testFilter';

const SOLUTION_PATH_KEY = 'dotnet-testing-plus.solutionPath';
const PLAYLIST_PATH_KEY = 'dotnet-testing-plus.playlistPath';
const READY_CONTEXT_KEY = 'dotnetTestingPlus.solutionReady';
const LOADING_CONTEXT_KEY = 'dotnetTestingPlus.solutionLoading';
const HAS_SOLUTION_CONTEXT_KEY = 'dotnetTestingPlus.hasSolution';

import { resolveRunsettingsPath, findDefaultRunsettings } from './runsettingsManager';

const RUNSETTINGS_PATH_KEY = 'dotnet-testing-plus.runsettingsPath';

let controller: vscode.TestController;
let cache: SolutionCache;
let extensionPath: string | undefined;
let mainView: MainViewProvider;

let solutionPath: string | undefined;
let knownTests: Set<string> | undefined;
let playlistPath: string | undefined;
let runsettingsPath: string | undefined;
let activeFilter: TestFilter | undefined;
let playlistEntries: PlaylistTest[] = [];
let playlistWatcher: fs.FSWatcher | undefined;
let reloadTimer: NodeJS.Timeout | undefined;
let discoveryCts: vscode.CancellationTokenSource | undefined;
let testLocations: Map<string, SourceLocation> = new Map();
let testProjects: Map<string, string> = new Map();

export function activate(context: vscode.ExtensionContext): void {
  initLogger();
  log('Extension activated (v1.8.1, solution-based discovery)');
  extensionPath = context.extensionPath;

  controller = vscode.tests.createTestController('dotnetTestingPlus', '.NET Testing+');
  context.subscriptions.push(controller);
  cache = new SolutionCache(context.globalStorageUri.fsPath);

  // The .NET Testing+ sub-tab is a webview hosting the filter input plus the
  // playlist/runsettings sections with their action buttons; the actual tests
  // live in the native Test Explorer tree (controller.items).
  mainView = new MainViewProvider(action => void handleViewAction(context, action));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dotnet-testing-plus.view', mainView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => runWithSolution(request, token, false),
      true
    ),
    controller.createRunProfile(
      'Debug',
      vscode.TestRunProfileKind.Debug,
      (request, token) => runWithSolution(request, token, true),
      true
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-testing-plus.selectSolution', () => chooseSolution(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.switchSolution', () => chooseSolution(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.stopLoading', () => stopLoading()),
    vscode.commands.registerCommand('dotnet-testing-plus.selectRunsettings', () => selectRunsettings(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.clearRunsettings', () => clearRunsettings(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.selectPlaylist', () => selectPlaylist(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.clearPlaylist', () => clearPlaylist(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.refresh', () => refresh()),
    vscode.commands.registerCommand('dotnet-testing-plus.showOutput', () => showLog()),
    vscode.commands.registerCommand('dotnet-testing-plus.runAll', () => runAllTests(false)),
    vscode.commands.registerCommand('dotnet-testing-plus.debugAll', () => runAllTests(true)),
    vscode.commands.registerCommand('dotnet-testing-plus.runTest', (arg) => runSingleTest(arg, false)),
    vscode.commands.registerCommand('dotnet-testing-plus.debugTest', (arg) => runSingleTest(arg, true)),
    vscode.commands.registerCommand('dotnet-testing-plus.goToTest', (location: SourceLocation | undefined) => {
      if (!location) {
        return;
      }
      void vscode.window.showTextDocument(vscode.Uri.file(location.file), {
        selection: new vscode.Range(location.line - 1, 0, location.line - 1, 0)
      });
    })
  );

  void updateContexts();
  void restoreState(context);

  // Reflect manual settings.json edits of the toggle in the webview.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dotnetTestingPlus.skipPreBreakpoint')) {
        updateViewState();
      }
    })
  );
}

export function deactivate(): void {
  playlistWatcher?.close();
  discoveryCts?.cancel();
}

async function runWithSolution(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  debug: boolean
): Promise<void> {
  if (!solutionPath) {
    vscode.window.showErrorMessage('No solution selected. Select a solution first.');
    return;
  }
  const resolved = resolveRunsettingsPath(solutionPath, runsettingsPath);
  if (resolved) {
    log(`Using runsettings: ${resolved}`);
  } else {
    log('No runsettings file found or selected');
  }
  const chunkSize = vscode.workspace
    .getConfiguration('dotnetTestingPlus')
    .get<number>('chunkSize', 100);
  await runPlaylistTests(controller, request, token, debug, solutionPath, {
    runsettingsPath: resolved,
    locations: testLocations,
    projects: testProjects,
    loggerDir: extensionPath ? path.join(extensionPath, 'assets', 'logger') : undefined,
    chunkSize,
    skipPreBreakpoint: vscode.workspace
      .getConfiguration('dotnetTestingPlus')
      .get<boolean>('skipPreBreakpoint', true)
  });
}

async function updateContexts(): Promise<void> {
  const loading = discoveryCts !== undefined;
  await vscode.commands.executeCommand('setContext', HAS_SOLUTION_CONTEXT_KEY, solutionPath !== undefined);
  await vscode.commands.executeCommand('setContext', LOADING_CONTEXT_KEY, loading);
  await vscode.commands.executeCommand('setContext', READY_CONTEXT_KEY, !loading && knownTests !== undefined);
  updateViewState();
}

function updateViewState(): void {
  const effective = runsettingsPath ?? (solutionPath ? findDefaultRunsettings(solutionPath) : undefined);
  mainView.setState({
    solutionReady: discoveryCts === undefined && knownTests !== undefined,
    playlistPath,
    runsettingsPath: effective,
    runsettingsIsDefault: runsettingsPath === undefined && effective !== undefined,
    hasExplicitRunsettings: runsettingsPath !== undefined,
    filter: activeFilter?.raw ?? '',
    skipPreBreakpoint: vscode.workspace
      .getConfiguration('dotnetTestingPlus')
      .get<boolean>('skipPreBreakpoint', true)
  });
}

async function handleViewAction(context: vscode.ExtensionContext, action: MainViewAction): Promise<void> {
  switch (action.type) {
    case 'selectPlaylist':
      await selectPlaylist(context);
      break;
    case 'clearPlaylist':
      await clearPlaylist(context);
      break;
    case 'selectRunsettings':
      await selectRunsettings(context);
      break;
    case 'clearRunsettings':
      await clearRunsettings(context);
      break;
    case 'filter':
      applyFilterInput(action.text);
      break;
    case 'toggleSkipPreBreakpoint':
      await vscode.workspace
        .getConfiguration('dotnetTestingPlus')
        .update('skipPreBreakpoint', action.checked, vscode.ConfigurationTarget.Global);
      log(`Skip pre-breakpoint ${action.checked ? 'enabled' : 'disabled'}`);
      updateViewState();
      break;
  }
}

function applyFilterInput(text: string): void {
  activeFilter = parseTestFilter(text);
  log(activeFilter ? `Test filter set: ${activeFilter.raw}` : 'Test filter cleared');
  if (knownTests) {
    rebuildTree();
  }
}

function showPlaceholder(message: string): void {
  controller.items.replace([controller.createTestItem(PLACEHOLDER_ID, message)]);
}

async function restoreState(context: vscode.ExtensionContext): Promise<void> {
  const savedSolution = context.workspaceState.get<string>(SOLUTION_PATH_KEY);
  if (savedSolution && fs.existsSync(savedSolution)) {
    log(`Restored solution from state: ${savedSolution}`);
    solutionPath = savedSolution;
  } else {
    solutionPath = await resolveSolutionSilently();
    if (solutionPath) {
      log(`Auto-detected solution: ${solutionPath}`);
      await context.workspaceState.update(SOLUTION_PATH_KEY, solutionPath);
    }
  }

  const savedPlaylist = context.workspaceState.get<string>(PLAYLIST_PATH_KEY);
  if (savedPlaylist && fs.existsSync(savedPlaylist)) {
    playlistPath = savedPlaylist;
  }

  // Only user-explicit runsettings selections are persisted; when none is
  // set, resolution falls back to the default next to the .sln at run time.
  const savedRunsettings = context.workspaceState.get<string>(RUNSETTINGS_PATH_KEY);
  if (savedRunsettings && fs.existsSync(savedRunsettings)) {
    runsettingsPath = savedRunsettings;
  }

  await updateContexts();

  if (solutionPath) {
    await discover(false);
  } else {
    log('No solution resolved; waiting for user to select one');
    showPlaceholder('No solution selected - use ".NET Testing+: Select Solution"');
  }
}

async function chooseSolution(context: vscode.ExtensionContext): Promise<void> {
  if (discoveryCts) {
    return;
  }
  const picked = await pickSolutionInteractively();
  if (!picked) {
    return;
  }
  solutionPath = picked;
  knownTests = undefined;
  playlistPath = undefined;
  playlistEntries = [];
  runsettingsPath = undefined;
  testLocations = new Map();
  testProjects = new Map();
  await context.workspaceState.update(SOLUTION_PATH_KEY, picked);
  await context.workspaceState.update(PLAYLIST_PATH_KEY, undefined);
  await context.workspaceState.update(RUNSETTINGS_PATH_KEY, undefined);
  log(`Solution selected: ${picked}`);
  const defaultRunsettings = findDefaultRunsettings(picked);
  if (defaultRunsettings) {
    log(`Will use default runsettings: ${defaultRunsettings}`);
  }
  await updateContexts();
  await discover(false);
}

function stopLoading(): void {
  log('Stop loading requested by user');
  discoveryCts?.cancel();
}

async function discover(force: boolean): Promise<void> {
  if (!solutionPath || discoveryCts) {
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  discoveryCts = cts;
  await updateContexts();

  try {
    let projectPaths: string[] = [];
    try {
      projectPaths = parseSolution(solutionPath).map(p => p.path);
    } catch (err) {
      log(`Could not parse solution for cache validation: ${err instanceof Error ? err.message : String(err)}`);
    }

    // The source scan is fast; always run it so file/line locations and
    // project ownership are available even when the test list comes from cache.
    const { methodIndex, locations, projects } = buildMethodIndex(projectPaths);
    testLocations = locations;
    testProjects = projects;
    log(`Source scan produced ${locations.size} test locations across ${new Set(projects.values()).size} projects`);

    const cached = force ? undefined : cache.get(solutionPath, projectPaths);
    if (cached !== undefined && cached.length > 0) {
      log(`Using cached test list for ${solutionPath} (${cached.length} tests)`);
      knownTests = new Set(cached);
    } else {
      showPlaceholder('Loading solution tests...');
      const discoveredNames = await vscode.window.withProgress(
        {
          location: { viewId: 'workbench.view.testing' },
          title: `Loading solution tests from ${solutionPath.split(/[\\/]/).pop()}...`,
          cancellable: true
        },
        (_progress, progressToken) => {
          progressToken.onCancellationRequested(() => cts.cancel());
          return discoverSolutionTests(solutionPath!, cts.token);
        }
      );
      // dotnet test --list-tests may only print bare method names
      // (Microsoft.Testing.Platform); map them to fully-qualified names via a
      // static source scan so playlist FQNs can be matched exactly.
      const tests = new Set<string>();
      let unmapped = 0;
      for (const name of discoveredNames) {
        const fqns = methodIndex.get(stripTestParameters(name));
        if (fqns && fqns.size > 0) {
          fqns.forEach(fqn => tests.add(fqn));
        } else {
          unmapped++;
          tests.add(name);
        }
      }
      log(`Mapped ${tests.size - unmapped} tests to fully-qualified names (${unmapped} unmapped)`);
      knownTests = tests;
      if (tests.size > 0) {
        cache.set(solutionPath, projectPaths, [...tests]);
        cache.save();
      } else {
        log('Discovery returned 0 tests; result will not be cached');
      }
    }

    if (playlistPath) {
      matchPlaylist();
    } else {
      showAllTests();
    }
  } catch (err) {
    knownTests = undefined;
    if (cts.token.isCancellationRequested) {
      log('Solution loading cancelled');
      showPlaceholder('Solution loading stopped - use "Switch Solution" to pick another or "Select Playlist" after reloading');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      log(`Discovery failed: ${message}`);
      showPlaceholder('Test discovery failed - check the output and switch solution to retry');
      const choice = await vscode.window.showErrorMessage(
        `Failed to discover tests: ${message}`,
        'Show Output'
      );
      if (choice === 'Show Output') {
        showLog();
      }
    }
  } finally {
    if (discoveryCts === cts) {
      discoveryCts = undefined;
    }
    cts.dispose();
    await updateContexts();
  }
}

function collectLeafItems(): vscode.TestItem[] {
  const leaves: vscode.TestItem[] = [];
  const walk = (item: vscode.TestItem): void => {
    if (item.id === PLACEHOLDER_ID || item.id === NOT_FOUND_ID || item.id.startsWith(`${NOT_FOUND_ID}:`)) {
      return;
    }
    if (item.children.size === 0) {
      leaves.push(item);
      return;
    }
    item.children.forEach(walk);
  };
  controller.items.forEach(walk);
  return leaves;
}

function findTestItem(id: string): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  const walk = (item: vscode.TestItem): void => {
    if (found) {
      return;
    }
    if (item.id === id) {
      found = item;
      return;
    }
    item.children.forEach(walk);
  };
  controller.items.forEach(walk);
  return found;
}

async function runAllTests(debug: boolean): Promise<void> {
  if (!solutionPath || !knownTests) {
    vscode.window.showInformationMessage('Discover tests from a solution first.');
    return;
  }
  const leaves = collectLeafItems();
  if (leaves.length === 0) {
    vscode.window.showInformationMessage('No playlist tests to run. Select a playlist first.');
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  try {
    await runWithSolution(new vscode.TestRunRequest(leaves), cts.token, debug);
  } finally {
    cts.dispose();
  }
}

async function runSingleTest(arg: unknown, debug: boolean): Promise<void> {
  const fqn = typeof arg === 'string' ? arg : (arg as { fqn?: string } | undefined)?.fqn;
  if (!fqn) {
    return;
  }
  const item = findTestItem(fqn);
  if (!item) {
    vscode.window.showWarningMessage(`Test not found in the test tree: ${fqn}`);
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  try {
    await runWithSolution(new vscode.TestRunRequest([item]), cts.token, debug);
  } finally {
    cts.dispose();
  }
}

async function selectPlaylist(context: vscode.ExtensionContext): Promise<void> {
  if (!knownTests) {
    vscode.window.showInformationMessage('Discover tests from a solution first.');
    return;
  }

  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    filters: { 'Visual Studio Test Playlist': ['playlist'] },
    title: 'Select a Visual Studio .playlist file'
  });
  if (!uris || uris.length === 0) {
    return;
  }

  playlistPath = uris[0].fsPath;
  await context.workspaceState.update(PLAYLIST_PATH_KEY, playlistPath);
  await updateContexts();
  watchPlaylistFile();
  matchPlaylist();
}

async function clearPlaylist(context: vscode.ExtensionContext): Promise<void> {
  playlistPath = undefined;
  playlistEntries = [];
  playlistWatcher?.close();
  playlistWatcher = undefined;
  await context.workspaceState.update(PLAYLIST_PATH_KEY, undefined);
  await updateContexts();
  if (knownTests) {
    showAllTests();
  } else {
    showPlaceholder('No playlist selected');
  }
}

async function refresh(): Promise<void> {
  if (!solutionPath) {
    vscode.window.showInformationMessage('No solution selected. Select a solution first.');
    return;
  }
  await discover(true);
}

async function selectRunsettings(context: vscode.ExtensionContext): Promise<void> {
  if (!solutionPath) {
    vscode.window.showInformationMessage('No solution selected. Select a solution first.');
    return;
  }

  const defaultUri = runsettingsPath
    ? vscode.Uri.file(path.dirname(runsettingsPath))
    : vscode.Uri.file(path.dirname(solutionPath));
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri,
    filters: { 'Test Run Settings': ['runsettings'] },
    title: 'Select a .runsettings file'
  });
  if (!uris || uris.length === 0) {
    return;
  }

  runsettingsPath = uris[0].fsPath;
  await context.workspaceState.update(RUNSETTINGS_PATH_KEY, runsettingsPath);
  await updateContexts();
  log(`Runsettings selected: ${runsettingsPath}`);
  vscode.window.showInformationMessage(`Runsettings: ${path.basename(runsettingsPath)}`);
}

async function clearRunsettings(context: vscode.ExtensionContext): Promise<void> {
  if (!solutionPath) {
    return;
  }
  runsettingsPath = undefined;
  await context.workspaceState.update(RUNSETTINGS_PATH_KEY, undefined);
  await updateContexts();
  const defaultRunsettings = findDefaultRunsettings(solutionPath);
  if (defaultRunsettings) {
    log(`Cleared custom runsettings; using default: ${defaultRunsettings}`);
    vscode.window.showInformationMessage(`Reverted to default runsettings: ${path.basename(defaultRunsettings)}`);
  } else {
    log('Cleared runsettings; no default found');
    vscode.window.showInformationMessage('No runsettings selected');
  }
}

function rebuildTree(): void {
  if (playlistPath) {
    matchPlaylist();
  } else {
    showAllTests();
  }
}

function watchPlaylistFile(): void {
  playlistWatcher?.close();
  if (!playlistPath) {
    return;
  }
  try {
    playlistWatcher = fs.watch(playlistPath, () => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
      reloadTimer = setTimeout(() => matchPlaylist(), 500);
    });
  } catch {
    // Watching is best-effort; the refresh command remains available.
  }
}

function matchPlaylist(): void {
  if (!playlistPath || !knownTests) {
    return;
  }

  try {
    playlistEntries = parsePlaylist(fs.readFileSync(playlistPath, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to parse playlist: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (playlistEntries.length === 0) {
    showPlaceholder('Playlist contains no tests');
    return;
  }

  buildTree(controller, playlistPath, filterEntries(playlistEntries, activeFilter), knownTests, testLocations);
}

function showAllTests(): void {
  if (!solutionPath || !knownTests) {
    showPlaceholder('No solution selected - use ".NET Testing+: Select Solution"');
    return;
  }

  let projectDirs: { name: string; dir: string }[] = [];
  try {
    projectDirs = parseSolution(solutionPath).map(p => ({
      name: path.basename(p.path, path.extname(p.path)),
      dir: path.dirname(path.normalize(p.path))
    }));
  } catch (err) {
    log(`Could not parse solution for project mapping: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries: PlaylistTest[] = [];
  for (const fqn of knownTests) {
    let testName = fqn;
    let className: string | undefined;
    let namespace: string | undefined;
    const lastDot = fqn.lastIndexOf('.');
    if (lastDot !== -1) {
      testName = fqn.slice(lastDot + 1);
      const rest = fqn.slice(0, lastDot);
      const classDot = rest.lastIndexOf('.');
      if (classDot === -1) {
        className = rest;
      } else {
        className = rest.slice(classDot + 1);
        namespace = rest.slice(0, classDot);
      }
    }

    let project: string | undefined;
    let bestDirLength = -1;
    const loc = testLocations.get(fqn);
    if (loc) {
      const fileDir = path.dirname(path.normalize(loc.file));
      for (const p of projectDirs) {
        const matches = fileDir === p.dir || fileDir.startsWith(p.dir + path.sep);
        if (matches && p.dir.length > bestDirLength) {
          bestDirLength = p.dir.length;
          project = p.name;
        }
      }
    }

    entries.push({ project, namespace, className, testName, fullyQualifiedName: fqn });
  }

  buildTree(controller, solutionPath, filterEntries(entries, activeFilter), knownTests, testLocations, { sourceLabel: 'solution' });
}
