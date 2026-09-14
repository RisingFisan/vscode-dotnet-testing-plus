import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parsePlaylist, serializePlaylist, expandPlaylist, entryFromKnownTestFqn, ParsedPlaylist, PlaylistSaveFormat, PlaylistTest } from './playlistParser';
import { runPlaylistTests, SolutionRunOptions, TestDescriptor } from './testRunner';
import { SolutionCache } from './cache';
import { parseSolution } from './solutionParser';
import { resolveSolutionSilently, pickSolutionInteractively } from './solutionManager';
import { discoverSolutionTests, stripTestParameters } from './solutionDiscovery';
import { buildMethodIndex, SourceLocation } from './sourceScan';
import { buildSolutionPlaceholder, buildSolutionTree, testItemId, updateAncestorGroupLabels } from './testTree';
import { initLogger, showLog, log, recentLogLines } from './logger';
import { startControlApi, ControlApiError, ControlApiHandlers, ControlApiRunOptions, ControlApiRunResult, ControlApiState, ControlApiTest } from './controlApi';
import { MainViewProvider, MainViewAction, RunsettingsMode, ScreenshotExportSettings } from './mainView';
import { TestFilter, parseTestFilter, filterEntries } from './testFilter';
import { TestResultFilter, TestResultFilterKey, TestResultState, createDefaultTestResultFilter, isTestResultVisible } from './testResultFilter';
import { buildScreenshotSnapshot, ScreenshotOptions } from './screenshot';
import { installAgentSkill } from './skillInstaller';
import {
  findDefaultRunsettings,
  hasCustomRunsettings,
  inspectRunsettings,
  materializeRunsettings,
  normalizeCustomRunsettingsState,
  validateCustomParameterName,
  CustomRunsettingsState,
  CustomRunsettingsViewState
} from './runsettingsManager';

const SESSIONS_KEY = 'dotnet-testing-plus.sessions';
const ACTIVE_SESSION_KEY = 'dotnet-testing-plus.activeSession';
// Read these once for migration from the previous single-solution release.
const LEGACY_SOLUTION_PATH_KEY = 'dotnet-testing-plus.solutionPath';
const LEGACY_PLAYLIST_PATH_KEY = 'dotnet-testing-plus.playlistPath';
const LEGACY_RUNSETTINGS_PATH_KEY = 'dotnet-testing-plus.runsettingsPath';
const LEGACY_RUNSETTINGS_MODE_KEY = 'dotnet-testing-plus.runsettingsMode';
const LEGACY_CUSTOM_RUNSETTINGS_KEY = 'dotnet-testing-plus.customRunsettings';
const READY_CONTEXT_KEY = 'dotnetTestingPlus.solutionReady';
const LOADING_CONTEXT_KEY = 'dotnetTestingPlus.solutionLoading';
const HAS_SOLUTION_CONTEXT_KEY = 'dotnetTestingPlus.hasSolution';

interface PersistedSession {
  solutionPath: string;
  playlistPath?: string;
  runsettingsPath?: string;
  runsettingsMode?: RunsettingsMode;
  customRunsettings?: unknown;
}

interface PlaylistExpansionCache {
  knownTests?: ReadonlySet<string>;
  entries: PlaylistTest[];
  notFound: string[];
}

interface SolutionSession {
  key: string;
  solutionPath: string;
  knownTests?: Set<string>;
  playlistPath?: string;
  playlist?: ParsedPlaylist;
  playlistExpansion?: PlaylistExpansionCache;
  runsettingsPath?: string;
  runsettingsMode: RunsettingsMode;
  customRunsettings: CustomRunsettingsState;
  activeFilter?: TestFilter;
  testResultFilter: TestResultFilter;
  testResultStates: Map<string, TestResultState>;
  testDurations: Map<string, number>;
  discoveryCts?: vscode.CancellationTokenSource;
  testLocations: Map<string, SourceLocation>;
  testProjects: Map<string, string>;
  notFoundTests: string[];
  message?: string;
  playlistWatcher?: fs.FSWatcher;
  playlistReloadTimer?: NodeJS.Timeout;
  runsettingsWatcher?: fs.FSWatcher;
  runsettingsReloadTimer?: NodeJS.Timeout;
  treeRoot?: vscode.TestItem;
  treeDirty: boolean;
}

let controller: vscode.TestController;
let cache: SolutionCache;
let extensionPath: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let mainView: MainViewProvider;
const sessions = new Map<string, SolutionSession>();
let activeSessionKey: string | undefined;
let searchAllSolutions = false;
let activeRunCts: vscode.CancellationTokenSource | undefined;
let controlApi: vscode.Disposable | undefined;
let controlApiRunningPort: number | undefined;
let controlApiSessionEnabled = false;

export function activate(context: vscode.ExtensionContext): void {
  initLogger();
  log('Extension activated (v1.17.7, multi-solution discovery)');
  extensionContext = context;
  extensionPath = context.extensionPath;
  controller = vscode.tests.createTestController('dotnetTestingPlus', '.NET Testing+');
  cache = new SolutionCache(context.globalStorageUri.fsPath);
  context.subscriptions.push(controller);

  mainView = new MainViewProvider(action => void handleViewAction(context, action));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dotnet-testing-plus.view', mainView, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => runWithSolutions(request, token, false), true),
    controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => runWithSolutions(request, token, true), true),
    vscode.commands.registerCommand('dotnet-testing-plus.addSolution', () => addSolution(context)),
    vscode.commands.registerCommand('dotnet-testing-plus.removeSolution', async () => {
      const session = await pickLoadedSession('Select a solution to unload');
      if (session) {
        await removeSolution(context, session.key);
      }
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.stopLoading', async () => {
      const session = await pickLoadedSession('Select a solution to stop loading', item => item.discoveryCts !== undefined);
      session?.discoveryCts?.cancel();
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.selectRunsettings', async () => {
      const session = await pickLoadedSession('Select a solution for runsettings');
      if (session) {
        await selectRunsettings(context, session);
      }
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.clearRunsettings', async () => {
      const session = await pickLoadedSession('Select a solution to clear runsettings');
      if (session) {
        await clearRunsettings(context, session);
      }
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.selectPlaylist', async () => {
      const session = await pickLoadedSession('Select a solution for a playlist');
      if (session) {
        await selectPlaylist(context, session);
      }
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.clearPlaylist', async () => {
      const session = await pickLoadedSession('Select a solution to clear its playlist');
      if (session) {
        await clearPlaylist(context, session);
      }
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.refresh', async () => {
      const session = await pickLoadedSession('Select a solution to refresh');
      if (session) {
        await refreshSolution(session);
      }
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.showOutput', () => showLog()),
    vscode.commands.registerCommand('dotnet-testing-plus.runAll', () => runAllTests(false)),
    vscode.commands.registerCommand('dotnet-testing-plus.debugAll', () => runAllTests(true)),
    vscode.commands.registerCommand('dotnet-testing-plus.installAgentSkill', () => installAgentSkill(extensionPath)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dotnetTestingPlus.skipPreBreakpoint')) {
        void updateContexts();
      }
      if (
        e.affectsConfiguration('dotnetTestingPlus.controlApiEnabled') ||
        e.affectsConfiguration('dotnetTestingPlus.controlApiPort') ||
        e.affectsConfiguration('dotnetTestingPlus.controlApiToken')
      ) {
        syncControlApi(context);
      }
    }),
    new vscode.Disposable(() => controlApi?.dispose())
  );

  syncControlApi(context);
  void restoreState(context);
}

