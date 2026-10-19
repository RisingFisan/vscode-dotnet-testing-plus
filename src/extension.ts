import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parsePlaylist, serializePlaylist, expandPlaylist, entryFromKnownTestFqn, ParsedPlaylist, PlaylistSaveFormat, PlaylistTest } from './playlistParser';
import { runPlaylistTests, SolutionRunOptions, TestDescriptor, TestFailureLocations } from './testRunner';
import { SolutionCache } from './cache';
import { fingerprintFqns } from './fileScanCache';
import { killAllTrackedChildren } from './processTree';
import { parseSolutionFile } from './solutionParser';
import { resolveSolutionSilently, pickSolutionInteractively } from './solutionManager';
import { discoverSolutionTests, stripTestParameters } from './solutionDiscovery';
import { CodeLensHandle, registerCodeLenses } from './codeLens';
import { coverageDetailsFor } from './coverage';
import { SourceLocation } from './sourceScan';
import { buildMethodIndex } from './astScan';
import { buildSolutionPlaceholder, buildSolutionTree, testItemId, updateGroupLabels } from './testTree';
import { initLogger, showLog, log, recentLogLines } from './logger';
import { ControlApiError, ControlApiHandlers, ControlApiRunOptions, ControlApiRunResult, ControlApiRunsettingsAction, ControlApiState, ControlApiSseEvent, ControlApiTest } from './controlApi';
import { ApiCoordinator } from './apiCoordinator';
import { assignUniqueId, deriveSessionBaseId, solutionIdFromPath } from './apiIds';
import { MainViewProvider, MainViewAction, ScreenshotExportSettings } from './mainView';
import { TestFilter, parseTestFilter, filterEntries } from './testFilter';
import { TestResultFilter, TestResultFilterKey, TestResultState, createDefaultTestResultFilter, isTestResultVisible } from './testResultFilter';
import { buildScreenshotSnapshot, ScreenshotOptions, ScreenshotSessionData, ScreenshotSnapshot } from './screenshot';
import { installAgentSkill } from './skillInstaller';
import {
  findDefaultRunsettings,
  hasCustomRunsettings,
  hasPermanentRunsettings,
  inspectRunsettings,
  materializeRunsettings,
  normalizeCustomRunsettingsState,
  normalizePermanentRunsettingsConfig,
  validateCustomParameterName,
  CustomRunsettingsState,
  CustomRunsettingsViewState,
  PermanentRunsettingsConfig
} from './runsettingsManager';

const SESSIONS_KEY = 'dotnet-testing-plus.sessions';
const ACTIVE_SESSION_KEY = 'dotnet-testing-plus.activeSession';
// Read these once for migration from the previous single-solution release.
const LEGACY_SOLUTION_PATH_KEY = 'dotnet-testing-plus.solutionPath';
const LEGACY_PLAYLIST_PATH_KEY = 'dotnet-testing-plus.playlistPath';
const LEGACY_RUNSETTINGS_PATH_KEY = 'dotnet-testing-plus.runsettingsPath';
const LEGACY_CUSTOM_RUNSETTINGS_KEY = 'dotnet-testing-plus.customRunsettings';
const READY_CONTEXT_KEY = 'dotnetTestingPlus.solutionReady';
const LOADING_CONTEXT_KEY = 'dotnetTestingPlus.solutionLoading';
const HAS_SOLUTION_CONTEXT_KEY = 'dotnetTestingPlus.hasSolution';

interface PersistedSession {
  solutionPath: string;
  playlistPath?: string;
  runsettingsPath?: string;
  customRunsettings?: unknown;
  permanentRunsettings?: unknown;
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
  customRunsettings: CustomRunsettingsState;
  permanentRunsettings: PermanentRunsettingsConfig;
  activeFilter?: TestFilter;
  testResultFilter: TestResultFilter;
  /** Bumped whenever the result filter changes; it is mutated in place, so identity cannot detect changes. */
  resultFilterVersion: number;
  testResultStates: Map<string, TestResultState>;
  testDurations: Map<string, number>;
  discoveryCts?: vscode.CancellationTokenSource;
  testLocations: Map<string, SourceLocation>;
  testProjects: Map<string, string>;
  notFoundTests: string[];
  discoveredCount?: number;
  message?: string;
  playlistWatcher?: fs.FSWatcher;
  playlistReloadTimer?: NodeJS.Timeout;
  runsettingsWatcher?: fs.FSWatcher;
  runsettingsReloadTimer?: NodeJS.Timeout;
  /** Next re-arm delay for a failing playlist/runsettings watcher (exponential backoff; undefined = no backoff in progress). */
  playlistWatchRetryMs?: number;
  runsettingsWatchRetryMs?: number;
  treeRoot?: vscode.TestItem;
  treeDirty: boolean;
  /** Bumped on every result-state change; invalidates cached visible entries while a result filter hides anything. */
  statesVersion: number;
  /** Per-known-test entries (no playlist), reused until discovery results change. */
  baseEntries?: { known: ReadonlySet<string>; projects: Map<string, string>; entries: PlaylistTest[] };
  /** Last filtered entry list and the inputs it was computed from. */
  visibleEntries?: {
    base: PlaylistTest[];
    filter: TestFilter | undefined;
    resultFilterVersion: number;
    statesVersion: number;
    entries: PlaylistTest[];
  };
}

let controller: vscode.TestController;
let cache: SolutionCache;
let extensionPath: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let mainView: MainViewProvider;
const sessions = new Map<string, SolutionSession>();
let activeSessionKey: string | undefined;
let searchAllSolutions = false;
// Every in-flight run (UI, CodeLens or API); Cancel and deactivate stop them all.
const activeRuns = new Set<vscode.CancellationTokenSource>();
// Solutions with a run in flight: a second run on the same solution is refused.
const runningSolutions = new Set<string>();
let apiCoordinator: ApiCoordinator | undefined;
// Serialized payload of the last SSE state broadcast; identical states skip the broadcast.
let lastBroadcastState: string | undefined;
// Solution inventory signature last pushed to the hub / peer registry.
let lastSolutionsSignature: string | undefined;
let controlApiSessionEnabled = false;
let codeLenses: CodeLensHandle | undefined;
const failureLocations = new Map<string, TestFailureLocations>();

export function activate(context: vscode.ExtensionContext): void {
  initLogger();
  log('Extension activated (v1.24.0, multi-solution discovery)');
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
    (() => {
      const profile = controller.createRunProfile('Run with Coverage', vscode.TestRunProfileKind.Coverage, (request, token) => runWithSolutions(request, token, false), true);
      profile.loadDetailedCoverage = async (_run, fileCoverage) => coverageDetailsFor(fileCoverage);
      return profile;
    })(),
    vscode.commands.registerCommand('dotnet-testing-plus.runTestFromCodeLens', (sessionKey?: string, fqn?: string) =>
      runTestFromCodeLens(sessionKey, fqn, false)),
    vscode.commands.registerCommand('dotnet-testing-plus.debugTestFromCodeLens', (sessionKey?: string, fqn?: string) =>
      runTestFromCodeLens(sessionKey, fqn, true)),
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
    vscode.commands.registerCommand('dotnet-testing-plus.useDefaultRunsettings', async () => {
      const session = await pickLoadedSession('Select a solution to use default runsettings');
      if (session) {
        await useDefaultRunsettings(context, session);
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
    vscode.commands.registerCommand('dotnet-testing-plus.goToCallSite', async (item?: vscode.TestItem) => {
      await navigateToFailureLocation(item, 'callSite');
    }),
    vscode.commands.registerCommand('dotnet-testing-plus.goToErrorLocation', async (item?: vscode.TestItem) => {
      await navigateToFailureLocation(item, 'innermostError');
    }),
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // The session id comes from the first workspace folder; re-register so
      // other windows see the new name.
      syncControlApi(context);
    }),
    new vscode.Disposable(() => apiCoordinator?.stop())
  );
  codeLenses = registerCodeLenses(() => [...sessions.values()]);
  context.subscriptions.push(codeLenses);

  syncControlApi(context);
  void restoreState(context);
}

