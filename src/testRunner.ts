import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { XMLParser } from 'fast-xml-parser';
import { log, logCommand, logChunk, setRunCapture } from './logger';
import { killProcessTree, spawnTracked } from './processTree';
import { SourceLocation } from './sourceScan';
import { TestResultState } from './testResultFilter';
import { collectProjectCoverage, CoverageState, newCoverageState } from './coverage';
import { checkBuild, getBuildStamp, markBuildClean, markBuildDirty } from './buildState';
import { summarizeBuildInputs } from './buildInputs';
import { CaptureKind, CaptureStatus, RunCapture, RunDiagnosticsStore } from './runDiagnostics';
import { asArray } from './util';

/**
 * Upper bound for a single `--filter` argument. Windows caps a whole command
 * line at 32,767 chars and Linux caps a single argument at 128 KB; 30,000
 * chars stays safely under both. Tests are batched so no batch's filter
 * exceeds this.
 */
const FILTER_ARG_LIMIT = 30000;

interface TrxResult {
  fqn: string;
  outcome: string;
  message?: string;
  stackTrace?: string;
  durationMs?: number;
}

export interface TestFailureLocations {
  callSite?: vscode.Location;
  innermostError?: vscode.Location;
}

export interface TestDescriptor {
  fullyQualifiedName: string;
  solutionPath: string;
  projectPath?: string;
  location?: SourceLocation;
}

export interface SolutionRunOptions {
  solutionPath: string;
  runsettingsPath?: string;
}

interface RunOptions {
  runsettingsPath?: string;
  /** Solution owning the tests being run; recorded in run diagnostics. */
  solutionPath?: string;
  /** Durable diagnostics store; undefined leaves artifacts unstaged. */
  diagnostics?: RunDiagnosticsStore;
  /** Where generated solution filters live; undefined always builds the whole solution. */
  slicesDir?: string;
  locations?: Map<string, SourceLocation>;
  /** FQN -> owning .csproj path. When provided, tests are run per project. */
  projects?: Map<string, string>;
  /** Directory containing Playlist.TestLogger.dll; enables live per-test results. */
  loggerDir?: string;
  /** Collect Cobertura coverage for every executed test. */
  coverage?: boolean;
  /** Per-run accumulator shared across solutions; survives the options spread. */
  coverageState?: CoverageState;
  /** Test item ID -> solution-specific test metadata. */
  descriptors?: Map<string, TestDescriptor>;
  /** Auto-continue past the test host's initial Debugger.Break() when debugging. */
  skipPreBreakpoint?: boolean;
  onTestStateChange?: (test: vscode.TestItem, state: TestResultState, durationMs?: number) => void;
  onTestFailureLocations?: (test: vscode.TestItem, locations: TestFailureLocations) => void;
}

function appendOutput(run: vscode.TestRun, text: string): void {
  run.appendOutput(text.replace(/\r?\n/g, '\r\n'));
}

function setTestState(options: RunOptions | undefined, test: vscode.TestItem, state: TestResultState, durationMs?: number): void {
  options?.onTestStateChange?.(test, state, durationMs);
}

function skipTest(run: vscode.TestRun, test: vscode.TestItem, options?: RunOptions): void {
  setTestState(options, test, 'skipped');
  run.skipped(test);
}

/**
 * Resolve a run request to the leaf tests to execute. `request.exclude` may
 * contain whole subtrees (VS Code excludes the top-most hidden nodes when the
 * explorer is filtered, e.g. "Show only failed tests"), so exclusion is
 * checked before recursing. Excluded tests are left untouched: they keep
 * their previous state and don't appear in the run.
 */
function collectTestsToRun(controller: vscode.TestController, request: vscode.TestRunRequest): vscode.TestItem[] {
  const tests: vscode.TestItem[] = [];
  const excluded = new Set(request.exclude ?? []);

  const enqueue = (item: vscode.TestItem): void => {
    if (excluded.has(item)) {
      return;
    }
    if (item.children.size > 0) {
      item.children.forEach(enqueue);
      return;
    }
    tests.push(item);
  };

  if (request.include && request.include.length > 0) {
    request.include.forEach(enqueue);
  } else {
    controller.items.forEach(enqueue);
  }
  return tests;
}

export async function runPlaylistTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  debug: boolean,
  solutions: ReadonlyMap<string, SolutionRunOptions>,
  options?: RunOptions
): Promise<void> {
  const run = controller.createTestRun(request);
  const coverageState = options?.coverage ? newCoverageState() : undefined;
  const runOptions: RunOptions | undefined = options ? { ...options, coverageState } : options;
  // Two UI cancel paths exist: the Test Explorer's cancel fires the profile
  // handler token, while the Test Results view's cancel only fires the
  // TestRun's own token (it cancels a single task). Honor both.
  const cancel = new vscode.CancellationTokenSource();
  const cancelSubs = [
    token.onCancellationRequested(() => cancel.cancel()),
    run.token.onCancellationRequested(() => cancel.cancel())
  ];
  try {
    const tests = collectTestsToRun(controller, request);

    const { groups: bySolution, unassigned } = groupTestsBySolution(tests, solutions, runOptions);
    unassigned.forEach(test => skipTest(run, test, runOptions));
    // Map insertion order follows the requested tree order, so all work for a
    // solution completes before the next solution is built or run.
    for (const [solutionPath, solutionTests] of bySolution) {
      if (cancel.token.isCancellationRequested) {
        solutionTests.forEach(test => skipTest(run, test, runOptions));
        continue;
      }
      const solution = solutions.get(solutionPath)!;
      await runSolutionTests(solutionTests, solution, run, cancel.token, debug, runOptions);
    }
  } catch (err) {
    // A cancelled run rejects the in-flight build/chunk promises; that's
    // expected, not an error to surface. Real failures still propagate.
    if (cancel.token.isCancellationRequested) {
      log('Test run cancelled');
    } else {
      throw err;
    }
  } finally {
    for (const file of coverageState?.files ?? []) {
      run.addCoverage(file);
    }
    run.end();
    cancelSubs.forEach(sub => sub.dispose());
    cancel.dispose();
  }
}

function descriptorFor(test: vscode.TestItem, options?: RunOptions): TestDescriptor | undefined {
  const descriptor = options?.descriptors?.get(test.id);
  if (descriptor) {
    return descriptor;
  }
  // Retain the original item-ID-as-FQN behavior for older harnesses.
  return undefined;
}