export function deactivate(): void {
  for (const session of sessions.values()) {
    disposeSession(session);
  }
}

function canonicalPath(file: string): string {
  return path.resolve(file);
}

function createSession(saved: PersistedSession): SolutionSession {
  const solutionPath = canonicalPath(saved.solutionPath);
  const customRunsettings = normalizeCustomRunsettingsState(saved.customRunsettings);
  const runsettingsPath = saved.runsettingsPath && fs.existsSync(saved.runsettingsPath)
    ? saved.runsettingsPath
    : undefined;
  const savedMode = normalizeRunsettingsMode(saved.runsettingsMode);
  let runsettingsMode = savedMode
    ?? (runsettingsPath ? 'custom' : hasCustomRunsettings(customRunsettings) ? 'override' : 'default');
  if (runsettingsMode !== 'custom' && !findDefaultRunsettings(solutionPath)) {
    runsettingsMode = 'custom';
  }
  if (runsettingsMode === 'override') {
    customRunsettings.sourcePath = findDefaultRunsettings(solutionPath);
  }
  return {
    key: solutionPath,
    solutionPath,
    playlistPath: saved.playlistPath && fs.existsSync(saved.playlistPath) ? saved.playlistPath : undefined,
    runsettingsPath,
    runsettingsMode,
    customRunsettings,
    testResultFilter: createDefaultTestResultFilter(),
    testResultStates: new Map(),
    testDurations: new Map(),
    testLocations: new Map(),
    testProjects: new Map(),
    notFoundTests: [],
    treeDirty: true
  };
}

function activeSession(): SolutionSession | undefined {
  return activeSessionKey ? sessions.get(activeSessionKey) : undefined;
}

async function pickLoadedSession(
  placeHolder: string,
  predicate: (session: SolutionSession) => boolean = () => true
): Promise<SolutionSession | undefined> {
  const candidates = [...sessions.values()].filter(predicate);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage('No matching loaded solution is available.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map(session => ({
      label: path.basename(session.solutionPath, path.extname(session.solutionPath)),
      detail: session.solutionPath,
      session
    })),
    { placeHolder }
  );
  return picked?.session;
}

function disposeSession(session: SolutionSession): void {
  session.discoveryCts?.cancel();
  session.playlistWatcher?.close();
  session.runsettingsWatcher?.close();
  if (session.playlistReloadTimer) {
    clearTimeout(session.playlistReloadTimer);
  }
  if (session.runsettingsReloadTimer) {
    clearTimeout(session.runsettingsReloadTimer);
  }
}

function persistedSessions(): PersistedSession[] {
  return [...sessions.values()].map(session => ({
    solutionPath: session.solutionPath,
    playlistPath: session.playlistPath,
    runsettingsPath: session.runsettingsPath,
    runsettingsMode: session.runsettingsMode,
    customRunsettings: session.customRunsettings
  }));
}

async function saveSessions(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(SESSIONS_KEY, persistedSessions());
  await context.workspaceState.update(ACTIVE_SESSION_KEY, activeSessionKey);
}

async function restoreState(context: vscode.ExtensionContext): Promise<void> {
  const saved = context.workspaceState.get<unknown>(SESSIONS_KEY);
  const restored = Array.isArray(saved)
    ? saved.filter((entry): entry is PersistedSession => isPersistedSession(entry) && fs.existsSync(entry.solutionPath))
    : [];
  if (restored.length === 0) {
    const legacy = createLegacySession(context);
    if (legacy) {
      restored.push(legacy);
    } else {
      const detected = await resolveSolutionSilently();
      if (detected) {
        restored.push({ solutionPath: detected });
      }
    }
  }
  for (const savedSession of restored) {
    const session = createSession(savedSession);
    sessions.set(session.key, session);
    watchRunsettingsFile(session);
    if (session.playlistPath) {
      watchPlaylistFile(session);
    }
  }
  const savedActive = context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
  activeSessionKey = savedActive && sessions.has(savedActive) ? savedActive : sessions.keys().next().value;
  await saveSessions(context);
  renderTree();
  await updateContexts();
  for (const session of sessions.values()) {
    void discover(session, false);
  }
}

function isPersistedSession(value: unknown): value is PersistedSession {
  return !!value && typeof value === 'object' && typeof (value as PersistedSession).solutionPath === 'string';
}

function createLegacySession(context: vscode.ExtensionContext): PersistedSession | undefined {
  const solutionPath = context.workspaceState.get<string>(LEGACY_SOLUTION_PATH_KEY);
  if (!solutionPath || !fs.existsSync(solutionPath)) {
    return undefined;
  }
  return {
    solutionPath,
    playlistPath: context.workspaceState.get<string>(LEGACY_PLAYLIST_PATH_KEY),
    runsettingsPath: context.workspaceState.get<string>(LEGACY_RUNSETTINGS_PATH_KEY),
    runsettingsMode: normalizeRunsettingsMode(context.workspaceState.get<unknown>(LEGACY_RUNSETTINGS_MODE_KEY)),
    customRunsettings: context.workspaceState.get<unknown>(LEGACY_CUSTOM_RUNSETTINGS_KEY)
  };
}

