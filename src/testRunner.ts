import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import { log, logCommand } from './logger';
import { SourceLocation } from './sourceScan';

const CHUNK_SIZE = 100;

interface TrxResult {
  fqn: string;
  outcome: string;
  message?: string;
  stackTrace?: string;
  durationMs?: number;
}

interface RunOptions {
  runsettingsPath?: string;
  locations?: Map<string, SourceLocation>;
  /** FQN -> owning .csproj path. When provided, tests are run per project. */
  projects?: Map<string, string>;
  /** Directory containing Playlist.TestLogger.dll; enables live per-test results. */
  loggerDir?: string;
  chunkSize?: number;
  /** Auto-continue past the test host's initial Debugger.Break() when debugging. */
  skipPreBreakpoint?: boolean;
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

export async function runPlaylistTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  debug: boolean,
  solutionPath: string,
  options?: RunOptions
): Promise<void> {
  const run = controller.createTestRun(request);
  try {
    const tests: vscode.TestItem[] = [];
    const excluded = new Set(request.exclude ?? []);

    const enqueue = (item: vscode.TestItem): void => {
      if (item.children.size > 0) {
        item.children.forEach(enqueue);
        return;
      }
      if (excluded.has(item)) {
        run.skipped(item);
        return;
      }
      tests.push(item);
    };

    if (request.include && request.include.length > 0) {
      request.include.forEach(enqueue);
    } else {
      controller.items.forEach(enqueue);
    }

    const chunkSize = options?.chunkSize && options.chunkSize > 0 ? options.chunkSize : CHUNK_SIZE;
    const projects = options?.projects;

    if (projects && projects.size > 0) {
      const groups = new Map<string, vscode.TestItem[]>();
      const unmapped: vscode.TestItem[] = [];
      for (const test of tests) {
        const csproj = projects.get(test.id);
        if (csproj) {
          const group = groups.get(csproj) ?? [];
          group.push(test);
          groups.set(csproj, group);
        } else {
          unmapped.push(test);
        }
      }

      if (unmapped.length > 0) {
        const ids = unmapped.map(t => t.id).join(', ');
        const message = `Skipping ${unmapped.length} test(s) with no owning project mapping: ${ids.slice(0, 200)}${ids.length > 200 ? '...' : ''}`;
        log(message);
        appendOutput(run, message + '\n');
        unmapped.forEach(t => run.skipped(t));
      }

      if (groups.size === 0) {
        return;
      }

      // Build once so per-project runs can use --no-build.
      await buildSolutionOnce(solutionPath, run, token);

      for (const [csproj, projectTests] of groups) {
        if (token.isCancellationRequested) {
          projectTests.forEach(t => run.skipped(t));
          continue;
        }
        for (let i = 0; i < projectTests.length; i += chunkSize) {
          if (token.isCancellationRequested) {
            projectTests.slice(i).forEach(t => run.skipped(t));
            break;
          }
          await runChunk(csproj, projectTests.slice(i, i + chunkSize), run, token, debug, options, true);
        }
      }
    } else {
      for (let i = 0; i < tests.length; i += chunkSize) {
        if (token.isCancellationRequested) {
          tests.slice(i).forEach(t => run.skipped(t));
          break;
        }
        await runChunk(solutionPath, tests.slice(i, i + chunkSize), run, token, debug, options, false);
      }
    }
  } finally {
    run.end();
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[a-zA-Z]/g;
const RESULTS_FILE_LINE_RE = /Results File:\s*(.+?\.trx)/i;

interface LiveContext {
  run: vscode.TestRun;
  options?: RunOptions;
  tests: vscode.TestItem[];
  reported: Set<string>;
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

function reportOutcome(
  ctx: LiveContext,
  test: vscode.TestItem,
  outcome: string,
  durationMs?: number,
  failure?: FailureInfo
): void {
  ctx.reported.add(test.id);
  switch (outcome) {
    case 'Passed':
      ctx.run.passed(test, durationMs);
      break;
    case 'Failed': {
      const message = new vscode.TestMessage(failure?.message ?? 'Test failed');
      const frames = failure?.stackTrace ? parseStackTrace(failure.stackTrace) : [];
      if (frames.length > 0) {
        message.stackTrace = frames;
      }
      // Point at the line where the error actually happened (the topmost
      // frame with file info); fall back to the test method declaration.
      const topFrame = frames.find(f => f.uri !== undefined && f.position !== undefined);
      if (topFrame?.uri && topFrame.position) {
        message.location = new vscode.Location(
          topFrame.uri,
          new vscode.Range(topFrame.position, topFrame.position)
        );
      } else {
        const loc = ctx.options?.locations?.get(test.id);
        if (loc) {
          message.location = new vscode.Location(
            vscode.Uri.file(loc.file),
            new vscode.Range(loc.line - 1, 0, loc.line - 1, 0)
          );
        }
      }
      ctx.run.failed(test, message, durationMs);
      break;
    }
    default:
      ctx.run.skipped(test);
      break;
  }
}

/**
 * Report results for whichever chunk tests appear in this TRX. Tests without a
 * matching result are left unreported (their TRX may not have been written
 * yet); the end-of-run sweep marks leftovers as skipped.
 */
function reportMatchedResults(ctx: LiveContext, results: TrxResult[]): void {
  const byFqn = new Map(results.map(r => [r.fqn, r]));
  for (const test of ctx.tests) {
    if (ctx.reported.has(test.id)) {
      continue;
    }
    const result = byFqn.get(test.id) ?? results.find(r => r.fqn.startsWith(test.id + '('));
    if (!result) {
      continue;
    }
    reportOutcome(ctx, test, result.outcome, result.durationMs, {
      message: result.message,
      stackTrace: result.stackTrace
    });
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
  if (!result.fqn || !result.outcome) {
    return;
  }
  for (const test of ctx.tests) {
    if (ctx.reported.has(test.id)) {
      continue;
    }
    if (test.id !== result.fqn && !result.fqn.startsWith(test.id + '(')) {
      continue;
    }
    reportOutcome(ctx, test, result.outcome, result.durationMs, {
      message: result.message,
      stackTrace: result.stackTrace
    });
    break;
  }
}

/**
 * Tail the JSONL file written by Playlist.TestLogger.dll so results are
 * reported the moment each test finishes. Returns an idempotent stop function
 * that drains any remaining content and closes the file.
 */
function startStreamTailer(filePath: string, ctx: LiveContext): () => void {
  let offset = 0;
  let pending = '';
  let fd: number | undefined;
  let stopped = false;

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
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      pending += buffer.toString('utf8');
      let idx: number;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).replace(/\r$/, '').replace(/^\uFEFF/, '');
        pending = pending.slice(idx + 1);
        if (line.length > 0) {
          reportStreamedLine(ctx, line);
        }
      }
    } catch {
      // file may not exist yet or be mid-write; the next tick retries
    }
  };

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
  };
}