function groupTestsBySolution(
  tests: readonly vscode.TestItem[],
  solutions: ReadonlyMap<string, SolutionRunOptions>,
  options?: RunOptions
): { groups: Map<string, vscode.TestItem[]>; unassigned: vscode.TestItem[] } {
  const groups = new Map<string, vscode.TestItem[]>();
  const unassigned: vscode.TestItem[] = [];
  for (const test of tests) {
    const descriptor = descriptorFor(test, options);
    if (!descriptor || !solutions.has(descriptor.solutionPath)) {
      unassigned.push(test);
      continue;
    }
    const group = groups.get(descriptor.solutionPath) ?? [];
    group.push(test);
    groups.set(descriptor.solutionPath, group);
  }
  return { groups, unassigned };
}

function fqnFilter(tests: readonly vscode.TestItem[], options?: RunOptions): string {
  return tests.map(test => filterEntryFor(test, options)).join('|');
}

function filterEntryFor(test: vscode.TestItem, options?: RunOptions): string {
  return `FullyQualifiedName=${descriptorFor(test, options)?.fullyQualifiedName ?? test.id}`;
}

/** A batch of tests plus the prepared `--filter` expression for its invocation. */
interface TestBatch {
  tests: vscode.TestItem[];
  filter: string;
}

/**
 * Batch tests so that no `dotnet test` invocation's `--filter` argument
 * approaches the OS argument-length limit. Typical projects fit in one batch
 * (one process, live results, no per-invocation startup overhead); only very
 * large selections split across invocations. The filter is built here so the
 * invocation does not recompute the same strings.
 */
function batchByFilterLength(
  tests: readonly vscode.TestItem[],
  options?: RunOptions
): TestBatch[] {
  const batches: TestBatch[] = [];
  let current: vscode.TestItem[] = [];
  let entries: string[] = [];
  let length = 0;
  for (const test of tests) {
    const entry = filterEntryFor(test, options);
    if (current.length > 0 && length + entry.length + 1 > FILTER_ARG_LIMIT) {
      batches.push({ tests: current, filter: entries.join('|') });
      current = [];
      entries = [];
      length = 0;
    }
    current.push(test);
    entries.push(entry);
    length += entry.length + 1;
  }
  if (current.length > 0) {
    batches.push({ tests: current, filter: entries.join('|') });
  }
  return batches;
}

async function runSolutionTests(
  tests: vscode.TestItem[],
  solution: SolutionRunOptions,
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  debug: boolean,
  options?: RunOptions
): Promise<void> {
  const groups = new Map<string, vscode.TestItem[]>();
  const unmapped: vscode.TestItem[] = [];
  for (const test of tests) {
    const descriptor = descriptorFor(test, options);
    const csproj = descriptor?.projectPath ?? options?.projects?.get(descriptor?.fullyQualifiedName ?? test.id);
    if (!csproj) {
      unmapped.push(test);
      continue;
    }
    const group = groups.get(csproj) ?? [];
    group.push(test);
    groups.set(csproj, group);
  }
  if (unmapped.length > 0) {
    const message = `Skipping ${unmapped.length} test(s) with no owning project mapping.`;
    log(message);
    appendOutput(run, message + '\n');
    unmapped.forEach(test => skipTest(run, test, options));
  }
  if (groups.size === 0) {
    return;
  }
  const projectPaths = [...groups.keys()];
  const solutionOptions: RunOptions = {
    ...options,
    solutionPath: solution.solutionPath,
    runsettingsPath: solution.runsettingsPath
  };
  try {
    const state = await checkBuild(solution.solutionPath, projectPaths, BUILD_CONFIGURATION);
    if (state === 'current') {
      const message = `Skipping build (nothing changed since the last build): ${solution.solutionPath}`;
      log(message);
      appendOutput(run, message + '\n');
    } else {
      // A coverage-only miss means the previous build's inputs are still valid,
      // so the projects it already covered stay covered.
      const previous = state === 'coverage' ? getBuildStamp(solution.solutionPath)?.projects : undefined;
      const builtAt = Date.now();
      const { fullSolution } = await buildSolutionOnce(
        solution.solutionPath,
        projectPaths,
        run,
        token,
        options?.diagnostics,
        options?.slicesDir
      );
      const summary = await summarizeBuildInputs(solution.solutionPath);
      if (summary) {
        const built = projectPaths.map(project => path.resolve(project));
        markBuildClean(solution.solutionPath, {
          ...summary,
          builtAt,
          projects: fullSolution ? null : [...new Set([...(previous ?? []), ...built])],
          configuration: BUILD_CONFIGURATION
        });
      } else {
        markBuildDirty(solution.solutionPath);
      }
    }
  } catch (err) {
    if (token.isCancellationRequested) {
      throw err;
    }
    // A broken build only affects this solution; report it on its tests and
    // let the remaining solutions in the request run.
    const message = err instanceof Error ? err.message : String(err);
    log(`[error] ${path.basename(solution.solutionPath)}: ${message}`);
    appendOutput(run, `${message}\n`);
    for (const projectTests of groups.values()) {
      for (const test of projectTests) {
        setTestState(solutionOptions, test, 'failed');
        run.errored(test, new vscode.TestMessage(message));
      }
    }
    return;
  }
  for (const [csproj, projectTests] of groups) {
    if (token.isCancellationRequested) {
      projectTests.forEach(test => skipTest(run, test, solutionOptions));
      continue;
    }
    for (const batch of batchByFilterLength(projectTests, solutionOptions)) {
      if (token.isCancellationRequested) {
        batch.tests.forEach(test => skipTest(run, test, solutionOptions));
        continue;
      }
      await runChunk(csproj, batch.tests, run, token, debug, solutionOptions, true, batch.filter);
    }
    if (solutionOptions.coverageState) {
      solutionOptions.coverageState.files.push(
        ...await collectProjectCoverage(csproj, solutionOptions.coverageState)
      );
    }
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[a-zA-Z]/g;
const RESULTS_FILE_LINE_RE = /Results File:\s*(.+?\.trx)/i;

interface LiveContext {
  run: vscode.TestRun;
  options?: RunOptions;
  /** Staged diagnostics for this chunk; also the only sink for its raw output. */
  capture?: RunCapture;
  tests: vscode.TestItem[];
  /** Aggregated outcome per test id (having an entry means it was reported); see {@link outcomeRank}. */
  outcomes: Map<string, string>;
  /** Lazily built FQN -> test items index. */
  index?: Map<string, vscode.TestItem[]>;
  /** TRX paths announced on stdout. */
  trxFiles: string[];
  /** TRX paths already parsed successfully (never parsed twice). */
  parsedTrx: Set<string>;
  /** Sequential chain of pending TRX parses; outcomes apply in TRX arrival order. */
  trxQueue: Promise<void>;
  /** Flush the stream-logger tail; set while a tailer is active. */
  drainStream?: () => void;
}

function createLiveContext(
  run: vscode.TestRun,
  options: RunOptions | undefined,
  tests: vscode.TestItem[],
  capture?: RunCapture
): LiveContext {
  return {
    run,
    options,
    tests,
    capture,
    outcomes: new Map<string, string>(),
    trxFiles: [],
    parsedTrx: new Set<string>(),
    trxQueue: Promise.resolve()
  };
}

interface FailureInfo {
  message?: string;
  stackTrace?: string;
}

// .NET stack trace frames:
//   "   at Namespace.Class.Method(args) in /path/File.cs:line 42"   (POSIX/WSL)
//   "   at Namespace.Class.Method(args) in C:\path\File.cs:line 42" (Windows)
// The file part is greedy so drive letters and colons in paths are preserved.
const STACK_FRAME_RE = /^\s*at\s+(.+?)\s+in\s+(.+):line\s+(\d+)\s*$/;
const STACK_LABEL_RE = /^\s*at\s+(.+?)\s*$/;

/**
 * Parse a .NET stack trace into clickable frames. Frames without file info
 * (framework code compiled without PDBs) keep their label only. Separator
 * lines like "--- End of stack trace from previous location ---" are skipped.
 */
function parseStackTrace(stackTrace: string): vscode.TestMessageStackFrame[] {
  const frames: vscode.TestMessageStackFrame[] = [];
  for (const rawLine of stackTrace.split(/\r?\n/)) {
    const withFile = STACK_FRAME_RE.exec(rawLine);
    if (withFile) {
      const lineNo = Math.max(0, Number(withFile[3]) - 1);
      frames.push(
        new vscode.TestMessageStackFrame(
          withFile[1],
          vscode.Uri.file(withFile[2]),
          new vscode.Position(lineNo, 0)
        )
      );
      continue;
    }
    const labelOnly = STACK_LABEL_RE.exec(rawLine);
    if (labelOnly) {
      frames.push(new vscode.TestMessageStackFrame(labelOnly[1]));
    }
  }
  return frames;
}

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, '/').toLowerCase();
}