async function addSolution(context: vscode.ExtensionContext): Promise<void> {
  const picked = await pickSolutionInteractively();
  if (!picked) {
    return;
  }
  const key = canonicalPath(picked);
  const existing = sessions.get(key);
  if (existing) {
    activeSessionKey = existing.key;
    await saveSessions(context);
    await updateContexts();
    return;
  }
  const session = createSession({ solutionPath: key });
  const currentFilter = activeSession()?.activeFilter;
  sessions.set(session.key, session);
  activeSessionKey = session.key;
  if (searchAllSolutions && currentFilter) {
    session.activeFilter = currentFilter;
  }
  watchRunsettingsFile(session);
  await saveSessions(context);
  renderTree();
  await updateContexts();
  void discover(session, false);
}

async function removeSolution(context: vscode.ExtensionContext, key?: string): Promise<void> {
  const session = key ? sessions.get(key) : activeSession();
  if (!session) {
    return;
  }
  disposeSession(session);
  sessions.delete(session.key);
  if (sessions.size <= 1) {
    searchAllSolutions = false;
  }
  if (activeSessionKey === session.key) {
    activeSessionKey = sessions.keys().next().value;
  }
  await saveSessions(context);
  renderTree();
  await updateContexts();
}

async function selectSession(context: vscode.ExtensionContext, key: string): Promise<void> {
  if (!sessions.has(key) || key === activeSessionKey) {
    return;
  }
  const previousSession = activeSession();
  activeSessionKey = key;
  if (searchAllSolutions && previousSession?.activeFilter) {
    const current = activeSession();
    if (current && !current.activeFilter) {
      current.activeFilter = previousSession.activeFilter;
      current.treeDirty = true;
      renderTree();
    }
  }
  await saveSessions(context);
  await updateContexts();
}

async function discover(session: SolutionSession, force: boolean): Promise<void> {
  if (session.discoveryCts) {
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  session.discoveryCts = cts;
  session.message = 'Loading solution tests...';
  session.treeDirty = true;
  renderTree();
  await updateContexts();
  try {
    let projectPaths: string[] = [];
    try {
      projectPaths = parseSolution(session.solutionPath).map(project => project.path);
    } catch (err) {
      log(`Could not parse solution for cache validation: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { methodIndex, locations, projects } = buildMethodIndex(projectPaths);
    session.testLocations = locations;
    session.testProjects = projects;
    const cached = force ? undefined : cache.get(session.solutionPath, projectPaths);
    if (cached && cached.length > 0) {
      session.knownTests = new Set(cached);
      log(`Using cached test list for ${session.solutionPath} (${cached.length} tests)`);
    } else {
      const discoveredNames = await vscode.window.withProgress(
        {
          location: { viewId: 'workbench.view.testing' },
          title: `Loading solution tests from ${path.basename(session.solutionPath)}...`,
          cancellable: true
        },
        (_progress, progressToken) => {
          progressToken.onCancellationRequested(() => cts.cancel());
          return discoverSolutionTests(session.solutionPath, cts.token);
        }
      );
      const tests = new Set<string>();
      let unmapped = 0;
      for (const name of discoveredNames) {
        const fqns = methodIndex.get(stripTestParameters(name));
        if (fqns?.size) {
          fqns.forEach(fqn => tests.add(fqn));
        } else {
          unmapped++;
          tests.add(name);
        }
      }
      log(`Mapped ${tests.size - unmapped} tests to fully-qualified names (${unmapped} unmapped) in ${path.basename(session.solutionPath)}`);
      session.knownTests = tests;
      if (tests.size > 0) {
        cache.set(session.solutionPath, projectPaths, [...tests]);
        cache.save();
      }
    }
    session.message = undefined;
    session.treeDirty = true;
    if (session.playlistPath) {
      matchPlaylist(session, true);
    }
  } catch (err) {
    session.knownTests = undefined;
    session.message = cts.token.isCancellationRequested
      ? 'Solution loading stopped'
      : 'Test discovery failed - check the output';
    session.treeDirty = true;
    if (!cts.token.isCancellationRequested) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Discovery failed for ${session.solutionPath}: ${message}`);
      void vscode.window.showErrorMessage(`Failed to discover ${path.basename(session.solutionPath)}: ${message}`, 'Show Output')
        .then(choice => choice === 'Show Output' && showLog());
    }
  } finally {
    if (session.discoveryCts === cts) {
      session.discoveryCts = undefined;
    }
    cts.dispose();
    renderTree();
    await updateContexts();
  }
}

function entriesForSession(session: SolutionSession): PlaylistTest[] {
  if (!session.knownTests) {
    return [];
  }
  if (session.playlistPath) {
    if (!session.playlistExpansion || session.playlistExpansion.knownTests !== session.knownTests) {
      const expansion = session.playlist
        ? expandPlaylist(session.playlist, session.knownTests, fqn => session.testProjects.get(fqn))
        : { entries: [], notFound: [] };
      session.playlistExpansion = { knownTests: session.knownTests, entries: expansion.entries, notFound: expansion.notFound };
    }
    session.notFoundTests = session.playlistExpansion.notFound;
    return filterEntries(session.playlistExpansion.entries, session.activeFilter)
      .filter(entry => isTestResultVisible(session.testResultFilter, session.testResultStates.get(entry.fullyQualifiedName) ?? 'notRun'));
  }
  session.notFoundTests = [];
  const entries: PlaylistTest[] = [];
  for (const fqn of session.knownTests) {
    entries.push(entryFromKnownTestFqn(fqn, session.testProjects.get(fqn)));
  }
  return filterEntries(entries, session.activeFilter)
    .filter(entry => isTestResultVisible(session.testResultFilter, session.testResultStates.get(entry.fullyQualifiedName) ?? 'notRun'));
}

function renderTree(): void {
  const roots: vscode.TestItem[] = [];
  for (const session of sessions.values()) {
    if (session.treeDirty || !session.treeRoot) {
      session.treeRoot = session.knownTests
        ? buildSolutionTree(controller, session.solutionPath, entriesForSession(session), session.knownTests, {
          locations: session.testLocations,
          projects: session.testProjects,
          testResultStates: session.testResultStates
        })
        : buildSolutionPlaceholder(controller, session.solutionPath, session.message ?? 'Waiting to load solution tests');
      session.treeDirty = false;
    }
    roots.push(session.treeRoot);
  }
  controller.items.replace(roots);
}

function collectLeafItems(scope?: vscode.TestItem): vscode.TestItem[] {
  const leaves: vscode.TestItem[] = [];
  const descriptors = collectDescriptors();
  const walk = (item: vscode.TestItem): void => {
    if (item.children.size > 0) {
      item.children.forEach(walk);
    } else if (descriptors.has(item.id)) {
      leaves.push(item);
    }
  };
  if (scope) {
    walk(scope);
  } else {
    controller.items.forEach(walk);
  }
  return leaves;
}

function collectDescriptors(): Map<string, TestDescriptor> {
  const descriptors = new Map<string, TestDescriptor>();
  for (const session of sessions.values()) {
    if (!session.knownTests) {
      continue;
    }
    for (const entry of entriesForSession(session)) {
      const fqn = entry.fullyQualifiedName;
      descriptors.set(testItemId(session.solutionPath, fqn), {
        fullyQualifiedName: fqn,
        solutionPath: session.solutionPath,
        projectPath: session.testProjects.get(fqn),
        location: session.testLocations.get(fqn)
      });
    }
  }
  return descriptors;
}

async function runWithSolutions(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean): Promise<void> {
  const descriptors = collectDescriptors();
  if (descriptors.size === 0) {
    vscode.window.showInformationMessage('Discover tests from at least one solution first.');
    return;
  }
  const runCts = new vscode.CancellationTokenSource();
  const forwardCancel = token.onCancellationRequested(() => runCts.cancel());
  activeRunCts = runCts;
  try {
    await executeSolutionRun(request, runCts.token, debug, descriptors);
  } finally {
    forwardCancel.dispose();
    if (activeRunCts === runCts) {
      activeRunCts = undefined;
    }
    runCts.dispose();
  }
}

async function executeSolutionRun(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  debug: boolean,
  descriptors: Map<string, TestDescriptor>
): Promise<void> {
  const requestedSolutions = collectRequestedSolutionPaths(request, descriptors);
  const solutionOptions = new Map<string, SolutionRunOptions>();
  for (const session of sessions.values()) {
    if (session.knownTests && requestedSolutions.has(session.solutionPath)) {
      solutionOptions.set(session.solutionPath, {
        solutionPath: session.solutionPath,
        runsettingsPath: await resolveRunsettings(session)
      });
    }
  }
  let renderPending = false;
  let viewStatePending = false;
  let viewStateTimer: NodeJS.Timeout | undefined;
  let lastScreenshotBlank = screenshotWouldBeBlank();

  const scheduleRender = (): void => {
    if (renderPending) {
      return;
    }
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      renderTree();
      void updateContexts();
    }, 0);
  };

  const scheduleViewStateUpdate = (immediate = false): void => {
    if (immediate) {
      if (viewStateTimer) {
        clearTimeout(viewStateTimer);
        viewStateTimer = undefined;
      }
      viewStatePending = false;
      void updateViewState();
      return;
    }
    if (viewStatePending) {
      return;
    }
    viewStatePending = true;
    viewStateTimer = setTimeout(() => {
      viewStatePending = false;
      viewStateTimer = undefined;
      void updateViewState();
    }, 200);
  };

  try {
    await runPlaylistTests(controller, request, token, debug, solutionOptions, {
      descriptors,
      loggerDir: extensionPath ? path.join(extensionPath, 'assets', 'logger') : undefined,
      chunkSize: vscode.workspace.getConfiguration('dotnetTestingPlus').get<number>('chunkSize', 100),
      skipPreBreakpoint: vscode.workspace.getConfiguration('dotnetTestingPlus').get<boolean>('skipPreBreakpoint', true),
      onTestStateChange: (test, state, durationMs) => {
        const descriptor = descriptors.get(test.id);
        const session = descriptor && sessions.get(descriptor.solutionPath);
        if (!descriptor || !session) {
          return;
        }
        const previous = session.testResultStates.get(descriptor.fullyQualifiedName) ?? 'notRun';
        session.testResultStates.set(descriptor.fullyQualifiedName, state);
        if (durationMs === undefined) {
          session.testDurations.delete(descriptor.fullyQualifiedName);
        } else {
          session.testDurations.set(descriptor.fullyQualifiedName, durationMs);
        }
        if (state === 'passed' || state === 'failed' || state === 'skipped') {
          if (lastScreenshotBlank) {
            const blank = screenshotWouldBeBlank();
            if (!blank) {
              lastScreenshotBlank = false;
              scheduleViewStateUpdate(true);
            }
          } else {
            scheduleViewStateUpdate(false);
          }
        }
        if (isTestResultVisible(session.testResultFilter, previous) !== isTestResultVisible(session.testResultFilter, state)) {
          session.treeDirty = true;
          scheduleRender();
        } else {
          updateAncestorGroupLabels(test, session.testResultStates);
        }
      }
    });
  } finally {
    if (viewStateTimer) {
      clearTimeout(viewStateTimer);
    }
    void updateContexts();
  }
}