function processLine(ctx: LiveContext, rawLine: string, resultFiles: string[]): void {
  const line = rawLine.replace(ANSI_RE, '');
  const fileMatch = RESULTS_FILE_LINE_RE.exec(line);
  if (!fileMatch) {
    return;
  }
  const trxPath = fileMatch[1].trim();
  resultFiles.push(trxPath);
  // The TRX is fully written by the time this line is printed; parse it
  // immediately so results show up as each test project finishes.
  try {
    reportMatchedResults(ctx, readTrxResults(trxPath));
  } catch {
    // The file may still be locked; the end-of-run sweep retries it.
  }
}

function createLineFeeder(ctx: LiveContext, resultFiles: string[]): (text: string) => void {
  let buffer = '';
  return (text: string) => {
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      processLine(ctx, line, resultFiles);
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
    const child: ChildProcess = spawn('dotnet', args);
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendOutput(run, text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendOutput(run, text);
    });
    child.on('error', err => {
      log(`[error] dotnet build failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`dotnet build failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
    token.onCancellationRequested(() => {
      log('[cancel] dotnet build cancelled');
      child.kill();
      reject(new Error('Build cancelled'));
    });
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
    run.enqueued(t);
  });

  const filter = tests.map(t => `FullyQualifiedName=${t.id}`).join('|');
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
  if (options?.runsettingsPath) {
    args.push('--settings', options.runsettingsPath);
  }

  const ctx: LiveContext = { run, options, tests, reported: new Set<string>() };
  let resultFiles: string[] = [];
  const streamLogPath = useStreamLogger
    ? path.join(os.tmpdir(), `playlist-stream-${process.pid}-${Date.now()}.jsonl`)
    : undefined;
  const stopTailer = streamLogPath ? startStreamTailer(streamLogPath, ctx) : undefined;

  tests.forEach(t => {
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
    // (e.g. still locked). Tests with no result anywhere are marked skipped.
    for (const trxPath of resultFiles) {
      try {
        reportMatchedResults(ctx, readTrxResults(trxPath));
      } catch {
        // ignore unreadable TRX; unmatched tests are marked skipped below
      }
    }
    for (const test of ctx.tests) {
      if (!ctx.reported.has(test.id)) {
        run.skipped(test);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const test of ctx.tests) {
      if (!ctx.reported.has(test.id)) {
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
    // dotnet test writes the TRX next to the test project; clean up what we parsed.
    try {
      for (const f of resultFiles) {
        fs.rmSync(f, { force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }
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
    const feed = createLineFeeder(ctx, resultFiles);
    let sawStdout = false;
    const child: ChildProcess = spawn('dotnet', args, {
      env: streamLogPath ? { ...process.env, PLAYLIST_STREAM_LOG: streamLogPath } : process.env
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      sawStdout = true;
      log(`[stdout] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
      appendOutput(run, text);
      feed(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      log(`[stderr] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
      appendOutput(run, text);
    });
    child.on('error', err => {
      log(`[error] dotnet test failed: ${err.message}`);
      reject(err);
    });
    child.on('exit', code => {
      if (code !== 0 && !sawStdout) {
        reject(new Error(`dotnet test exited with code ${code}`));
      } else {
        resolve(resultFiles);
      }
    });
    token.onCancellationRequested(() => {
      log('[cancel] dotnet test run cancelled');
      child.kill();
    });
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
    const child: ChildProcess = spawn('dotnet', args, {
      env: {
        ...process.env,
        VSTEST_HOST_DEBUG: '1',
        ...(streamLogPath ? { PLAYLIST_STREAM_LOG: streamLogPath } : {})
      }
    });

    const resultFiles: string[] = [];
    const feed = createLineFeeder(ctx, resultFiles);
    let buffer = '';
    let attached = false;
    let settled = false;
    const settle = (err?: Error): void => {
      if (!settled) {
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve(resultFiles);
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      log(`[stdout] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
      appendOutput(run, text);
      feed(text);
      if (!attached) {
        buffer += text;
        const match = /Process Id:\s*(\d+)/.exec(buffer);
        if (match) {
          attached = true;
          log(`Attaching debugger to process ${match[1]}`);
          void attachDebugger(Number(match[1]), child, settle, ctx.options?.skipPreBreakpoint ?? true);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      log(`[stderr] ${text.slice(0, 500)}${text.length > 500 ? '\n... (truncated)' : ''}`);
      appendOutput(run, text);
    });
    child.on('error', err => settle(err));
    child.on('exit', () => {
      if (!attached) {
        settle();
      }
    });
    token.onCancellationRequested(() => {
      child.kill();
      settle();
    });
  });
}

async function attachDebugger(
  pid: number,
  child: ChildProcess,
  settle: (err?: Error) => void,
  skipPreBreakpoint: boolean
): Promise<void> {
  const sessionName = 'Attach to .NET Test Host';

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
  }

  const started = await vscode.debug.startDebugging(undefined, {
    name: sessionName,
    type: 'coreclr',
    request: 'attach',
    processId: pid
  });

  if (!started) {
    log('Debugger attach failed. Is the C# extension installed?');
    tracker?.dispose();
    child.kill();
    settle(new Error('Could not start the debugger. Is the C# extension installed?'));
    return;
  }
  log('Debugger attached successfully');

  const disposable = vscode.debug.onDidTerminateDebugSession(session => {
    if (session.name === sessionName) {
      disposable.dispose();
      tracker?.dispose();
      child.kill();
      settle();
    }
  });
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

function readTrxResults(trxPath: string): TrxResult[] {
  const xml = fs.readFileSync(trxPath, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const testRun = parser.parse(xml).TestRun;

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