export function deactivate(): void {
  // Stop in-flight runs and kill their process trees synchronously: closing the
  // window must not leave dotnet/testhost processes behind.
  cancelAllRuns();
  for (const session of sessions.values()) {
    disposeSession(session);
  }
  killAllTrackedChildren();
}

function canonicalPath(file: string): string {
  return path.resolve(file);
}

function createSession(saved: PersistedSession): SolutionSession {
  const solutionPath = canonicalPath(saved.solutionPath);
  const customRunsettings = normalizeCustomRunsettingsState(saved.customRunsettings);
  const permanentRunsettings = normalizePermanentRunsettingsConfig(saved.permanentRunsettings);
  const runsettingsPath = saved.runsettingsPath && fs.existsSync(saved.runsettingsPath)
    ? saved.runsettingsPath
    : undefined;
  return {
    key: solutionPath,
    solutionPath,
    playlistPath: saved.playlistPath && fs.existsSync(saved.playlistPath) ? saved.playlistPath : undefined,
    runsettingsPath,
    customRunsettings,
    permanentRunsettings,
    testResultFilter: createDefaultTestResultFilter(),
    resultFilterVersion: 0,
    testResultStates: new Map(),
    testDurations: new Map(),
    testLocations: new Map(),
    testProjects: new Map(),
    notFoundTests: [],
    treeDirty: true,
    statesVersion: 0
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
    customRunsettings: session.customRunsettings,
    permanentRunsettings: session.permanentRunsettings
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
  // One solution at a time: each cache miss runs dotnet test --list-tests,
  // which builds the whole solution; several at once would thrash the machine
  // right at startup.
  void (async () => {
    for (const session of [...sessions.values()]) {
      await discover(session, false);
    }
  })();
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
  runsettingsViewCache.delete(session.key);
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
  session.discoveredCount = undefined;
  session.message = 'Loading solution tests...';
  session.treeDirty = true;
  renderTree();
  await updateContexts();
  try {
    let projectPaths: string[] = [];
    let cachePaths: string[] = [];
    try {
      const parsed = parseSolutionFile(session.solutionPath);
      projectPaths = parsed.projects.map(project => project.path);
      cachePaths = [...projectPaths, ...parsed.cacheDependencies];
    } catch (err) {
      log(`Could not parse solution for cache validation: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { methodIndex, locations, projects, parserVersion } = await buildMethodIndex(
      projectPaths,
      extensionPath,
      extensionContext?.globalStorageUri.fsPath
    );
    if (cts.token.isCancellationRequested) {
      // Same cleanup the catch performs for cancellation, without using an
      // exception as control flow.
      session.discoveredCount = undefined;
      session.message = 'Solution loading stopped';
      session.treeDirty = true;
      return;
    }
    session.testLocations = locations;
    session.testProjects = projects;
    // The cached list is keyed on .sln/.csproj mtimes, which a source edit never
    // touches; the scan's FQN set tells us when tests were added or removed.
    const scanFingerprint = fingerprintFqns(locations.keys());
    const cached = force ? undefined : cache.get(session.solutionPath, cachePaths, parserVersion, scanFingerprint);
    if (cached && cached.length > 0) {
      session.knownTests = new Set(cached);
      log(`Using cached test list for ${session.solutionPath} (${cached.length} tests)`);
    } else {
      const discoveredNames = await discoverSolutionTests(
        session.solutionPath,
        cts.token,
        count => {
          session.discoveredCount = count;
          session.message = `Finding tests... (${count} found)`;
          session.treeDirty = true;
          renderTree();
          void updateViewState();
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
        cache.set(session.solutionPath, cachePaths, [...tests], parserVersion, scanFingerprint);
        cache.save();
      }
    }
    session.discoveredCount = undefined;
    session.message = undefined;
    session.treeDirty = true;
    if (session.playlistPath) {
      matchPlaylist(session, true);
    }
  } catch (err) {
    // A transient dotnet failure during a refresh must not destroy an
    // already-loaded tree; only a first load (no tests yet) has nothing to
    // keep, and the error is surfaced below either way.
    session.discoveredCount = undefined;
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
  let base: PlaylistTest[];
  if (session.playlistPath) {
    if (!session.playlistExpansion || session.playlistExpansion.knownTests !== session.knownTests) {
      const expansion = session.playlist
        ? expandPlaylist(session.playlist, session.knownTests, fqn => session.testProjects.get(fqn))
        : { entries: [], notFound: [] };
      session.playlistExpansion = { knownTests: session.knownTests, entries: expansion.entries, notFound: expansion.notFound };
      session.notFoundTests = expansion.notFound;
    }
    base = session.playlistExpansion.entries;
  } else {
    // Building an entry per known test is O(N); reuse it until the discovered
    // tests or their project mapping change.
    if (
      !session.baseEntries ||
      session.baseEntries.known !== session.knownTests ||
      session.baseEntries.projects !== session.testProjects
    ) {
      const entries: PlaylistTest[] = [];
      for (const fqn of session.knownTests) {
        entries.push(entryFromKnownTestFqn(fqn, session.testProjects.get(fqn)));
      }
      session.baseEntries = { known: session.knownTests, projects: session.testProjects, entries };
      session.notFoundTests = [];
    }
    base = session.baseEntries.entries;
  }
  // This is called from many hot paths (view refreshes, run setup, CodeLens,
  // screenshot checks). Reuse the filtered result while none of its inputs
  // changed. Result states only matter when the result filter hides something.
  const resultFilter = session.testResultFilter;
  const resultFilterVersion = session.resultFilterVersion;
  const statesMatter = !(resultFilter.passing && resultFilter.failing && resultFilter.notRun && resultFilter.skipped);
  const statesVersion = statesMatter ? session.statesVersion : -1;
  const cached = session.visibleEntries;
  if (
    cached &&
    cached.base === base &&
    cached.filter === session.activeFilter &&
    cached.resultFilterVersion === resultFilterVersion &&
    cached.statesVersion === statesVersion
  ) {
    return cached.entries;
  }
  const entries = filterEntries(base, session.activeFilter)
    .filter(entry => isTestResultVisible(resultFilter, session.testResultStates.get(entry.fullyQualifiedName) ?? 'notRun'));
  session.visibleEntries = { base, filter: session.activeFilter, resultFilterVersion, statesVersion, entries };
  return entries;
}

function renderTree(): void {
  const roots: vscode.TestItem[] = [];
  let rebuilt = false;
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
      rebuilt = true;
    }
    roots.push(session.treeRoot);
  }
  controller.items.replace(roots);
  if (rebuilt) {
    // Only re-evaluate CodeLens when tree contents actually changed; result
    // updates during a run call renderTree repeatedly without rebuilding.
    codeLenses?.notify();
  }
}

function collectLeafItems(scope?: vscode.TestItem, knownDescriptors?: ReadonlyMap<string, TestDescriptor>): vscode.TestItem[] {
  const leaves: vscode.TestItem[] = [];
  const descriptors = knownDescriptors ?? collectDescriptors();
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

async function runWithSolutions(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  debug: boolean,
  knownDescriptors?: Map<string, TestDescriptor>
): Promise<void> {
  const descriptors = knownDescriptors ?? collectDescriptors();
  if (descriptors.size === 0) {
    vscode.window.showInformationMessage('Discover tests from at least one solution first.');
    return;
  }
  // Two runs on one solution would race on `dotnet build` file locks and on the
  // TestResults folder; refuse the second instead of corrupting both.
  const requestedSolutions = collectRequestedSolutionPaths(request, descriptors);
  const busy = [...requestedSolutions].filter(solutionPath => runningSolutions.has(solutionPath));
  if (busy.length > 0) {
    vscode.window.showInformationMessage(
      `A test run is already in progress for ${busy.map(item => path.basename(item)).join(', ')}. Wait for it to finish or cancel it first.`
    );
    return;
  }
  const runCts = new vscode.CancellationTokenSource();
  const forwardCancel = token.onCancellationRequested(() => runCts.cancel());
  activeRuns.add(runCts);
  requestedSolutions.forEach(solutionPath => runningSolutions.add(solutionPath));
  apiCoordinator?.broadcast(ControlApiSseEvent.RunStart, { solutions: [...requestedSolutions] });
  try {
    await executeSolutionRun(request, runCts.token, debug, descriptors, requestedSolutions);
  } finally {
    forwardCancel.dispose();
    activeRuns.delete(runCts);
    requestedSolutions.forEach(solutionPath => runningSolutions.delete(solutionPath));
    runCts.dispose();
    apiCoordinator?.broadcast(ControlApiSseEvent.RunEnd, controlApiState());
  }
}

function cancelAllRuns(): void {
  for (const cts of [...activeRuns]) {
    cts.cancel();
  }
}

// Tree rebuilds and group-label passes walk every test; during a run they are
// coalesced to at most one per interval instead of one per result.
const RENDER_THROTTLE_MS = 250;
const LABEL_THROTTLE_MS = 300;

async function executeSolutionRun(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  debug: boolean,
  descriptors: Map<string, TestDescriptor>,
  requestedSolutions: ReadonlySet<string>
): Promise<void> {
  let coverage = request.profile?.kind === vscode.TestRunProfileKind.Coverage;
  if (coverage && debug) {
    // vstest cannot attach a debugger and collect coverage at the same time.
    log('Debugging with the coverage profile enabled: coverage collection is skipped.');
    vscode.window.setStatusBarMessage('Debug run: coverage collection skipped (not supported while debugging).', 5000);
    coverage = false;
  }
  const solutionOptions = new Map<string, SolutionRunOptions>();
  for (const session of sessions.values()) {
    if (session.knownTests && requestedSolutions.has(session.solutionPath)) {
      solutionOptions.set(session.solutionPath, {
        solutionPath: session.solutionPath,
        runsettingsPath: await resolveRunsettings(session)
      });
    }
  }
  let renderTimer: NodeJS.Timeout | undefined;
  let viewStatePending = false;
  let viewStateTimer: NodeJS.Timeout | undefined;
  let labelTimer: NodeJS.Timeout | undefined;
  const labelSessions = new Set<SolutionSession>();
  let lastScreenshotBlank = screenshotWouldBeBlank();

  const scheduleRender = (): void => {
    if (renderTimer) {
      return;
    }
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderTree();
      void updateContexts();
    }, RENDER_THROTTLE_MS);
  };

  // Group labels ("Class (3/10)") need a pass over the whole tree; recomputing
  // them per result made a run quadratic in the number of tests. The session's
  // *current* tree is read at flush time, so a rebuild in between is harmless.
  const flushLabels = (): void => {
    if (labelTimer) {
      clearTimeout(labelTimer);
      labelTimer = undefined;
    }
    for (const session of labelSessions) {
      if (session.knownTests && session.treeRoot) {
        updateGroupLabels(session.treeRoot, session.testResultStates);
      }
    }
    labelSessions.clear();
  };
  const scheduleLabels = (session: SolutionSession): void => {
    labelSessions.add(session);
    if (!labelTimer) {
      labelTimer = setTimeout(() => {
        labelTimer = undefined;
        flushLabels();
      }, LABEL_THROTTLE_MS);
    }
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
      coverage,
      skipPreBreakpoint: vscode.workspace.getConfiguration('dotnetTestingPlus').get<boolean>('skipPreBreakpoint', true),
      onTestFailureLocations: (test, locations) => {
        failureLocations.set(test.id, locations);
      },
      onTestStateChange: (test, state, durationMs) => {
        if (state === 'passed' || state === 'skipped') {
          failureLocations.delete(test.id);
        }
        const descriptor = descriptors.get(test.id);
        const session = descriptor && sessions.get(descriptor.solutionPath);
        if (!descriptor || !session) {
          return;
        }
        const previous = session.testResultStates.get(descriptor.fullyQualifiedName) ?? 'notRun';
        session.testResultStates.set(descriptor.fullyQualifiedName, state);
        if (previous !== state) {
          session.statesVersion++;
        }
        if (durationMs === undefined) {
          session.testDurations.delete(descriptor.fullyQualifiedName);
        } else {
          session.testDurations.set(descriptor.fullyQualifiedName, durationMs);
        }
        apiCoordinator?.broadcast(ControlApiSseEvent.TestState, {
          solutionPath: descriptor.solutionPath,
          fqn: descriptor.fullyQualifiedName,
          state,
          durationMs
        });
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
        } else if (session.knownTests && session.treeRoot) {
          scheduleLabels(session);
        }
      }
    });
  } finally {
    if (viewStateTimer) {
      clearTimeout(viewStateTimer);
    }
    // Apply whatever is still pending so the tree ends the run fully current.
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
      renderTree();
    }
    flushLabels();
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

function getPermanentOverrides(session?: SolutionSession): PermanentRunsettingsConfig {
  if (session) {
    return session.permanentRunsettings;
  }
  return { values: {}, parameters: [] };
}

async function savePermanentOverrides(context: vscode.ExtensionContext, session: SolutionSession, config: PermanentRunsettingsConfig): Promise<void> {
  const clean: PermanentRunsettingsConfig = {};
  if (config.values && Object.keys(config.values).length > 0) {
    clean.values = config.values;
  }
  if (config.parameters && config.parameters.length > 0) {
    clean.parameters = config.parameters.map(p => ({ id: p.id, name: p.name, value: p.value }));
  }
  session.permanentRunsettings = clean;
  await saveSessions(context);
}

function clearTemporaryOverrides(session: SolutionSession): void {
  session.customRunsettings.overrides = {};
  session.customRunsettings.parameters = [];
  session.customRunsettings.sourcePath = undefined;
}

async function resolveRunsettings(session: SolutionSession): Promise<string | undefined> {
  const base = getActiveRunsettings(session);
  if (!base) {
    return undefined;
  }
  const permanent = getPermanentOverrides(session);
  const directory = path.join(getCustomRunsettingsStorageDirectory(), 'runsettings', crypto.createHash('sha256').update(session.key).digest('hex'));
  const materialized = await materializeRunsettings(base, session.customRunsettings, directory, permanent);
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

async function runTestFromCodeLens(sessionKey: string | undefined, fqn: string | undefined, debug: boolean): Promise<void> {
  const session = sessionKey ? sessions.get(sessionKey) : undefined;
  const item = session?.treeRoot && fqn
    ? findTreeItem(session.treeRoot, testItemId(session.solutionPath, fqn))
    : undefined;
  if (!item) {
    vscode.window.showInformationMessage('That test is no longer visible in the tree; refresh its solution.');
    return;
  }
  const cts = new vscode.CancellationTokenSource();
  try {
    await runWithSolutions(new vscode.TestRunRequest([item]), cts.token, debug);
  } finally {
    cts.dispose();
  }
}

function findTreeItem(root: vscode.TestItem, id: string): vscode.TestItem | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of childrenOf(root)) {
    const found = findTreeItem(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function childrenOf(item: vscode.TestItem): vscode.TestItem[] {
  const children: vscode.TestItem[] = [];
  item.children.forEach(child => children.push(child));
  return children;
}

function controlApiState(): ControlApiState {
  const session = activeSession();
  const resultCounts: Record<string, number> = {};
  if (session) {
    for (const state of session.testResultStates.values()) {
      resultCounts[state] = (resultCounts[state] ?? 0) + 1;
    }
  }
  const ids = apiSolutionIds();
  return {
    apiVersion: 2,
    sessionId: apiCoordinator?.getSessionId() ?? '',
    activeSolutionKey: activeSessionKey,
    solutions: [...sessions.values()].map(item => ({
      id: ids.get(item.key) ?? solutionIdFromPath(item.solutionPath),
      key: item.key,
      label: path.basename(item.solutionPath, path.extname(item.solutionPath)),
      solutionPath: item.solutionPath,
      ready: item.knownTests !== undefined && item.discoveryCts === undefined,
      loading: item.discoveryCts !== undefined,
      testCount: item.knownTests?.size,
      playlistPath: item.playlistPath,
      message: item.message
    })),
    runInProgress: activeRuns.size > 0,
    filter: session?.activeFilter?.raw ?? '',
    resultCounts,
    notFoundTests: session?.notFoundTests ?? [],
    runsettings: session ? {
      mode: session.runsettingsPath ? 'custom' : 'default',
      path: getActiveRunsettings(session)
    } : undefined
  };
}

/** Stable, unique per-window URL ids for every loaded solution (sorted for determinism). */
function apiSolutionIds(): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const key of [...sessions.keys()].sort()) {
    const id = assignUniqueId(solutionIdFromPath(key), taken);
    ids.set(key, id);
    taken.add(id);
  }
  return ids;
}

function solutionKeyFromId(id: string): string | undefined {
  for (const [key, value] of apiSolutionIds()) {
    if (value === id) {
      return key;
    }
  }
  return undefined;
}

function resolveApiSolution(id: string): SolutionSession {
  const key = solutionKeyFromId(id);
  const session = key ? sessions.get(key) : undefined;
  if (!session) {
    throw new ControlApiError(404, `Unknown solution: ${id}`);
  }
  return session;
}

function controlApiTests(solutionId: string): ControlApiTest[] {
  const session = resolveApiSolution(solutionId);
  const tests: ControlApiTest[] = [];
  if (!session.knownTests) {
    return tests;
  }
  // Every known test is reported regardless of the VS Code playlist / text /
  // result filters: the dashboard owns its own scoping. Only result *states*
  // (which are shared, being actual run output) cross the boundary.
  for (const fqn of session.knownTests) {
    const entry = entryFromKnownTestFqn(fqn, session.testProjects.get(fqn));
    const location = session.testLocations.get(fqn);
    const duration = session.testDurations.get(fqn);
    tests.push({
      solutionPath: session.solutionPath,
      solutionId,
      project: entry.project,
      fqn,
      name: entry.testName,
      class: entry.className,
      state: session.testResultStates.get(fqn) ?? 'notRun',
      durationMs: duration,
      file: location?.file,
      line: location?.line
    });
  }
  return tests;
}

async function runApiTests(options: ControlApiRunOptions): Promise<ControlApiRunResult> {
  const debug = options.debug ?? false;
  const solutionKey = options.solution ? (solutionKeyFromId(options.solution) ?? undefined) : undefined;
  if (options.solution && !solutionKey) {
    throw new ControlApiError(404, `Unknown solution: ${options.solution}`);
  }
  // Built once and shared with the run itself (it used to be built twice).
  const descriptors = collectDescriptors();
  const leaves: vscode.TestItem[] = [];
  const missing: string[] = [];
  if (Array.isArray(options.fqns) && options.fqns.length > 0) {
    const wanted = new Map<string, { fqn: string; session: SolutionSession }>();
    for (const fqn of options.fqns) {
      const session = solutionKey
        ? sessions.get(solutionKey)
        : [...sessions.values()].find(item => item.knownTests?.has(fqn));
      if (session?.knownTests !== undefined && session.knownTests.has(fqn)) {
        wanted.set(fqn, { fqn, session });
      }
    }
    const visible = new Map(collectLeafItems(undefined, descriptors).map(item => [item.id, item] as const));
    const missingSet = new Set<string>();
    for (const [fqn, { session }] of wanted) {
      const id = testItemId(session.solutionPath, fqn);
      const item = visible.get(id);
      if (item) {
        leaves.push(item);
      } else {
        const location = session.testLocations.get(fqn);
        const uri = location?.file ? vscode.Uri.file(location.file) : undefined;
        const leaf = controller.createTestItem(id, fqn, uri);
        descriptors.set(id, {
          fullyQualifiedName: fqn,
          solutionPath: session.solutionPath,
          projectPath: session.testProjects.get(fqn),
          location
        });
        leaves.push(leaf);
      }
    }
    for (const fqn of options.fqns) {
      if (!wanted.has(fqn)) {
        missingSet.add(fqn);
      }
    }
    missing.push(...missingSet);
  } else if (options.all) {
    const scope = solutionKey ? sessions.get(solutionKey)?.treeRoot : undefined;
    leaves.push(...collectLeafItems(scope, descriptors));
  } else {
    throw new ControlApiError(400, 'Provide "all": true or a non-empty "fqns" array.');
  }
  if (leaves.length === 0) {
    return { started: false, matched: 0, missing };
  }
  const busy = new Set<string>();
  for (const leaf of leaves) {
    const solutionPath = descriptors.get(leaf.id)?.solutionPath;
    if (solutionPath && runningSolutions.has(solutionPath)) {
      busy.add(path.basename(solutionPath));
    }
  }
  if (busy.size > 0) {
    throw new ControlApiError(409, `A test run is already in progress for: ${[...busy].join(', ')}. Cancel it first.`);
  }
  const cts = new vscode.CancellationTokenSource();
  void runWithSolutions(new vscode.TestRunRequest(leaves), cts.token, debug, descriptors)
    .catch(err => log(`Control API run failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => cts.dispose());
  return { started: true, matched: leaves.length, missing };
}

function cancelApiRun(options: { loading?: boolean }): { cancelled: boolean; cancelledLoading: boolean } {
  const cancelled = activeRuns.size > 0;
  cancelAllRuns();
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
  solutionId: string,
  playlistPath: string | undefined
): Promise<{ matched: number; notFound: number }> {
  const session = resolveApiSolution(solutionId);
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

function extractMethodSource(filePath: string, line: number): string {
  if (!fs.existsSync(filePath)) {
    return '// Source file not found: ' + filePath;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const declIndex = Math.max(0, Math.min(lines.length - 1, line - 1));

  let startIndex = declIndex;
  while (startIndex > 0) {
    const prev = lines[startIndex - 1].trim();
    if (prev.startsWith('[') || prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*')) {
      startIndex--;
    } else {
      break;
    }
  }

  let openBraceFound = false;
  let braceDepth = 0;
  let endIndex = declIndex;
  // Braces inside string literals, char literals and comments must not count:
  // a body containing Console.WriteLine("}") or "// }" would otherwise
  // truncate the extraction.
  let inBlockComment = false;

  for (let i = declIndex; i < lines.length; i++) {
    const l = lines[i];
    for (let c = 0; c < l.length; c++) {
      const ch = l[c];
      if (inBlockComment) {
        if (ch === '*' && l[c + 1] === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        // Skip the quoted run; a backslash escapes the next character.
        const quote = ch;
        c++;
        while (c < l.length && l[c] !== quote) {
          if (l[c] === '\\') {
            c++;
          }
          c++;
        }
        continue;
      }
      if (ch === '/' && l[c + 1] === '/') {
        break;
      }
      if (ch === '/' && l[c + 1] === '*') {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === '{') {
        openBraceFound = true;
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
        if (openBraceFound && braceDepth <= 0) {
          endIndex = i;
          break;
        }
      } else if (!openBraceFound && ch === ';' && l.includes('=>')) {
        endIndex = i;
        break;
      }
    }
    if (openBraceFound && braceDepth <= 0) {
      break;
    }
  }

  if (!openBraceFound && endIndex === declIndex) {
    endIndex = Math.min(lines.length - 1, declIndex + 30);
  }

  return lines.slice(startIndex, endIndex + 1).join('\n');
}

function controlApiHandlers(context: vscode.ExtensionContext): ControlApiHandlers {
  return {
    getState: () => controlApiState(),
    getTests: solutionId => ({ tests: controlApiTests(solutionId) }),
    runTests: options => runApiTests(options),
    cancelRun: options => cancelApiRun(options),
    setPlaylist: (solutionId, playlistPath) => setApiPlaylist(context, solutionId, playlistPath),
    setFilter: text => applyFilterInput(text),
    selectSolution: async solutionId => {
      const key = solutionKeyFromId(solutionId);
      if (!key) {
        return false;
      }
      await selectSession(context, key);
      return true;
    },
    logLines: limit => recentLogLines(limit),
    getScreenshot: settings => apiScreenshotSnapshot(settings),
    getCode: (solutionId, fqn) => {
      const session = resolveApiSolution(solutionId);
      const location = session.testLocations.get(fqn);
      if (!location) {
        return { fqn, code: '// Source location not available for ' + fqn };
      }
      const code = extractMethodSource(location.file, location.line);
      return {
        fqn,
        file: location.file,
        line: location.line,
        code
      };
    },
    getRunsettings: solutionId => apiRunsettings(resolveApiSolution(solutionId)),
    applyRunsettings: (solutionId, action) => apiApplyRunsettings(context, resolveApiSolution(solutionId), action)
  };
}

function apiSessionBase(): { baseId: string; label: string } {
  const folders = vscode.workspace.workspaceFolders;
  const workspaceFile = vscode.workspace.workspaceFile;
  const label = folders && folders.length > 0
    ? folders[0].name
    : (workspaceFile ? path.basename(workspaceFile.fsPath, path.extname(workspaceFile.fsPath)) : 'untitled');
  const baseId = deriveSessionBaseId(
    workspaceFile ? { fsPath: workspaceFile.fsPath } : undefined,
    folders?.map(folder => ({ name: folder.name }))
  );
  return { baseId, label };
}

function syncControlApi(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('dotnetTestingPlus');
  const enabled = controlApiSessionEnabled || config.get<boolean>('controlApiEnabled', false);
  const port = config.get<number>('controlApiPort', 48265);
  const token = config.get<string>('controlApiToken', '') ?? '';
  apiCoordinator?.stop();
  apiCoordinator = undefined;
  lastBroadcastState = undefined;
  lastSolutionsSignature = undefined;
  void updateViewState();
  if (enabled) {
    const coordinator = new ApiCoordinator({
      globalStorageDir: context.globalStorageUri.fsPath,
      handlers: controlApiHandlers(context),
      getPort: () => port,
      getToken: () => token,
      getSessionBase: () => apiSessionBase(),
      getSolutions: () => controlApiState().solutions,
      onStateChange: () => void updateViewState()
    });
    apiCoordinator = coordinator;
    void coordinator.start();
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
    case 'useDefaultRunsettings': await useDefaultRunsettings(context); break;
    case 'clearRunsettings': await clearRunsettings(context); break;
    case 'openRunsettings': await openActiveRunsettings(); break;
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
    case 'toggleLockCustomRunsettingsValue': await toggleLockCustomRunsettingsValue(context, action.key, action.isPermanent); break;
    case 'addCustomRunsettingsParameter': await addCustomRunsettingsParameter(context); break;
    case 'updateCustomRunsettingsParameter': {
      const error = await updateCustomRunsettingsParameter(context, action.id, action.field, action.value);
      if (error) {
        void vscode.window.showWarningMessage(error);
      }
      break;
    }
    case 'removeCustomRunsettingsParameter': await removeCustomRunsettingsParameter(context, action.id); break;
    case 'toggleLockCustomRunsettingsParameter': await toggleLockCustomRunsettingsParameter(context, action.id, action.isPermanent); break;
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
  // Mirrors applyFilterInput's scoping: the text filter follows the search
  // mode, and the result filter is cleared for every session it can gate.
  if (searchAllSolutions) {
    for (const s of sessions.values()) {
      s.activeFilter = undefined;
      s.testResultFilter = createDefaultTestResultFilter();
      s.resultFilterVersion++;
      s.treeDirty = true;
    }
  } else {
    const session = activeSession();
    if (!session) {
      return;
    }
    session.activeFilter = undefined;
    session.testResultFilter = createDefaultTestResultFilter();
    session.resultFilterVersion++;
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
  session.resultFilterVersion++;
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
    // A parse failure leaves the previous playlist and its expansion in place;
    // only the error is surfaced.
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

/**
 * `fs.watch` wrapper for single files. An FSWatcher without an 'error'
 * listener turns any watch failure (e.g. EPERM when the file is deleted on
 * Windows) into an uncaught exception in the shared extension host. A
 * 'rename' event also means the file was replaced or removed, which leaves
 * the watch bound to the old inode on Linux, so `rearm` is invoked shortly
 * after to attach a fresh watcher.
 */
function watchFileSafely(file: string, onChange: () => void, rearm: () => void): fs.FSWatcher | undefined {
  try {
    const watcher = fs.watch(file, eventType => {
      onChange();
      if (eventType === 'rename') {
        setTimeout(rearm, 200);
      }
    });
    watcher.on('error', err => {
      log(`File watcher error for ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        watcher.close();
      } catch {
        // already closed
      }
    });
    return watcher;
  } catch (err) {
    // Watching is best-effort; manual refresh remains available.
    log(`Could not watch ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// Re-arming a permanently failing fs.watch every 500 ms would spam the log
// forever; consecutive failures back off exponentially, and a successful
// re-arm resets the delay.
const WATCH_RETRY_BASE_MS = 500;
const WATCH_RETRY_MAX_MS = 30000;

function watchPlaylistFile(session: SolutionSession): void {
  session.playlistWatcher?.close();
  session.playlistWatcher = undefined;
  const file = session.playlistPath;
  if (!file) {
    return;
  }
  session.playlistWatcher = watchFileSafely(
    file,
    () => {
      if (session.playlistReloadTimer) {
        clearTimeout(session.playlistReloadTimer);
      }
      session.playlistReloadTimer = setTimeout(() => matchPlaylist(session, true), 500);
    },
    () => {
      if (sessions.get(session.key) === session && session.playlistPath === file) {
        watchPlaylistFile(session);
      }
    }
  );
  if (session.playlistWatcher) {
    session.playlistWatchRetryMs = undefined;
  } else {
    const retryMs = session.playlistWatchRetryMs ?? WATCH_RETRY_BASE_MS;
    session.playlistWatchRetryMs = Math.min(retryMs * 2, WATCH_RETRY_MAX_MS);
    setTimeout(() => {
      if (sessions.get(session.key) === session && session.playlistPath === file && !session.playlistWatcher) {
        watchPlaylistFile(session);
      }
    }, retryMs);
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

/** Display options shared by the webview preview and the control API snapshot. */
function screenshotDisplayOptions(settings: ScreenshotExportSettings): Omit<ScreenshotOptions, 'solutionKeys'> {
  const groupBy = settings.groupBy === 'class' || settings.groupBy === 'test' ? settings.groupBy : 'project';
  return {
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

function screenshotOptions(settings: ScreenshotExportSettings): ScreenshotOptions {
  return {
    solutionKeys: Array.isArray(settings.solutionKeys) ? settings.solutionKeys.filter(key => typeof key === 'string') : [],
    ...screenshotDisplayOptions(settings)
  };
}

/**
 * The web dashboard asks for an explicit set of FQNs, so neither the VS Code
 * playlist/text/result filters nor the active solution tab leak into the export.
 */
function apiScreenshotSnapshot(settings: unknown): ScreenshotSnapshot {
  const body = (settings && typeof settings === 'object' ? settings : {}) as { fqns?: unknown; solutionKeys?: unknown };
  const wanted = new Set(Array.isArray(body.fqns) ? body.fqns.filter((fqn): fqn is string => typeof fqn === 'string') : []);
  const keys: string[] = [];
  const data: ScreenshotSessionData[] = [];
  for (const session of sessions.values()) {
    if (!session.knownTests) {
      continue;
    }
    const entries: PlaylistTest[] = [];
    for (const fqn of session.knownTests) {
      if (wanted.has(fqn)) {
        entries.push(entryFromKnownTestFqn(fqn, session.testProjects.get(fqn)));
      }
    }
    if (entries.length === 0) {
      continue;
    }
    keys.push(session.key);
    data.push({
      key: session.key,
      solutionPath: session.solutionPath,
      entries,
      states: session.testResultStates,
      durations: session.testDurations,
      projects: session.testProjects
    });
  }
  return buildScreenshotSnapshot(data, {
    ...screenshotDisplayOptions(body as ScreenshotExportSettings),
    solutionKeys: keys
  });
}

// Screenshot blankness is checked on every view refresh but only depends on
// a session's visible entries and their states; memoize per session so the
// per-result refreshes during a run skip the full entry scan.
const screenshotBlankCache = new WeakMap<SolutionSession, { entries: PlaylistTest[]; statesVersion: number; blank: boolean }>();

function sessionScreenshotBlank(session: SolutionSession): boolean {
  // entriesForSession returns a cached list until any of its inputs
  // (playlist, text/result filters, results) changes, so its identity plus
  // statesVersion covers everything blankness depends on.
  const entries = entriesForSession(session);
  const cached = screenshotBlankCache.get(session);
  if (cached && cached.entries === entries && cached.statesVersion === session.statesVersion) {
    return cached.blank;
  }
  const blank = !entries.some(entry => {
    const state = session.testResultStates.get(entry.fullyQualifiedName) ?? 'notRun';
    return state === 'passed' || state === 'failed' || state === 'skipped';
  });
  screenshotBlankCache.set(session, { entries, statesVersion: session.statesVersion, blank });
  return blank;
}

function screenshotWouldBeBlank(): boolean {
  for (const session of sessions.values()) {
    if (session.knownTests === undefined || session.discoveryCts !== undefined) {
      continue;
    }
    if (!sessionScreenshotBlank(session)) {
      return false;
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
  await applyRunsettingsPath(context, session, uris[0].fsPath);
}

/** Point a solution at a runsettings file (or back to the default when undefined). */
async function applyRunsettingsPath(context: vscode.ExtensionContext, session: SolutionSession, filePath: string | undefined): Promise<void> {
  session.runsettingsPath = filePath;
  clearTemporaryOverrides(session);
  watchRunsettingsFile(session);
  await saveSessions(context);
  await updateContexts();
}

async function useDefaultRunsettings(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  session.runsettingsPath = undefined;
  clearTemporaryOverrides(session);
  watchRunsettingsFile(session);
  await saveSessions(context);
  await updateContexts();
}

async function clearRunsettings(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  await useDefaultRunsettings(context, session);
}

async function openActiveRunsettings(): Promise<void> {
  const session = activeSession();
  if (!session) {
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

// findDefaultRunsettings readdirs the solution directory; during runs
// updateViewState fires every ~200 ms and would repeat that readdir on every
// tick. Cache per solution keyed on the directory's mtime (the same pattern
// inspectRunsettingsCached uses for the XML inspection): a directory mtime
// change covers everything that can alter which file is picked.
const defaultRunsettingsCache = new Map<string, { dirMtimeMs: number; found?: string }>();

function findDefaultRunsettingsCached(solutionPath: string): string | undefined {
  const dir = path.dirname(solutionPath);
  let dirMtimeMs: number;
  try {
    dirMtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    return findDefaultRunsettings(solutionPath);
  }
  const cached = defaultRunsettingsCache.get(solutionPath);
  if (cached && cached.dirMtimeMs === dirMtimeMs) {
    return cached.found;
  }
  const found = findDefaultRunsettings(solutionPath);
  defaultRunsettingsCache.set(solutionPath, { dirMtimeMs, found });
  return found;
}

function getActiveRunsettings(session: SolutionSession): string | undefined {
  if (session.runsettingsPath && fs.existsSync(session.runsettingsPath)) {
    return session.runsettingsPath;
  }
  return findDefaultRunsettingsCached(session.solutionPath);
}

function getCustomRunsettingsStorageDirectory(): string {
  const storageUri = extensionContext?.storageUri ?? extensionContext?.globalStorageUri;
  return storageUri?.fsPath ?? path.join(extensionPath ?? path.dirname(__filename), '.storage');
}

async function setCustomRunsettingsValue(context: vscode.ExtensionContext, key: string, value: string, session = activeSession()): Promise<void> {
  const base = session && getActiveRunsettings(session);
  if (!session || !base) {
    return;
  }
  const permanent = getPermanentOverrides(session);
  if (permanent.values && Object.prototype.hasOwnProperty.call(permanent.values, key)) {
    permanent.values[key] = value;
    await savePermanentOverrides(context, session, permanent);
  } else {
    session.customRunsettings.sourcePath = base;
    session.customRunsettings.overrides[key] = value;
    await saveSessions(context);
  }
  await updateContexts();
}

async function resetCustomRunsettingsValue(context: vscode.ExtensionContext, key: string, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  const permanent = getPermanentOverrides(session);
  let changed = false;
  if (permanent.values && Object.prototype.hasOwnProperty.call(permanent.values, key)) {
    delete permanent.values[key];
    await savePermanentOverrides(context, session, permanent);
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(session.customRunsettings.overrides, key)) {
    delete session.customRunsettings.overrides[key];
    await saveSessions(context);
    changed = true;
  }
  if (changed) {
    await updateContexts();
  }
}

async function toggleLockCustomRunsettingsValue(context: vscode.ExtensionContext, key: string, isPermanent: boolean, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  const permanent = getPermanentOverrides(session);
  permanent.values = permanent.values ?? {};
  if (isPermanent) {
    // Currently permanent -> unlock to temporary
    const currentVal = permanent.values[key] ?? session.customRunsettings.overrides[key];
    delete permanent.values[key];
    if (currentVal !== undefined) {
      session.customRunsettings.overrides[key] = currentVal;
    }
    await savePermanentOverrides(context, session, permanent);
    await saveSessions(context);
  } else {
    // Currently temporary -> lock to permanent
    const currentVal = session.customRunsettings.overrides[key];
    if (currentVal !== undefined) {
      permanent.values[key] = currentVal;
      delete session.customRunsettings.overrides[key];
      await savePermanentOverrides(context, session, permanent);
      await saveSessions(context);
    }
  }
  await updateContexts();
}

async function toggleLockCustomRunsettingsParameter(context: vscode.ExtensionContext, id: string, isPermanent: boolean, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  const permanent = getPermanentOverrides(session);
  permanent.parameters = permanent.parameters ?? [];
  if (isPermanent) {
    // Currently permanent -> unlock
    const param = permanent.parameters.find(p => p.id === id);
    permanent.parameters = permanent.parameters.filter(p => p.id !== id);
    if (param) {
      if (!session.customRunsettings.parameters.some(p => p.id === id)) {
        session.customRunsettings.parameters.push({ id: param.id, name: param.name, value: param.value });
      }
    }
    await savePermanentOverrides(context, session, permanent);
    await saveSessions(context);
  } else {
    // Currently temporary -> lock to permanent
    const param = session.customRunsettings.parameters.find(p => p.id === id);
    if (param) {
      session.customRunsettings.parameters = session.customRunsettings.parameters.filter(p => p.id !== id);
      permanent.parameters.push({ id: param.id, name: param.name, value: param.value });
      await savePermanentOverrides(context, session, permanent);
      await saveSessions(context);
    }
  }
  await updateContexts();
}

async function addCustomRunsettingsParameter(context: vscode.ExtensionContext, session = activeSession()): Promise<void> {
  const base = session && getActiveRunsettings(session);
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

async function updateCustomRunsettingsParameter(
  context: vscode.ExtensionContext,
  id: string,
  field: 'name' | 'value',
  value: string,
  session = activeSession()
): Promise<string | undefined> {
  const base = session && getActiveRunsettings(session);
  const permanent = getPermanentOverrides(session);
  const permParam = permanent.parameters?.find(item => item.id === id);
  const tempParam = session?.customRunsettings.parameters.find(item => item.id === id);
  const parameter = permParam ?? tempParam;
  if (!session || !base || !parameter) {
    return undefined;
  }
  if (field === 'name') {
    let inspected;
    try {
      inspected = await inspectRunsettings(base, session.customRunsettings, permanent);
    } catch (err) {
      return `Could not read the base runsettings file: ${err instanceof Error ? err.message : String(err)}`;
    }
    const error = validateCustomParameterName(value, inspected.parameters, inspected.customParameters, id);
    if (error) {
      return error;
    }
    parameter.name = value.trim();
  } else {
    parameter.value = value;
  }
  if (permParam) {
    await savePermanentOverrides(context, session, permanent);
  } else {
    await saveSessions(context);
  }
  await updateContexts();
  return undefined;
}

async function removeCustomRunsettingsParameter(context: vscode.ExtensionContext, id: string, session = activeSession()): Promise<void> {
  if (!session) {
    return;
  }
  const permanent = getPermanentOverrides(session);
  let changed = false;
  if (permanent.parameters?.some(p => p.id === id)) {
    permanent.parameters = permanent.parameters.filter(p => p.id !== id);
    await savePermanentOverrides(context, session, permanent);
    changed = true;
  }
  if (session.customRunsettings.parameters.some(p => p.id === id)) {
    session.customRunsettings.parameters = session.customRunsettings.parameters.filter(parameter => parameter.id !== id);
    await saveSessions(context);
    changed = true;
  }
  if (changed) {
    await updateContexts();
  }
}

function watchRunsettingsFile(session: SolutionSession): void {
  session.runsettingsWatcher?.close();
  session.runsettingsWatcher = undefined;
  const file = getActiveRunsettings(session);
  if (!file) {
    return;
  }
  session.runsettingsWatcher = watchFileSafely(
    file,
    () => {
      if (session.runsettingsReloadTimer) {
        clearTimeout(session.runsettingsReloadTimer);
      }
      session.runsettingsReloadTimer = setTimeout(() => void updateContexts(), 200);
    },
    () => {
      if (sessions.get(session.key) === session && getActiveRunsettings(session) === file) {
        watchRunsettingsFile(session);
      }
    }
  );
  if (session.runsettingsWatcher) {
    session.runsettingsWatchRetryMs = undefined;
  } else {
    const retryMs = session.runsettingsWatchRetryMs ?? WATCH_RETRY_BASE_MS;
    session.runsettingsWatchRetryMs = Math.min(retryMs * 2, WATCH_RETRY_MAX_MS);
    setTimeout(() => {
      if (sessions.get(session.key) === session && getActiveRunsettings(session) === file && !session.runsettingsWatcher) {
        watchRunsettingsFile(session);
      }
    }, retryMs);
  }
}

async function updateContexts(): Promise<void> {
  const session = activeSession();
  await vscode.commands.executeCommand('setContext', HAS_SOLUTION_CONTEXT_KEY, sessions.size > 0);
  await vscode.commands.executeCommand('setContext', LOADING_CONTEXT_KEY, session?.discoveryCts !== undefined);
  await vscode.commands.executeCommand('setContext', READY_CONTEXT_KEY, [...sessions.values()].some(item => item.knownTests !== undefined && item.discoveryCts === undefined));
  await updateViewState();
}

// Parsing the runsettings XML on every view refresh is wasted work: refreshes
// fire several times a second during a run. Cache by file identity + overrides.
const runsettingsViewCache = new Map<string, { signature: string; view: CustomRunsettingsViewState }>();
let viewStateSequence = 0;

async function inspectRunsettingsCached(
  session: SolutionSession,
  base: string,
  permanent: PermanentRunsettingsConfig
): Promise<CustomRunsettingsViewState> {
  let identity = 'missing';
  try {
    const stat = await fs.promises.stat(base);
    identity = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // Unreadable: inspectRunsettings reports the error below.
  }
  const signature = `${base}|${identity}|${JSON.stringify(session.customRunsettings)}|${JSON.stringify(permanent)}`;
  const cached = runsettingsViewCache.get(session.key);
  if (cached && cached.signature === signature) {
    return cached.view;
  }
  const view = await inspectRunsettings(base, session.customRunsettings, permanent);
  runsettingsViewCache.set(session.key, { signature, view });
  return view;
}

interface ApiRunsettingsPayload {
  base: { available: boolean; path?: string; defaultPath?: string; isDefault: boolean; hasExplicit: boolean; defaultAvailable: boolean };
  view: CustomRunsettingsViewState;
  candidates: string[];
}

/** Runsettings state for one solution, shaped for the web dashboard's modal. */
async function apiRunsettings(session: SolutionSession): Promise<ApiRunsettingsPayload> {
  const base = getActiveRunsettings(session);
  const permanent = getPermanentOverrides(session);
  const defaultPath = findDefaultRunsettingsCached(session.solutionPath);
  let view: CustomRunsettingsViewState;
  if (base && fs.existsSync(base)) {
    try {
      view = await inspectRunsettingsCached(session, base, permanent);
    } catch (err) {
      view = unavailableRunsettingsView(session, permanent, err instanceof Error ? err.message : String(err));
    }
  } else {
    view = unavailableRunsettingsView(session, permanent, 'No runsettings file found next to the solution.');
  }
  return {
    base: {
      available: base !== undefined,
      path: base,
      defaultPath,
      isDefault: session.runsettingsPath === undefined && base !== undefined,
      hasExplicit: session.runsettingsPath !== undefined,
      defaultAvailable: defaultPath !== undefined
    },
    view,
    candidates: listRunsettingsCandidates(session)
  };
}

function unavailableRunsettingsView(session: SolutionSession, permanent: PermanentRunsettingsConfig, message: string): CustomRunsettingsViewState {
  return {
    available: false,
    values: [],
    parameters: [],
    customParameters: session.customRunsettings.parameters,
    permanentValues: [],
    permanentParameters: [],
    unresolved: [message],
    hasCustomizations: hasCustomRunsettings(session.customRunsettings) || hasPermanentRunsettings(permanent)
  };
}

function listRunsettingsCandidates(session: SolutionSession): string[] {
  const dir = path.dirname(session.solutionPath);
  try {
    return fs.readdirSync(dir)
      .filter(name => name.toLowerCase().endsWith('.runsettings'))
      .sort()
      .map(name => path.join(dir, name));
  } catch {
    return [];
  }
}

async function apiApplyRunsettings(
  context: vscode.ExtensionContext,
  session: SolutionSession,
  action: ControlApiRunsettingsAction
): Promise<ApiRunsettingsPayload> {
  switch (action.action) {
    case 'selectFile':
      await applyRunsettingsPath(context, session, action.path);
      break;
    case 'setValue':
      await setCustomRunsettingsValue(context, action.key, action.value, session);
      break;
    case 'resetValue':
      await resetCustomRunsettingsValue(context, action.key, session);
      break;
    case 'lockValue':
      await toggleLockCustomRunsettingsValue(context, action.key, action.isPermanent, session);
      break;
    case 'addParameter':
      await addCustomRunsettingsParameter(context, session);
      break;
    case 'updateParameter': {
      const error = await updateCustomRunsettingsParameter(context, action.id, action.field, action.value, session);
      if (error) {
        throw new ControlApiError(400, error);
      }
      break;
    }
    case 'removeParameter':
      await removeCustomRunsettingsParameter(context, action.id, session);
      break;
    case 'lockParameter':
      await toggleLockCustomRunsettingsParameter(context, action.id, action.isPermanent, session);
      break;
  }
  return apiRunsettings(session);
}

async function updateViewState(): Promise<void> {
  const sequence = ++viewStateSequence;
  const session = activeSession();
  const selectedKey = activeSessionKey;
  let customView: CustomRunsettingsViewState | undefined;
  const base = session && getActiveRunsettings(session);
  const permanent = getPermanentOverrides(session);
  if (base) {
    try {
      customView = await inspectRunsettingsCached(session, base, permanent);
    } catch (err) {
      customView = {
        available: false,
        values: [],
        parameters: [],
        customParameters: session.customRunsettings.parameters,
        permanentValues: [],
        permanentParameters: [],
        unresolved: [err instanceof Error ? err.message : String(err)],
        hasCustomizations: hasCustomRunsettings(session.customRunsettings) || hasPermanentRunsettings(permanent)
      };
    }
  }
  // Inspecting a runsettings file is asynchronous; do not publish stale data
  // after the user has switched to another solution tab, or when a newer
  // refresh started meanwhile (it will publish fresher state itself).
  if (selectedKey !== activeSessionKey || sequence !== viewStateSequence) {
    return;
  }
  mainView.setState({
    sessions: [...sessions.values()].map(item => ({ key: item.key, label: path.basename(item.solutionPath, path.extname(item.solutionPath)), detail: item.solutionPath, ready: item.knownTests !== undefined && item.discoveryCts === undefined, loading: item.discoveryCts !== undefined, testCount: item.knownTests?.size, discoveredCount: item.discoveredCount })),
    activeSessionKey,
    solutionReady: session?.knownTests !== undefined && session.discoveryCts === undefined,
    playlistPath: session?.playlistPath,
    runsettingsPath: base,
    runsettingsIsDefault: !!session && session.runsettingsPath === undefined && base !== undefined,
    defaultRunsettingsAvailable: !!session && findDefaultRunsettingsCached(session.solutionPath) !== undefined,
    hasExplicitRunsettings: session?.runsettingsPath !== undefined,
    filter: session?.activeFilter?.raw ?? '',
    visibleTestCount: session ? entriesForSession(session).length : undefined,
    searchAllSolutions,
    resultFilter: session?.testResultFilter ?? createDefaultTestResultFilter(),
    notFoundTests: session?.notFoundTests ?? [],
    customRunsettings: customView,
    skipPreBreakpoint: vscode.workspace.getConfiguration('dotnetTestingPlus').get<boolean>('skipPreBreakpoint', true),
    controlApiEnabled: controlApiSessionEnabled || vscode.workspace.getConfiguration('dotnetTestingPlus').get<boolean>('controlApiEnabled', false),
    controlApi: apiCoordinator?.state,
    controlApiUrl: apiCoordinator?.state.port !== undefined && apiCoordinator.state.sessionId
      ? `http://localhost:${apiCoordinator.state.port}/${encodeURIComponent(apiCoordinator.state.sessionId)}/`
      : undefined,
    screenshotEmpty: screenshotWouldBeBlank()
  });
  // Same dedupe as mainView.postState: refreshes fire several times a second
  // during a run but rarely change the state. New /events clients receive the
  // current state on connect, so skipping an identical push loses nothing.
  if (apiCoordinator) {
    const state = controlApiState();
    const serialized = JSON.stringify(state);
    if (serialized !== lastBroadcastState) {
      lastBroadcastState = serialized;
      apiCoordinator.broadcast(ControlApiSseEvent.State, state);
    }
    // Registration is comparatively chatty, so only re-push when the solution
    // inventory (what other windows can see) actually changes.
    const signature = state.solutions.map(s => `${s.id}:${s.testCount ?? -1}:${s.loading ? 1 : 0}`).join('|');
    if (signature !== lastSolutionsSignature) {
      lastSolutionsSignature = signature;
      apiCoordinator.refreshSolutions();
    }
  }
}

async function navigateToFailureLocation(item: vscode.TestItem | undefined, target: 'callSite' | 'innermostError'): Promise<void> {
  if (!item) {
    return;
  }
  const locations = failureLocations.get(item.id);
  const location = target === 'callSite'
    ? (locations?.callSite ?? locations?.innermostError)
    : (locations?.innermostError ?? locations?.callSite);

  const finalLoc = location ?? (item.uri && item.range ? new vscode.Location(item.uri, item.range) : undefined);
  if (!finalLoc) {
    void vscode.window.showInformationMessage('No failure location available for this test.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(finalLoc.uri);
  await vscode.window.showTextDocument(doc, {
    selection: finalLoc.range,
    preview: false
  });
}

// Exposed only for lightweight Node harnesses.
export const __testItemIdForTest = testItemId;