function collectRequestedSolutionPaths(
  request: vscode.TestRunRequest,
  descriptors: ReadonlyMap<string, TestDescriptor>
): Set<string> {
  const paths = new Set<string>();
  const excluded = new Set(request.exclude ?? []);
  const walk = (item: vscode.TestItem): void => {
    if (excluded.has(item)) {
      return;
    }
    if (item.children.size > 0) {
      item.children.forEach(walk);
      return;
    }
    const descriptor = descriptors.get(item.id);
    if (descriptor) {
      paths.add(descriptor.solutionPath);
    }
  };
  if (request.include?.length) {
    request.include.forEach(walk);
  } else {
    controller.items.forEach(walk);
  }
  return paths;
}

async function resolveRunsettings(session: SolutionSession): Promise<string | undefined> {
  const base = getActiveRunsettings(session);
  if (session.runsettingsMode !== 'override' || !base || !hasCustomRunsettings(session.customRunsettings)) {
    return base;
  }
  const directory = path.join(getCustomRunsettingsStorageDirectory(), 'runsettings', crypto.createHash('sha256').update(session.key).digest('hex'));
  const materialized = await materializeRunsettings(base, session.customRunsettings, directory);
  if (materialized.unresolved.length > 0) {
    log(`Custom runsettings warnings for ${path.basename(session.solutionPath)}: ${materialized.unresolved.join('; ')}`);
  }
  return materialized.path;
}

