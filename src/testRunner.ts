import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { XMLParser } from 'fast-xml-parser';
import { log, logCommand } from './logger';
import { killProcessTree, spawnTracked } from './processTree';
import { SourceLocation } from './sourceScan';
import { TestResultState } from './testResultFilter';
import { collectProjectCoverage, CoverageState, newCoverageState } from './coverage';

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

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
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

/**
 * Batch tests so that no `dotnet test` invocation's `--filter` argument
 * approaches the OS argument-length limit. Typical projects fit in one batch
 * (one process, live results, no per-invocation startup overhead); only very
 * large selections split across invocations.
 */
function batchByFilterLength(
  tests: readonly vscode.TestItem[],
  options?: RunOptions
): vscode.TestItem[][] {
  const batches: vscode.TestItem[][] = [];
  let current: vscode.TestItem[] = [];
  let length = 0;
  for (const test of tests) {
    const entry = filterEntryFor(test, options);
    if (current.length > 0 && length + entry.length + 1 > FILTER_ARG_LIMIT) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(test);
    length += entry.length + 1;
  }
  if (current.length > 0) {
    batches.push(current);
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
  const solutionOptions: RunOptions = { ...options, runsettingsPath: solution.runsettingsPath };
  try {
    await buildSolutionOnce(solution.solutionPath, run, token);
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
        batch.forEach(test => skipTest(run, test, solutionOptions));
        continue;
      }
      await runChunk(csproj, batch, run, token, debug, solutionOptions, true);
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
  tests: vscode.TestItem[];
  /** Test ids that have received a result (any outcome). */
  reported: Set<string>;
  /** Aggregated outcome per test id; see {@link outcomeRank}. */
  outcomes: Map<string, string>;
  /** Lazily built FQN -> test items index. */
  index?: Map<string, vscode.TestItem[]>;
  /** TRX paths announced on stdout. */
  trxFiles: string[];
  /** TRX paths already parsed successfully (never parsed twice). */
  parsedTrx: Set<string>;
  /** Flush the stream-logger tail; set while a tailer is active. */
  drainStream?: () => void;
}

function createLiveContext(run: vscode.TestRun, options: RunOptions | undefined, tests: vscode.TestItem[]): LiveContext {
  return {
    run,
    options,
    tests,
    reported: new Set<string>(),
    outcomes: new Map<string, string>(),
    trxFiles: [],
    parsedTrx: new Set<string>()
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
  ctx.reported.add(test.id);
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
      const testDeclLoc = descriptorFor(test, ctx.options)?.location ?? ctx.options?.locations?.get(test.id);
      const testFqn = descriptorFor(test, ctx.options)?.fullyQualifiedName ?? test.id;
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
  if (ctx.reported.size >= ctx.tests.length) {
    return;
  }
  // The TRX is fully written by the time this line is printed; parse it
  // immediately so results show up as each test project finishes.
  try {
    reportMatchedResults(ctx, readTrxResults(trxPath));
    ctx.parsedTrx.add(trxPath);
  } catch {
    // The file may still be locked; the end-of-run sweep retries it.
  }
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

function buildSolutionOnce(
  solutionPath: string,
  run: vscode.TestRun,
  token: vscode.CancellationToken
): Promise<void> {
  const args = ['build', solutionPath, '--nologo', '--tl:off'];
  logCommand('dotnet', args);
  appendOutput(run, `Building solution: ${solutionPath}\n`);
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawnTracked('dotnet', args);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const cancelSub = token.onCancellationRequested(() => {
      log('[cancel] dotnet build cancelled');
      killProcessTree(child);
      reject(new Error('Build cancelled'));
    });
    child.stdout?.on('data', (text: string) => appendOutput(run, text));
    child.stderr?.on('data', (text: string) => appendOutput(run, text));
    child.on('error', err => {
      cancelSub.dispose();
      log(`[error] dotnet build failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', code => {
      cancelSub.dispose();
      if (code !== 0) {
        reject(new Error(`dotnet build failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
    if (token.isCancellationRequested) {
      killProcessTree(child);
      reject(new Error('Build cancelled'));
    }
  });
}

async function runChunk(
  target: string,
  tests: vscode.TestItem[],
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  debug: boolean,
  options?: RunOptions,
  noBuild = false
): Promise<void> {
  tests.forEach(t => {
    setTestState(options, t, 'queued');
    run.enqueued(t);
  });

  const filter = fqnFilter(tests, options);
  const args = ['test', target, '--filter', filter, '--nologo', '--logger', 'trx', '-c', 'Debug', '--tl:off'];
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

  const ctx = createLiveContext(run, options, tests);
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
      ? await debugDotnetTest(args, run, token, ctx, streamLogPath)
      : await runDotnetTest(args, run, token, ctx, streamLogPath);
    stopTailer?.();

    if (resultFiles.length === 0) {
      throw new Error('No test results were produced. Check the test output for build errors.');
    }

    log(`Collected ${resultFiles.length} TRX result file(s)`);
    // End-of-run sweep for TRX files that could not be parsed while streaming
    // (e.g. still locked). It is skipped entirely when every test already has
    // a result (the stream logger normally delivers them all), and a TRX that
    // was already read successfully is never parsed a second time.
    if (ctx.reported.size < ctx.tests.length) {
      for (const trxPath of resultFiles) {
        if (ctx.parsedTrx.has(trxPath)) {
          continue;
        }
        try {
          reportMatchedResults(ctx, readTrxResults(trxPath));
          ctx.parsedTrx.add(trxPath);
        } catch {
          // ignore unreadable TRX; unmatched tests are marked skipped below
        }
      }
    }
    for (const test of ctx.tests) {
      if (!ctx.reported.has(test.id)) {
        skipTest(run, test, options);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const test of ctx.tests) {
      if (ctx.reported.has(test.id)) {
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
    if (streamLogPath) {
      try {
        fs.rmSync(streamLogPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    // dotnet test writes the TRX next to the test project; clean up every one
    // we saw, including runs that errored or were cancelled before returning.
    for (const f of new Set([...resultFiles, ...ctx.trxFiles])) {
      try {
        fs.rmSync(f, { force: true });
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
      env: streamLogPath ? { ...process.env, PLAYLIST_STREAM_LOG: streamLogPath } : process.env
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
      log(`[stdout] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
      appendOutput(run, text);
      feeder.feed(text);
    });
    child.stderr?.on('data', (text: string) => {
      log(`[stderr] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
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
      env: {
        ...process.env,
        VSTEST_HOST_DEBUG: '1',
        ...(streamLogPath ? { PLAYLIST_STREAM_LOG: streamLogPath } : {})
      }
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
      log(`[stdout] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
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
      log(`[stderr] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
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

function readTrxResults(trxPath: string): TrxResult[] {
  const xml = fs.readFileSync(trxPath, 'utf8');
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
export const __runSolutionTestsForTest = runSolutionTests;