function findCallSiteFrame(
  frames: vscode.TestMessageStackFrame[],
  testDeclLocation: SourceLocation | undefined,
  testFqn: string
): vscode.TestMessageStackFrame | undefined {
  if (testDeclLocation?.file) {
    const normDeclFile = normalizeFilePath(testDeclLocation.file);
    const frameInDeclFile = frames.find(f => f.uri && normalizeFilePath(f.uri.fsPath) === normDeclFile);
    if (frameInDeclFile) {
      return frameInDeclFile;
    }
  }

  // Fallback: match by class/method name from FQN against stack frame labels
  const lastDot = testFqn.lastIndexOf('.');
  const classOrMethod = lastDot === -1 ? testFqn : testFqn.slice(0, lastDot);
  const bareMethod = lastDot === -1 ? testFqn : testFqn.slice(lastDot + 1);

  return frames.find(f => {
    if (!f.uri) {
      return false;
    }
    const label = f.label;
    return label.includes(testFqn) || (label.includes(bareMethod) && label.includes(classOrMethod));
  });
}

/**
 * Data-driven tests (MSTest DataRow, xUnit Theory, NUnit TestCase) emit one
 * result per row, all mapping to the same test item. Aggregate them so the
 * worst outcome wins: Failed > Passed > anything else (skipped/not executed).
 */
function outcomeRank(outcome: string): number {
  return outcome === 'Failed' ? 3 : outcome === 'Passed' ? 2 : 1;
}

function reportOutcome(
  ctx: LiveContext,
  test: vscode.TestItem,
  outcome: string,
  durationMs?: number,
  failure?: FailureInfo
): void {
  const previous = ctx.outcomes.get(test.id);
  if (previous !== undefined && outcomeRank(outcome) <= outcomeRank(previous)) {
    return;
  }
  ctx.outcomes.set(test.id, outcome);
  switch (outcome) {
    case 'Passed':
      setTestState(ctx.options, test, 'passed', durationMs);
      ctx.run.passed(test, durationMs);
      break;
    case 'Failed': {
      setTestState(ctx.options, test, 'failed', durationMs);
      const message = new vscode.TestMessage(failure?.message ?? 'Test failed');
      const frames = failure?.stackTrace ? parseStackTrace(failure.stackTrace) : [];
      if (frames.length > 0) {
        message.stackTrace = frames;
      }
      const descriptor = descriptorFor(test, ctx.options);
      const testDeclLoc = descriptor?.location ?? ctx.options?.locations?.get(test.id);
      const testFqn = descriptor?.fullyQualifiedName ?? test.id;
      const topFrame = frames.find(f => f.uri !== undefined && f.position !== undefined);
      const callSiteFrame = findCallSiteFrame(frames, testDeclLoc, testFqn);

      const innermostLoc = topFrame?.uri && topFrame.position
        ? new vscode.Location(topFrame.uri, new vscode.Range(topFrame.position, topFrame.position))
        : (testDeclLoc ? new vscode.Location(vscode.Uri.file(testDeclLoc.file), new vscode.Range(testDeclLoc.line - 1, 0, testDeclLoc.line - 1, 0)) : undefined);

      const callSiteLoc = callSiteFrame?.uri && callSiteFrame.position
        ? new vscode.Location(callSiteFrame.uri, new vscode.Range(callSiteFrame.position, callSiteFrame.position))
        : innermostLoc;

      if (ctx.options?.onTestFailureLocations) {
        ctx.options.onTestFailureLocations(test, {
          callSite: callSiteLoc,
          innermostError: innermostLoc
        });
      }

      // Point at the call site within the test method, falling back to innermost error or test declaration
      if (callSiteLoc) {
        message.location = callSiteLoc;
      } else if (innermostLoc) {
        message.location = innermostLoc;
      }
      ctx.run.failed(test, message, durationMs);
      break;
    }
    default:
      skipTest(ctx.run, test, ctx.options);
      break;
  }
}