async function runAllTests(debug: boolean): Promise<void> {
  const leaves = collectLeafItems();
  if (leaves.length === 0) {
    vscode.window.showInformationMessage('No loaded solution has visible tests to run.');
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  try {
    await runWithSolutions(new vscode.TestRunRequest(leaves), cts.token, debug);
  } finally {
    cts.dispose();
  }
}

function controlApiState(): ControlApiState {
  const session = activeSession();
  const resultCounts: Record<string, number> = {};
  if (session) {
    for (const state of session.testResultStates.values()) {
      resultCounts[state] = (resultCounts[state] ?? 0) + 1;
    }
  }
  return {
    apiVersion: 1,
    activeSessionKey,
    sessions: [...sessions.values()].map(item => ({
      key: item.key,
      label: path.basename(item.solutionPath, path.extname(item.solutionPath)),
      solutionPath: item.solutionPath,
      ready: item.knownTests !== undefined && item.discoveryCts === undefined,
      loading: item.discoveryCts !== undefined,
      testCount: item.knownTests?.size,
      playlistPath: item.playlistPath,
      message: item.message
    })),
    runInProgress: activeRunCts !== undefined,
    filter: session?.activeFilter?.raw ?? '',
    resultCounts,
    notFoundTests: session?.notFoundTests ?? [],
    runsettings: session ? { mode: session.runsettingsMode, path: getActiveRunsettings(session) } : undefined
  };
}

function controlApiTests(solutionKey?: string): ControlApiTest[] {
  const targets: SolutionSession[] = [];
  if (solutionKey) {
    const session = sessions.get(solutionKey);
    if (!session) {
      throw new ControlApiError(404, `Unknown solution key: ${solutionKey}`);
    }
    targets.push(session);
  } else {
    targets.push(...sessions.values());
  }
  const tests: ControlApiTest[] = [];
  for (const session of targets) {
    for (const entry of entriesForSession(session)) {
      const fqn = entry.fullyQualifiedName;
      const lastDot = fqn.lastIndexOf('.');
      const location = session.testLocations.get(fqn);
      const duration = session.testDurations.get(fqn);
      tests.push({
        solutionPath: session.solutionPath,
        project: session.testProjects.get(fqn),
        fqn,
        name: lastDot === -1 ? fqn : fqn.slice(lastDot + 1),
        class: lastDot === -1 ? undefined : fqn.slice(0, lastDot),
        state: session.testResultStates.get(fqn) ?? 'notRun',
        durationMs: duration,
        file: location?.file,
        line: location?.line
      });
    }
  }
  return tests;
}

async function runApiTests(options: ControlApiRunOptions): Promise<ControlApiRunResult> {
  const debug = options.debug ?? false;
  if (options.solution && !sessions.has(options.solution)) {
    throw new ControlApiError(404, `Unknown solution key: ${options.solution}`);
  }
  const leaves: vscode.TestItem[] = [];
  const missing: string[] = [];
  if (Array.isArray(options.fqns) && options.fqns.length > 0) {
    const wanted = new Map<string, string>();
    for (const fqn of options.fqns) {
      const session = options.solution
        ? sessions.get(options.solution)
        : [...sessions.values()].find(item => item.knownTests?.has(fqn));
      if (session?.knownTests !== undefined && session.knownTests.has(fqn)) {
        wanted.set(fqn, testItemId(session.solutionPath, fqn));
      }
    }
    const visible = new Map(collectLeafItems().map(item => [item.id, item] as const));
    for (const [fqn, id] of wanted) {
      const item = visible.get(id);
      if (item) {
        leaves.push(item);
      } else {
        missing.push(fqn);
      }
    }
    for (const fqn of options.fqns) {
      if (!wanted.has(fqn) && !missing.includes(fqn)) {
        missing.push(fqn);
      }
    }
  } else if (options.all) {
    const scope = options.solution ? sessions.get(options.solution)?.treeRoot : undefined;
    leaves.push(...collectLeafItems(scope));
  } else {
    throw new ControlApiError(400, 'Provide "all": true or a non-empty "fqns" array.');
  }
  if (leaves.length === 0) {
    return { started: false, matched: 0, missing };
  }
  const cts = new vscode.CancellationTokenSource();
  void runWithSolutions(new vscode.TestRunRequest(leaves), cts.token, debug)
    .catch(err => log(`Control API run failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => cts.dispose());
  return { started: true, matched: leaves.length, missing };
}

function cancelApiRun(options: { loading?: boolean }): { cancelled: boolean; cancelledLoading: boolean } {
  const cancelled = activeRunCts !== undefined;
  activeRunCts?.cancel();
  let cancelledLoading = false;
  if (options.loading) {
    const session = activeSession();
    cancelledLoading = session?.discoveryCts !== undefined;
    session?.discoveryCts?.cancel();
  }
  return { cancelled, cancelledLoading };
}

async function setApiPlaylist(
  context: vscode.ExtensionContext,
  solutionKey: string | undefined,
  playlistPath: string | undefined
): Promise<{ matched: number; notFound: number }> {
  const session = solutionKey ? sessions.get(solutionKey) : activeSession();
  if (!session) {
    throw new ControlApiError(404, 'No matching loaded solution.');
  }
  if (!playlistPath) {
    await clearPlaylist(context, session);
    return { matched: 0, notFound: 0 };
  }
  if (!session.knownTests) {
    throw new ControlApiError(409, 'Discover tests from the solution first.');
  }
  if (path.extname(playlistPath).toLowerCase() !== '.playlist' || !fs.existsSync(playlistPath)) {
    throw new ControlApiError(400, `Playlist file not found or not a .playlist file: ${playlistPath}`);
  }
  await loadPlaylistFromPath(context, session, playlistPath);
  return { matched: entriesForSession(session).length, notFound: session.notFoundTests.length };
}

function controlApiHandlers(context: vscode.ExtensionContext): ControlApiHandlers {
  return {
    getState: () => controlApiState(),
    getTests: solutionKey => ({ tests: controlApiTests(solutionKey) }),
    runTests: options => runApiTests(options),
    cancelRun: options => cancelApiRun(options),
    setPlaylist: (solutionKey, playlistPath) => setApiPlaylist(context, solutionKey, playlistPath),
    setFilter: text => applyFilterInput(text),
    selectSession: async key => {
      if (!sessions.has(key)) {
        return false;
      }
      await selectSession(context, key);
      return true;
    },
    logLines: limit => recentLogLines(limit)
  };
}

function syncControlApi(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('dotnetTestingPlus');
  const enabled = controlApiSessionEnabled;
  const port = config.get<number>('controlApiPort', 48265);
  controlApi?.dispose();
  controlApi = undefined;
  controlApiRunningPort = undefined;
  void updateViewState();
  if (enabled && port > 0) {
    controlApi = startControlApi(
      port,
      config.get<string>('controlApiToken', '') ?? '',
      controlApiHandlers(context),
      boundPort => {
        controlApiRunningPort = boundPort;
        void updateViewState();
      }
    );
  }
}

async function handleViewAction(context: vscode.ExtensionContext, action: MainViewAction): Promise<void> {
  switch (action.type) {
    case 'addSolution': await addSolution(context); break;
     case 'removeSolution': await removeSolution(context, action.key); break;
    case 'selectSession': await selectSession(context, action.key); break;
    case 'selectPlaylist': await selectPlaylist(context); break;
    case 'clearPlaylist': await clearPlaylist(context); break;
    case 'saveAsPlaylist': await savePlaylistAs(); break;
    case 'openScreenshot': mainView.openScreenshotPanel(); break;
    case 'closeScreenshot': mainView.closeScreenshotPanel(); break;
    case 'requestScreenshotPreview': requestScreenshotPreview(action.settings); break;
    case 'selectScreenshotSavePath': await selectScreenshotSavePath(); break;
    case 'saveScreenshot': await saveScreenshot(action.data, action.savePath); break;
    case 'selectRunsettings': await selectRunsettings(context); break;
    case 'clearRunsettings': await clearRunsettings(context); break;
    case 'openRunsettings': await openActiveRunsettings(); break;
    case 'setRunsettingsMode': await setRunsettingsMode(context, action.mode); break;
    case 'filter': applyFilterInput(action.text); break;
    case 'toggleSearchAllSolutions': toggleSearchAllSolutions(action.checked); break;
    case 'clearFilter': clearSearchFilters(); break;
    case 'setResultFilter': applyResultFilter(action.key, action.checked); break;
    case 'toggleSkipPreBreakpoint':
      await vscode.workspace.getConfiguration('dotnetTestingPlus').update('skipPreBreakpoint', action.checked, vscode.ConfigurationTarget.Global);
      break;
    case 'toggleControlApi':
      controlApiSessionEnabled = action.checked;
      syncControlApi(context);
      break;
    case 'setCustomRunsettingsValue': await setCustomRunsettingsValue(context, action.key, action.value); break;
    case 'resetCustomRunsettingsValue': await resetCustomRunsettingsValue(context, action.key); break;
    case 'addCustomRunsettingsParameter': await addCustomRunsettingsParameter(context); break;
    case 'updateCustomRunsettingsParameter': await updateCustomRunsettingsParameter(context, action.id, action.field, action.value); break;
    case 'removeCustomRunsettingsParameter': await removeCustomRunsettingsParameter(context, action.id); break;
  }
}

function applyFilterInput(text: string): void {
  const filter = parseTestFilter(text);
  if (searchAllSolutions) {
    for (const s of sessions.values()) {
      s.activeFilter = filter;
      s.treeDirty = true;
    }
  } else {
    const session = activeSession();
    if (!session) {
      return;
    }
    session.activeFilter = filter;
    session.treeDirty = true;
  }
  renderTree();
  void updateContexts();
}

function toggleSearchAllSolutions(checked: boolean): void {
  if (searchAllSolutions === checked) {
    return;
  }
  searchAllSolutions = checked;
  const currentFilter = activeSession()?.activeFilter;
  for (const s of sessions.values()) {
    if (searchAllSolutions) {
      s.activeFilter = currentFilter;
    } else if (s.key !== activeSessionKey) {
      s.activeFilter = undefined;
    }
    s.treeDirty = true;
  }
  renderTree();
  void updateContexts();
}

function clearSearchFilters(): void {
  if (searchAllSolutions) {
    for (const s of sessions.values()) {
      s.activeFilter = undefined;
      s.treeDirty = true;
    }
    const session = activeSession();
    if (session) {
      session.testResultFilter = createDefaultTestResultFilter();
    }
  } else {
    const session = activeSession();
    if (!session) {
      return;
    }
    session.activeFilter = undefined;
    session.testResultFilter = createDefaultTestResultFilter();
    session.treeDirty = true;
  }
  renderTree();
  void updateContexts();
}

function applyResultFilter(key: TestResultFilterKey, checked: boolean): void {
  const session = activeSession();
  if (!session || session.testResultFilter[key] === checked) {
    return;
  }
  session.testResultFilter[key] = checked;
  session.treeDirty = true;
  renderTree();
  void updateContexts();
}

async function selectPlaylist(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  if (!session?.knownTests) {
    vscode.window.showInformationMessage('Discover tests from the selected solution first.');
    return;
  }
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(session.solutionPath)),
    filters: { 'Visual Studio Test Playlist': ['playlist'] }, title: 'Select a Visual Studio .playlist file'
  });
  if (!uris?.length) {
    return;
  }
  await loadPlaylistFromPath(context, session, uris[0].fsPath);
}

async function loadPlaylistFromPath(context: vscode.ExtensionContext, session: SolutionSession, playlistPath: string): Promise<void> {
  session.playlistPath = playlistPath;
  watchPlaylistFile(session);
  matchPlaylist(session);
  await saveSessions(context);
}

async function clearPlaylist(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  session.playlistPath = undefined;
  session.playlist = undefined;
  session.playlistExpansion = undefined;
  session.notFoundTests = [];
  session.playlistWatcher?.close();
  session.playlistWatcher = undefined;
  session.treeDirty = true;
  renderTree();
  await saveSessions(context);
  await updateContexts();
}

function matchPlaylist(session: SolutionSession, silent = false): void {
  if (!session.playlistPath || !session.knownTests) {
    return;
  }
  try {
    session.playlist = parsePlaylist(fs.readFileSync(session.playlistPath, 'utf8'));
    session.playlistExpansion = undefined;
  } catch (err) {
    session.notFoundTests = [];
    void vscode.window.showErrorMessage(`Failed to parse playlist: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  session.treeDirty = true;
  renderTree();
  void updateContexts();
  if (!silent) {
    const visible = entriesForSession(session);
    void vscode.window.showInformationMessage(`Playlist "${path.basename(session.playlistPath)}": ${visible.length} test(s) matched, ${session.notFoundTests.length} not found in solution.`);
  }
}

function watchPlaylistFile(session: SolutionSession): void {
  session.playlistWatcher?.close();
  if (!session.playlistPath) {
    return;
  }
  try {
    session.playlistWatcher = fs.watch(session.playlistPath, () => {
      if (session.playlistReloadTimer) {
        clearTimeout(session.playlistReloadTimer);
      }
      session.playlistReloadTimer = setTimeout(() => matchPlaylist(session, true), 500);
    });
  } catch {
    // Watching is best-effort; Refresh Selected remains available.
  }
}

async function refreshSolution(session: SolutionSession | undefined): Promise<void> {
  if (!session) {
    vscode.window.showInformationMessage('No solution selected. Add a solution first.');
    return;
  }
  await discover(session, true);
}

async function savePlaylistAs(): Promise<void> {
  const session = activeSession();
  if (!session?.knownTests) {
    return;
  }
  const fqns = entriesForSession(session).map(entry => entry.fullyQualifiedName);
  if (fqns.length === 0) {
    vscode.window.showInformationMessage('No tests are currently visible to export.');
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(session.solutionPath), `${path.basename(session.solutionPath, path.extname(session.solutionPath))}.playlist`)),
    filters: { 'Visual Studio Test Playlist': ['playlist'] }, title: 'Save As Playlist'
  });
  if (!uri) {
    return;
  }
  const format = vscode.workspace.getConfiguration('dotnetTestingPlus').get<PlaylistSaveFormat>('playlistSaveFormat', 'v2');
  fs.writeFileSync(uri.fsPath, serializePlaylist(fqns, format), 'utf8');
  vscode.window.showInformationMessage(`Playlist saved: ${path.basename(uri.fsPath)} (${fqns.length} test(s)).`);
}

function requestScreenshotPreview(settings: ScreenshotExportSettings): void {
  const snapshot = buildScreenshotSnapshot(
    [...sessions.values()]
      .filter(session => session.knownTests !== undefined)
      .map(session => ({
        key: session.key,
        solutionPath: session.solutionPath,
        entries: entriesForSession(session),
        states: session.testResultStates,
        durations: session.testDurations,
        projects: session.testProjects
      })),
    screenshotOptions(settings)
  );
  mainView.postScreenshotPreview(snapshot);
}

function screenshotOptions(settings: ScreenshotExportSettings): ScreenshotOptions {
  const groupBy = settings.groupBy === 'class' || settings.groupBy === 'test' ? settings.groupBy : 'project';
  return {
    solutionKeys: Array.isArray(settings.solutionKeys) ? settings.solutionKeys.filter(key => typeof key === 'string') : [],
    groupBy,
    show: {
      passing: settings.show?.passing !== false,
      failing: settings.show?.failing !== false,
      skipped: settings.show?.skipped === true,
      notRun: settings.show?.notRun === true
    },
    collapsePassingGroups: settings.collapsePassingGroups !== false,
    showExecutionTime: settings.showExecutionTime === true
  };
}

function screenshotWouldBeBlank(): boolean {
  for (const session of sessions.values()) {
    if (session.knownTests === undefined || session.discoveryCts !== undefined) {
      continue;
    }
    for (const entry of entriesForSession(session)) {
      const state = session.testResultStates.get(entry.fullyQualifiedName) ?? 'notRun';
      if (state === 'passed' || state === 'failed' || state === 'skipped') {
        return false;
      }
    }
  }
  return true;
}