/**
 * Index the chunk's tests by FQN once, so each streamed/TRX result is an O(1)
 * lookup instead of a scan over every test in the batch.
 */
function ensureTestIndex(ctx: LiveContext): Map<string, vscode.TestItem[]> {
  if (!ctx.index) {
    const index = new Map<string, vscode.TestItem[]>();
    for (const test of ctx.tests) {
      const fqn = descriptorFor(test, ctx.options)?.fullyQualifiedName ?? test.id;
      const list = index.get(fqn);
      if (list) {
        list.push(test);
      } else {
        index.set(fqn, [test]);
      }
    }
    ctx.index = index;
  }
  return ctx.index;
}

/**
 * Tests a result belongs to. Data-driven results can carry their arguments
 * (`Ns.Class.Method(1,2)`); those map back to the bare `Ns.Class.Method` test.
 */
function testsForResult(ctx: LiveContext, resultFqn: string): readonly vscode.TestItem[] {
  const index = ensureTestIndex(ctx);
  const exact = index.get(resultFqn);
  if (exact) {
    return exact;
  }
  const paren = resultFqn.indexOf('(');
  return paren > 0 ? index.get(resultFqn.slice(0, paren)) ?? [] : [];
}

/**
 * Tests that reported a failing outcome in this chunk. Unreported tests are
 * skipped by the sweep rather than failed, so they do not count.
 */
function countFailures(ctx: LiveContext): number {
  let failed = 0;
  for (const outcome of ctx.outcomes.values()) {
    if (outcome === 'Failed') {
      failed += 1;
    }
  }
  return failed;
}

function reportResult(ctx: LiveContext, result: StreamedResult & { fqn: string; outcome: string }): void {
  for (const test of testsForResult(ctx, result.fqn)) {
    reportOutcome(ctx, test, result.outcome, result.durationMs, {
      message: result.message,
      stackTrace: result.stackTrace
    });
  }
}

/**
 * Report results for whichever chunk tests appear in this TRX. Tests without a
 * matching result are left unreported (their TRX may not have been written
 * yet); the end-of-run sweep marks leftovers as skipped.
 */
function reportMatchedResults(ctx: LiveContext, results: TrxResult[]): void {
  for (const result of results) {
    if (result.fqn && result.outcome) {
      reportResult(ctx, result);
    }
  }
}

interface StreamedResult {
  fqn?: string;
  outcome?: string;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
}

/**
 * Report a single JSONL line written by Playlist.TestLogger.dll. Matches the
 * streamed FQN to a chunk test exactly like the TRX sweep does.
 */
function reportStreamedLine(ctx: LiveContext, line: string): void {
  let result: StreamedResult;
  try {
    result = JSON.parse(line) as StreamedResult;
  } catch {
    return;
  }
  if (!result || !result.fqn || !result.outcome) {
    return;
  }
  reportResult(ctx, { ...result, fqn: result.fqn, outcome: result.outcome });
}

/**
 * Tail the JSONL file written by Playlist.TestLogger.dll so results are
 * reported the moment each test finishes. Returns an idempotent stop function
 * that drains any remaining content and closes the file. The drain function is
 * also published on the context so the `Results File:` handler can flush the
 * stream before deciding whether the TRX needs to be parsed at all.
 */