function screenshotDefaultPath(): string | undefined {
  const session = activeSession();
  if (!session) {
    return undefined;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(path.dirname(session.solutionPath), `test-results-${stamp}.png`);
}

async function selectScreenshotSavePath(): Promise<void> {
  const defaultPath = screenshotDefaultPath();
  if (!defaultPath) {
    vscode.window.showInformationMessage('Add a solution before choosing an image save path.');
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultPath),
    filters: { 'PNG Image': ['png'] },
    title: 'Save Test Screenshot'
  });
  if (uri) {
    mainView.postScreenshotPath(uri.fsPath);
  }
}

async function saveScreenshot(data: string, requestedPath?: string): Promise<void> {
  const file = requestedPath || screenshotDefaultPath();
  if (!file) {
    mainView.postScreenshotSaveResult('Could not save the PNG: no solution is selected.', true);
    return;
  }
  try {
    const png = Buffer.from(data, 'base64');
    if (png.length === 0) {
      throw new Error('The PNG image was empty.');
    }
    fs.writeFileSync(file, png);
    mainView.postScreenshotSaveResult(`PNG saved: ${path.basename(file)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    mainView.postScreenshotSaveResult(`Could not save PNG: ${message}`, true);
  }
}

async function selectRunsettings(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  const base = session.runsettingsPath ?? session.solutionPath;
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(base)), filters: { 'Test Run Settings': ['runsettings'] },
    title: 'Select a .runsettings file'
  });
  if (!uris?.length) {
    return;
  }
  session.runsettingsPath = uris[0].fsPath;
  session.runsettingsMode = 'custom';
  watchRunsettingsFile(session);
  await saveSessions(context);
  await updateContexts();
}

async function clearRunsettings(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  session.runsettingsPath = undefined;
  watchRunsettingsFile(session);
  await saveSessions(context);
  await updateContexts();
}

async function openActiveRunsettings(): Promise<void> {
  const session = activeSession();
  if (!session || (session.runsettingsMode !== 'default' && session.runsettingsMode !== 'custom')) {
    return;
  }
  const filePath = getActiveRunsettings(session);
  if (!filePath) {
    return;
  }
  if (fs.existsSync(filePath)) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  } else {
    void vscode.window.showWarningMessage('Runsettings file not found: ' + filePath);
  }
}

function getActiveRunsettings(session: SolutionSession): string | undefined {
  if (session.runsettingsMode === 'custom') {
    return session.runsettingsPath && fs.existsSync(session.runsettingsPath) ? session.runsettingsPath : undefined;
  }
  return findDefaultRunsettings(session.solutionPath);
}

function getOverrideBaseRunsettings(session: SolutionSession): string | undefined {
  return session.runsettingsMode === 'override' ? findDefaultRunsettings(session.solutionPath) : undefined;
}

function normalizeRunsettingsMode(value: unknown): RunsettingsMode | undefined {
  return value === 'default' || value === 'override' || value === 'custom' ? value : undefined;
}

async function setRunsettingsMode(context: vscode.ExtensionContext, mode: RunsettingsMode): Promise<void> {
  const session = activeSession();
  if (!session || mode === session.runsettingsMode || (mode !== 'custom' && !findDefaultRunsettings(session.solutionPath))) {
    return;
  }
  session.runsettingsMode = mode;
  if (mode === 'override') {
    session.customRunsettings.sourcePath = findDefaultRunsettings(session.solutionPath);
  }
  watchRunsettingsFile(session);
  await saveSessions(context);
  await updateContexts();
}

function getCustomRunsettingsStorageDirectory(): string {
  const storageUri = extensionContext?.storageUri ?? extensionContext?.globalStorageUri;
  return storageUri?.fsPath ?? path.join(extensionPath ?? path.dirname(__filename), '.storage');
}

async function setCustomRunsettingsValue(context: vscode.ExtensionContext, key: string, value: string): Promise<void> {
  const session = activeSession();
  const base = session && getOverrideBaseRunsettings(session);
  if (!session || !base) {
    return;
  }
  session.customRunsettings.sourcePath = base;
  session.customRunsettings.overrides[key] = value;
  await saveSessions(context);
  await updateContexts();
}

async function resetCustomRunsettingsValue(context: vscode.ExtensionContext, key: string): Promise<void> {
  const session = activeSession();
  if (!session) {
    return;
  }
  delete session.customRunsettings.overrides[key];
  await saveSessions(context);
  await updateContexts();
}

async function addCustomRunsettingsParameter(context: vscode.ExtensionContext): Promise<void> {
  const session = activeSession();
  const base = session && getOverrideBaseRunsettings(session);
  if (!session || !base) {
    return;
  }
  const existing = new Set(session.customRunsettings.parameters.map(parameter => parameter.name.toLowerCase()));
  let suffix = 1;
  let name = 'NewParameter';
  while (existing.has(name.toLowerCase())) {
    suffix++;
    name = `NewParameter${suffix}`;
  }
  session.customRunsettings.parameters.push({ id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, value: '' });
  session.customRunsettings.sourcePath = base;
  await saveSessions(context);
  await updateContexts();
}

async function updateCustomRunsettingsParameter(context: vscode.ExtensionContext, id: string, field: 'name' | 'value', value: string): Promise<void> {
  const session = activeSession();
  const base = session && getOverrideBaseRunsettings(session);
  const parameter = session?.customRunsettings.parameters.find(item => item.id === id);
  if (!session || !base || !parameter) {
    return;
  }
  if (field === 'name') {
    try {
      const error = validateCustomParameterName(value, (await inspectRunsettings(base, session.customRunsettings)).parameters, session.customRunsettings.parameters, id);
      if (error) {
        vscode.window.showWarningMessage(error);
        return;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read the base runsettings file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    parameter.name = value.trim();
  } else {
    parameter.value = value;
  }
  await saveSessions(context);
  await updateContexts();
}

async function removeCustomRunsettingsParameter(context: vscode.ExtensionContext, id: string): Promise<void> {
  const session = activeSession();
  if (!session) {
    return;
  }
  session.customRunsettings.parameters = session.customRunsettings.parameters.filter(parameter => parameter.id !== id);
  await saveSessions(context);
  await updateContexts();
}

function watchRunsettingsFile(session: SolutionSession): void {
  session.runsettingsWatcher?.close();
  const file = getActiveRunsettings(session);
  if (!file) {
    return;
  }
  try {
    session.runsettingsWatcher = fs.watch(file, () => {
      if (session.runsettingsReloadTimer) {
        clearTimeout(session.runsettingsReloadTimer);
      }
      session.runsettingsReloadTimer = setTimeout(() => void updateContexts(), 200);
    });
  } catch (err) {
    log(`Could not watch runsettings file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function updateContexts(): Promise<void> {
  const session = activeSession();
  await vscode.commands.executeCommand('setContext', HAS_SOLUTION_CONTEXT_KEY, sessions.size > 0);
  await vscode.commands.executeCommand('setContext', LOADING_CONTEXT_KEY, session?.discoveryCts !== undefined);
  await vscode.commands.executeCommand('setContext', READY_CONTEXT_KEY, [...sessions.values()].some(item => item.knownTests !== undefined && item.discoveryCts === undefined));
  await updateViewState();
}

async function updateViewState(): Promise<void> {
  const session = activeSession();
  const selectedKey = activeSessionKey;
  let customView: CustomRunsettingsViewState | undefined;
  if (session?.runsettingsMode === 'override') {
    const base = getActiveRunsettings(session);
    if (base) {
      try {
        customView = await inspectRunsettings(base, session.customRunsettings);
      } catch (err) {
        customView = { available: false, values: [], parameters: [], customParameters: session.customRunsettings.parameters, unresolved: [err instanceof Error ? err.message : String(err)], hasCustomizations: hasCustomRunsettings(session.customRunsettings) };
      }
    }
  }
  // Inspecting a runsettings file is asynchronous; do not publish stale data
  // after the user has switched to another solution tab.
  if (selectedKey !== activeSessionKey) {
    return;
  }
  mainView.setState({
    sessions: [...sessions.values()].map(item => ({ key: item.key, label: path.basename(item.solutionPath, path.extname(item.solutionPath)), detail: item.solutionPath, ready: item.knownTests !== undefined && item.discoveryCts === undefined, loading: item.discoveryCts !== undefined, testCount: item.knownTests?.size })),
    activeSessionKey,
    solutionReady: session?.knownTests !== undefined && session.discoveryCts === undefined,
    playlistPath: session?.playlistPath,
    runsettingsPath: session ? getActiveRunsettings(session) : undefined,
    runsettingsIsDefault: session ? session.runsettingsMode !== 'custom' && getActiveRunsettings(session) !== undefined : false,
    runsettingsMode: session?.runsettingsMode ?? 'custom',
    defaultRunsettingsAvailable: session ? findDefaultRunsettings(session.solutionPath) !== undefined : false,
    hasExplicitRunsettings: session?.runsettingsMode === 'custom' && session.runsettingsPath !== undefined,
    filter: session?.activeFilter?.raw ?? '',
    searchAllSolutions,
    resultFilter: session?.testResultFilter ?? createDefaultTestResultFilter(),
    notFoundTests: session?.notFoundTests ?? [],
    customRunsettings: customView,
    skipPreBreakpoint: vscode.workspace.getConfiguration('dotnetTestingPlus').get<boolean>('skipPreBreakpoint', true),
    controlApiEnabled: controlApiSessionEnabled,
    controlApiRunningPort,
    screenshotEmpty: screenshotWouldBeBlank()
  });
}

// Exposed only for lightweight Node harnesses.
export const __testItemIdForTest = testItemId;