function startStreamTailer(filePath: string, ctx: LiveContext): () => void {
  let offset = 0;
  let pending = '';
  let fd: number | undefined;
  let stopped = false;
  // Reads can end mid-way through a multi-byte character.
  const decoder = new StringDecoder('utf8');

  const drain = (): void => {
    try {
      if (fd === undefined) {
        if (!fs.existsSync(filePath)) {
          return;
        }
        fd = fs.openSync(filePath, 'r');
      }
      const size = fs.fstatSync(fd).size;
      if (size <= offset) {
        return;
      }
      const buffer = Buffer.alloc(size - offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      pending += decoder.write(buffer.subarray(0, read));
      // Walk the buffer with an index and cut it once, not once per line.
      let start = 0;
      let idx: number;
      while ((idx = pending.indexOf('\n', start)) >= 0) {
        const line = pending.slice(start, idx).replace(/\r$/, '').replace(/^\uFEFF/, '');
        start = idx + 1;
        if (line.length > 0) {
          try {
            reportStreamedLine(ctx, line);
          } catch (err) {
            log(`[error] could not report streamed result: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      pending = pending.slice(start);
    } catch {
      // file may not exist yet or be mid-write; the next tick retries
    }
  };

  ctx.drainStream = drain;
  const timer = setInterval(drain, 500);
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    drain();
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    ctx.drainStream = undefined;
  };
}

function processLine(ctx: LiveContext, rawLine: string, resultFiles: string[]): void {
  if (!rawLine.includes('.trx')) {
    return;
  }
  const line = rawLine.replace(ANSI_RE, '');
  const fileMatch = RESULTS_FILE_LINE_RE.exec(line);
  if (!fileMatch) {
    return;
  }
  const trxPath = fileMatch[1].trim();
  resultFiles.push(trxPath);
  ctx.trxFiles.push(trxPath);
  // The stream logger writes every result before the TRX exists, so flush it
  // first; when it already covered every test the TRX needs no parsing.
  ctx.drainStream?.();
  if (ctx.outcomes.size >= ctx.tests.length) {
    return;
  }
  // The TRX is fully written by the time this line is printed; parse it
  // immediately so results show up as each test project finishes. The parse
  // is async (multi-MB read) and chained onto the queue so outcomes apply in
  // TRX arrival order without blocking the stdout handler.
  ctx.trxQueue = ctx.trxQueue
    .then(async () => {
      reportMatchedResults(ctx, await readTrxResults(trxPath));
      ctx.parsedTrx.add(trxPath);
    })
    .catch(() => {
      // The file may still be locked; the end-of-run sweep retries it.
    });
}

interface LineFeeder {
  feed: (text: string) => void;
  flush: () => void;
}

function createLineFeeder(ctx: LiveContext, resultFiles: string[]): LineFeeder {
  let buffer = '';
  return {
    feed: (text: string): void => {
      buffer += text;
      let start = 0;
      let idx: number;
      while ((idx = buffer.indexOf('\n', start)) >= 0) {
        const line = buffer.slice(start, idx).replace(/\r$/, '');
        start = idx + 1;
        processLine(ctx, line, resultFiles);
      }
      buffer = buffer.slice(start);
    },
    flush: (): void => {
      const line = buffer.trim();
      buffer = '';
      if (line.length > 0) {
        processLine(ctx, line, resultFiles);
      }
    }
  };
}

// Both build and test pass the configuration explicitly: a solution build
// gets `Configuration=Debug` from the generated solution metaproj, but a
// standalone `dotnet test <csproj>` never does — and MES-style
// Directory.Build.props consume `$(Configuration)` during the props phase
// (before the common targets default it to Debug), so without an explicit
// value the output path bakes to a flat `bin/` the build never populated
// ("The argument <dll> is invalid"). Build and test must always agree.
export const BUILD_CONFIGURATION = 'Debug';

export type BuildOutput = (text: string, stream: 'stdout' | 'stderr') => void;

/**
 * Environment for spawned `dotnet` processes. The first-run banner and
 * telemetry are pure startup cost, and neither belongs in a test run's output.
 */
function dotnetEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...extra };
}

/** How much of a failed build's output is inspected to classify the failure. */
const BUILD_OUTPUT_TAIL_CHARS = 4000;
/**
 * A build without an implicit restore fails this way when the assets in `obj/`
 * are missing or stale (branch switch, cleared NuGet cache, new project, or
 * assets written by a different OS with foreign package folders). That is the
 * only case worth paying for a restore.
 */
const MISSING_ASSETS_RE = /NETSDK1004|project\.assets\.json[^\n]*not found|Run a NuGet package restore|Unable to find fallback package folder/i;

interface BuildAttempt {
  exitCode: number;
  /** Tail of the combined output, for classifying a failure. */
  outputTail: string;
}

/**
 * Runs `dotnet build` for `target` (a solution or a generated solution filter),
 * resolving the SDK and NuGet configuration from `buildCwd`. `onOutput` receives
 * raw stdout/stderr chunks as the process emits them.
 *
 * Builds run with `--no-restore`: a restore that has nothing to do still costs
 * several seconds on a large solution (measured ~6.5 s of a 23 s no-change
 * build). Only a genuine "assets are missing/stale" failure is retried with the
 * implicit restore, so normal runs never pay for it and stale assets still work.
 */
async function buildTarget(
  target: string,
  buildCwd: string,
  token: vscode.CancellationToken,
  onOutput: BuildOutput
): Promise<void> {
  const restoreArgs = ['build', target, '-c', BUILD_CONFIGURATION, '--nologo', '--tl:off', '-v', 'q'];
  const attempt = await runBuild(restoreArgs.concat('--no-restore'), target, buildCwd, token, onOutput);
  if (attempt.exitCode === 0) {
    return;
  }
  if (token.isCancellationRequested || !MISSING_ASSETS_RE.test(attempt.outputTail)) {
    throw new Error(`dotnet build failed with exit code ${attempt.exitCode}`);
  }
  log('[build] assets are missing or stale: retrying with an implicit restore');
  onOutput('Restore assets are missing or stale; retrying the build with an implicit restore.\n', 'stdout');
  const retry = await runBuild(restoreArgs, target, buildCwd, token, onOutput);
  if (retry.exitCode !== 0) {
    throw new Error(`dotnet build failed with exit code ${retry.exitCode}`);
  }
}

/** Runs `dotnet build` for a solution (the whole thing). */
export function buildSolution(
  solutionPath: string,
  token: vscode.CancellationToken,
  onOutput: BuildOutput
): Promise<void> {
  return buildTarget(solutionPath, path.dirname(solutionPath), token, onOutput);
}

function runBuild(
  args: string[],
  target: string,
  buildCwd: string,
  token: vscode.CancellationToken,
  onOutput: BuildOutput
): Promise<BuildAttempt> {
  logCommand('dotnet', args);
  onOutput(`Building ${target}\n`, 'stdout');
  return new Promise((resolve, reject) => {
    // The SDK and NuGet configuration are resolved from the working directory,
    // so it must be the solution's, not the extension host's (nor the slice's).
    const child: ChildProcess = spawnTracked('dotnet', args, {
      cwd: buildCwd,
      env: dotnetEnv()
    });
    let outputTail = '';
    const record = (text: string, stream: 'stdout' | 'stderr'): void => {
      outputTail = (outputTail + text).slice(-BUILD_OUTPUT_TAIL_CHARS);
      onOutput(text, stream);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const cancelSub = token.onCancellationRequested(() => {
      log('[cancel] dotnet build cancelled');
      killProcessTree(child);
      reject(new Error('Build cancelled'));
    });
    child.stdout?.on('data', (text: string) => record(text, 'stdout'));
    child.stderr?.on('data', (text: string) => record(text, 'stderr'));
    child.on('error', err => {
      cancelSub.dispose();
      log(`[error] dotnet build failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', code => {
      cancelSub.dispose();
      resolve({ exitCode: code ?? 1, outputTail });
    });
    if (token.isCancellationRequested) {
      cancelSub.dispose();
      killProcessTree(child);
      reject(new Error('Build cancelled'));
    }
  });
}

/**
 * Builds the projects a run needs. A subset is built through a generated
 * solution filter, which keeps MSBuild's project graph and solution ordering
 * while skipping the projects that cannot affect these tests (measured 7-8 s
 * vs 14-20 s for the whole solution). Falls back to the whole solution when no
 * slice can be written.
 */
async function prepareBuildTarget(
  solutionPath: string,
  projects: readonly string[],
  slicesDir: string | undefined
): Promise<{ target: string; fullSolution: boolean }> {
  if (!slicesDir || projects.length === 0) {
    return { target: solutionPath, fullSolution: true };
  }
  const solutionDir = path.dirname(solutionPath);
  const relative = projects.map(project => path.relative(solutionDir, project).split(path.sep).join('/'));
  if (relative.some(project => project.startsWith('..'))) {
    // A project outside the solution's directory cannot be named by a filter.
    return { target: solutionPath, fullSolution: true };
  }
  try {
    const key = crypto.createHash('sha1').update([solutionPath, ...relative].join('\n')).digest('hex').slice(0, 12);
    const file = path.join(slicesDir, `slice-${key}.slnf`);
    const content = JSON.stringify({ solution: { path: solutionPath, projects: relative } }, null, 2) + '\n';
    await fs.promises.mkdir(slicesDir, { recursive: true });
    const existing = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
    if (existing !== content) {
      await fs.promises.writeFile(file, content);
    }
    return { target: file, fullSolution: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[build] cannot write a solution filter (${message}); building the whole solution`);
    return { target: solutionPath, fullSolution: true };
  }
}

/**
 * Build what a test run needs, capturing the output so a failed build keeps the
 * compiler output that explains it. A passing build is staged and then
 * discarded like a passing test run.
 */
async function buildSolutionOnce(
  solutionPath: string,
  projects: readonly string[],
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  diagnostics?: RunDiagnosticsStore,
  slicesDir?: string
): Promise<{ fullSolution: boolean }> {
  const { target, fullSolution } = await prepareBuildTarget(solutionPath, projects, slicesDir);
  const capture = diagnostics?.begin({
    kind: CaptureKind.Build,
    solutionPath,
    command: ['dotnet', 'build', target, '-c', BUILD_CONFIGURATION, '--nologo', '--tl:off', '-v', 'q', '--no-restore']
  });
  setRunCapture(capture);
  let status = CaptureStatus.Passed;
  try {
    await buildTarget(target, path.dirname(solutionPath), token, (text, stream) => {
      capture?.append(`${stream}.log`, text);
      appendOutput(run, text);
    });
  } catch (err) {
    status = token.isCancellationRequested ? CaptureStatus.Cancelled : CaptureStatus.Failed;
    throw err;
  } finally {
    setRunCapture(undefined);
    if (status === CaptureStatus.Failed) {
      capture?.addFailures(1);
    }
    const keep = status !== CaptureStatus.Passed;
    const retained = diagnostics?.settle(capture, status, keep);
    if (retained) {
      log(`Build diagnostics retained: ${retained}`);
    } else if (capture && keep) {
      // Losing the output of a failed build is exactly what retention exists to
      // prevent, so say when it could not be kept instead of failing silently.
      log('[error] build diagnostics could not be retained (see the diagnostics output for staging errors)');
    }
  }
  return { fullSolution };
}

async function runChunk(
  target: string,
  tests: vscode.TestItem[],
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  debug: boolean,
  options?: RunOptions,
  noBuild = false,
  preparedFilter?: string
): Promise<void> {
  tests.forEach(t => {
    setTestState(options, t, 'queued');
    run.enqueued(t);
  });

  const filter = preparedFilter ?? fqnFilter(tests, options);
  const args = ['test', target, '--filter', filter, '--nologo', '--logger', 'trx', '-c', BUILD_CONFIGURATION, '--tl:off'];
  if (noBuild) {
    args.push('--no-build');
  }
  const loggerDll = options?.loggerDir
    ? path.join(options.loggerDir, 'Playlist.TestLogger.dll')
    : undefined;
  const useStreamLogger = loggerDll !== undefined && fs.existsSync(loggerDll);
  if (useStreamLogger) {
    args.push('--logger', 'playliststream', '--test-adapter-path', options!.loggerDir!);
  }
  if (options?.coverage) {
    args.push('--collect', 'XPlat Code Coverage');
  }
  if (options?.runsettingsPath) {
    args.push('--settings', options.runsettingsPath);
  }

  // Diagnostics are staged (not retained) while the chunk runs: only a chunk
  // that does not pass is promoted, so green runs leave nothing behind.
  const diagnostics = options?.diagnostics;
  const capture = diagnostics?.begin({
    kind: CaptureKind.Tests,
    solutionPath: options?.solutionPath ?? target,
    projectPath: target,
    debug,
    command: ['dotnet', ...args]
  });
  setRunCapture(capture);
  let status = CaptureStatus.Passed;

  const ctx = createLiveContext(run, options, tests, capture);
  let resultFiles: string[] = [];
  const streamLogPath = useStreamLogger
    ? path.join(os.tmpdir(), `playlist-stream-${process.pid}-${Date.now()}-${crypto.randomUUID()}.jsonl`)
    : undefined;
  const stopTailer = streamLogPath ? startStreamTailer(streamLogPath, ctx) : undefined;

  tests.forEach(t => {
    setTestState(options, t, 'running');
    run.started(t);
  });

  try {
    resultFiles = debug
      ? await debugDotnetTest(args, path.dirname(target), run, token, ctx, streamLogPath)
      : await runDotnetTest(args, path.dirname(target), run, token, ctx, streamLogPath);
    stopTailer?.();
    // Pending TRX parses scheduled while streaming must settle before the
    // sweep decides what is left.
    await ctx.trxQueue;

    if (resultFiles.length === 0) {
      throw new Error('No test results were produced. Check the test output for build errors.');
    }

    log(`Collected ${resultFiles.length} TRX result file(s)`);
    // End-of-run sweep for TRX files that could not be parsed while streaming
    // (e.g. still locked). It is skipped entirely when every test already has
    // a result (the stream logger normally delivers them all), and a TRX that
    // was already read successfully is never parsed a second time.
    if (ctx.outcomes.size < ctx.tests.length) {
      for (const trxPath of resultFiles) {
        if (ctx.parsedTrx.has(trxPath)) {
          continue;
        }
        try {
          reportMatchedResults(ctx, await readTrxResults(trxPath));
          ctx.parsedTrx.add(trxPath);
        } catch {
          // ignore unreadable TRX; unmatched tests are marked skipped below
        }
      }
    }
    for (const test of ctx.tests) {
      if (!ctx.outcomes.has(test.id)) {
        skipTest(run, test, options);
      }
    }
  } catch (err) {
    status = token.isCancellationRequested ? CaptureStatus.Cancelled : CaptureStatus.Failed;
    // Let in-flight TRX parses report first; only tests with no outcome at
    // all are marked below.
    await ctx.trxQueue;
    const message = err instanceof Error ? err.message : String(err);
    for (const test of ctx.tests) {
      if (ctx.outcomes.has(test.id)) {
        continue;
      }
      if (token.isCancellationRequested) {
        skipTest(run, test, options);
      } else {
        setTestState(options, test, 'failed');
        run.errored(test, new vscode.TestMessage(message));
      }
    }
  } finally {
    stopTailer?.();
    // A run that did not pass keeps its full diagnostics (stdout, stderr, the
    // extension log lines, the stream-logger JSONL and every TRX). Cancellation
    // counts as non-passing: the output is usually why it was cancelled.
    const failedTests = countFailures(ctx);
    if (failedTests > 0) {
      status = status === CaptureStatus.Passed ? CaptureStatus.Failed : status;
      capture?.addFailures(failedTests);
    }
    const keep = status !== CaptureStatus.Passed;
    if (capture && keep) {
      if (streamLogPath) {
        capture.attach(streamLogPath, 'stream.jsonl');
      }
      let index = 0;
      for (const f of new Set([...resultFiles, ...ctx.trxFiles])) {
        index += 1;
        capture.attach(f, `results-${index}.trx`);
      }
    }
    setRunCapture(undefined);
    const retained = diagnostics?.settle(capture, status, keep);
    if (retained) {
      log(`Run diagnostics retained: ${retained}`);
    } else if (capture && keep) {
      log('[error] run diagnostics could not be retained (see the diagnostics output for staging errors)');
    }
    if (streamLogPath) {
      try {
        fs.rmSync(streamLogPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    // dotnet test writes the TRX next to the test project; clean up every one
    // we saw, including runs that errored or were cancelled before returning.
    // Retained runs keep a copy in the diagnostics directory instead.
    for (const f of new Set([...resultFiles, ...ctx.trxFiles])) {
      try {
        fs.rmSync(f, { force: true });
        // dotnet writes one GUID directory per run under TestResults; drop it
        // once empty so the directory does not accumulate (rmdir refuses when
        // anything else is still inside).
        fs.rmdirSync(path.dirname(f));
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Wait (bounded) for a child's stdout to finish draining after it exits. The
 * 'exit' event can precede the last buffered stdout chunk (which may carry the
 * `Results File:` line), while waiting for 'close' can hang forever when an
 * orphaned grandchild keeps the pipe open. A short cap covers both.
 */
function whenStdoutDrained(child: ChildProcess, callback: () => void): void {
  const stdout = child.stdout;
  if (!stdout || stdout.readableEnded || stdout.destroyed) {
    callback();
    return;
  }
  let done = false;
  const fire = (): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(fire, 1000);
  stdout.once('end', fire);
  stdout.once('close', fire);
  stdout.once('error', fire);
  child.once('close', fire);
}

function runDotnetTest(
  args: string[],
  cwd: string,
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  ctx: LiveContext,
  streamLogPath?: string
): Promise<string[]> {
  logCommand('dotnet', args);
  if (ctx.options?.runsettingsPath) {
    run.appendOutput(`Using runsettings: ${ctx.options.runsettingsPath}\n`);
  }
  return new Promise((resolve, reject) => {
    const resultFiles: string[] = [];
    const feeder = createLineFeeder(ctx, resultFiles);
    let sawStdout = false;
    const child: ChildProcess = spawnTracked('dotnet', args, {
      cwd,
      env: dotnetEnv(streamLogPath ? { PLAYLIST_STREAM_LOG: streamLogPath } : {})
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    // Dispose the listener when the child ends: the token is shared by every
    // chunk of the run, so stale listeners would otherwise pile up and fire
    // (against long-dead PIDs) on cancel.
    const cancelSub = token.onCancellationRequested(() => {
      log('[cancel] dotnet test run cancelled');
      killProcessTree(child);
    });

    child.stdout?.on('data', (text: string) => {
      sawStdout = true;
      logChunk(ctx.capture, 'stdout', text);
      appendOutput(run, text);
      feeder.feed(text);
    });
    child.stderr?.on('data', (text: string) => {
      logChunk(ctx.capture, 'stderr', text);
      appendOutput(run, text);
    });
    child.on('error', err => {
      cancelSub.dispose();
      log(`[error] dotnet test failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', code => {
      cancelSub.dispose();
      whenStdoutDrained(child, () => {
        feeder.flush();
        if (code !== 0 && !sawStdout) {
          reject(new Error(`dotnet test exited with code ${code}`));
        } else {
          resolve(resultFiles);
        }
      });
    });
    if (token.isCancellationRequested) {
      killProcessTree(child);
    }
  });
}

function debugDotnetTest(
  args: string[],
  cwd: string,
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  ctx: LiveContext,
  streamLogPath?: string
): Promise<string[]> {
  logCommand('dotnet', args, undefined, { VSTEST_HOST_DEBUG: '1' });
  if (ctx.options?.runsettingsPath) {
    run.appendOutput(`Using runsettings: ${ctx.options.runsettingsPath}\n`);
  }
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawnTracked('dotnet', args, {
      cwd,
      env: dotnetEnv({
        VSTEST_HOST_DEBUG: '1',
        ...(streamLogPath ? { PLAYLIST_STREAM_LOG: streamLogPath } : {})
      })
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const resultFiles: string[] = [];
    const feeder = createLineFeeder(ctx, resultFiles);
    const disposables: vscode.Disposable[] = [];
    let buffer = '';
    let attached = false;
    let settled = false;
    let debugSession: vscode.DebugSession | undefined;
    const settle = (err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      disposables.splice(0).forEach(d => d.dispose());
      if (err) {
        reject(err);
      } else {
        resolve(resultFiles);
      }
    };
    const track = (d: vscode.Disposable): void => {
      if (settled) {
        d.dispose();
      } else {
        disposables.push(d);
      }
    };

    track(token.onCancellationRequested(() => {
      killProcessTree(child);
      settle();
    }));

    child.stdout?.on('data', (text: string) => {
      logChunk(ctx.capture, 'stdout', text);
      appendOutput(run, text);
      feeder.feed(text);
      if (!attached) {
        buffer += text;
        if (buffer.length > 100000) {
          buffer = buffer.slice(-50000);
        }
        const match = /Process Id:\s*(\d+)/.exec(buffer);
        if (match) {
          attached = true;
          log(`Attaching debugger to process ${match[1]}`);
          attachDebugger(Number(match[1]), child, ctx.options?.skipPreBreakpoint ?? true, {
            track,
            onSession: session => {
              debugSession = session;
            },
            onTerminated: () => {
              debugSession = undefined;
              settle();
            }
          }).catch(err => {
            // An unhandled rejection here would leave the run hanging forever.
            const message = err instanceof Error ? err.message : String(err);
            log(`Debugger attach failed: ${message}`);
            killProcessTree(child);
            settle(new Error(`Could not start the debugger: ${message}`));
          });
        }
      }
    });

    child.stderr?.on('data', (text: string) => {
      logChunk(ctx.capture, 'stderr', text);
      appendOutput(run, text);
    });
    child.on('error', err => settle(err));
    // Settle when the process ends, attached or not: waiting only for the
    // debug session to terminate could hang if that event never arrives.
    child.on('exit', () => {
      whenStdoutDrained(child, () => {
        feeder.flush();
        if (debugSession) {
          void Promise.resolve(vscode.debug.stopDebugging(debugSession)).catch(() => undefined);
          debugSession = undefined;
        }
        settle();
      });
    });
  });
}

interface DebugAttachHooks {
  /** Register a disposable that is released when the run settles. */
  track: (disposable: vscode.Disposable) => void;
  onSession: (session: vscode.DebugSession) => void;
  onTerminated: () => void;
}

async function attachDebugger(
  pid: number,
  child: ChildProcess,
  skipPreBreakpoint: boolean,
  hooks: DebugAttachHooks
): Promise<void> {
  const sessionName = 'Attach to .NET Test Host';

  // Register these before startDebugging so a session that starts or ends
  // quickly cannot slip past us.
  hooks.track(vscode.debug.onDidStartDebugSession(session => {
    if (session.name === sessionName) {
      hooks.onSession(session);
    }
  }));
  hooks.track(vscode.debug.onDidTerminateDebugSession(session => {
    if (session.name === sessionName) {
      killProcessTree(child);
      hooks.onTerminated();
    }
  }));

  // The vstest testhost calls Debugger.Break() right after a debugger attaches
  // (VSTEST_HOST_DEBUG), which shows up as a pause before any test runs.
  // Auto-continue that first stop so the run starts without a manual Continue;
  // later stops (user breakpoints, exceptions) still pause normally.
  let tracker: vscode.Disposable | undefined;
  if (skipPreBreakpoint) {
    let continued = false;
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('coreclr', {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        if (session.name !== sessionName) {
          return undefined;
        }
        return {
          onDidSendMessage(message: unknown) {
            if (continued) {
              return;
            }
            const msg = message as { type?: string; event?: string; body?: { threadId?: number } };
            if (msg.type === 'event' && msg.event === 'stopped') {
              continued = true;
              tracker?.dispose();
              log('Auto-continuing past the test host pre-breakpoint');
              const threadId = msg.body?.threadId;
              if (threadId !== undefined) {
                void session.customRequest('continue', { threadId });
              } else {
                void vscode.commands.executeCommand('workbench.action.debug.continue');
              }
            }
          }
        };
      }
    });
    hooks.track(tracker);
  }

  const started = await vscode.debug.startDebugging(undefined, {
    name: sessionName,
    type: 'coreclr',
    request: 'attach',
    processId: pid
  });

  if (!started) {
    log('Debugger attach failed. Is the C# extension installed?');
    killProcessTree(child);
    throw new Error('Is the C# extension installed?');
  }
  log('Debugger attached successfully');
}

function textOf(node: any): string | undefined {
  if (node === undefined || node === null) {
    return undefined;
  }
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'object' && '#text' in node) {
    return String(node['#text']);
  }
  return String(node);
}

function parseDuration(duration?: string): number | undefined {
  if (!duration) {
    return undefined;
  }
  const match = /(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.(\d+))?/.exec(duration);
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds, fraction] = match;
  let ms = Number(hours) * 3600000 + Number(minutes) * 60000 + Number(seconds) * 1000;
  if (days) {
    ms += Number(days) * 86400000;
  }
  if (fraction) {
    ms += Number(fraction.padEnd(3, '0').slice(0, 3));
  }
  return ms;
}

const TRX_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function readTrxResults(trxPath: string): Promise<TrxResult[]> {
  // TRX files can be several MB: read asynchronously and let the event loop
  // breathe before the synchronous parse so the extension host stays
  // responsive (same reason as the Cobertura parse).
  const xml = await fs.promises.readFile(trxPath, 'utf8');
  await new Promise<void>(resolve => setImmediate(resolve));
  const testRun = TRX_PARSER.parse(xml).TestRun;

  const fqnByTestId = new Map<string, string>();
  for (const def of asArray<any>(testRun?.TestDefinitions?.UnitTest)) {
    const method = def.TestMethod;
    const fqn =
      method?.['@_className'] && method?.['@_name']
        ? `${method['@_className']}.${method['@_name']}`
        : def['@_name'];
    if (def['@_id'] && fqn) {
      fqnByTestId.set(def['@_id'], fqn);
    }
  }

  const results: TrxResult[] = [];
  for (const r of asArray<any>(testRun?.Results?.UnitTestResult)) {
    const errorInfo = r.Output?.ErrorInfo;
    results.push({
      fqn: fqnByTestId.get(r['@_testId']) ?? r['@_testName'],
      outcome: r['@_outcome'],
      message: textOf(errorInfo?.Message),
      stackTrace: textOf(errorInfo?.StackTrace),
      durationMs: parseDuration(r['@_duration'])
    });
  }
  return results;
}

// Exported for harness validation only.
export const __readTrxForTest = readTrxResults;
export const __processLineForTest = processLine;
export const __reportStreamedLineForTest = reportStreamedLine;
export const __collectTestsToRunForTest = collectTestsToRun;
export const __groupTestsBySolutionForTest = groupTestsBySolution;
export const __fqnFilterForTest = fqnFilter;
export const __batchByFilterLengthForTest = batchByFilterLength;
export const __createLiveContextForTest = createLiveContext;
export const __reportMatchedResultsForTest = reportMatchedResults;
export const __startStreamTailerForTest = startStreamTailer;
export const __prepareBuildTargetForTest = prepareBuildTarget;
export const __runSolutionTestsForTest = runSolutionTests;
