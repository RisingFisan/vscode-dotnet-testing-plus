import * as vscode from 'vscode';
import * as path from 'path';
import { log, logCommand } from './logger';
import { killProcessTree, spawnTracked } from './processTree';

const LIST_TESTS_TIMEOUT_MS = 15 * 60 * 1000;
// Raw stdout is only kept for logging and the whole-output fallback parse; cap it
// so a pathologically chatty run cannot grow the buffer without bound.
const MAX_STDOUT_BUFFER = 16 * 1024 * 1024;
// How much of the failing run's output is attached to the error message.
const ERROR_EXCERPT_CHARS = 600;
const MARKER = 'The following Tests are available:';
// Accepts both fully-qualified names (Namespace.Class.Method) and the bare
// method names produced by Microsoft.Testing.Platform-based test runners.
const TEST_NAME_RE = /^[A-Za-z_][\w.<>`,]*(\([^)]*\))?$/;
// ANSI escape sequences: CSI (\x1B[...) and two-character sequences (\x1BX).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function stripTestParameters(name: string): string {
  return name.replace(/\([^)]*\)$/, '');
}

/**
 * Parse `dotnet test --list-tests` output. When run against a solution the
 * output contains one "The following Tests are available:" section per test
 * project; collect the test names from every section.
 */
export function parseListTestsOutput(rawStdout: string): string[] {
  const stdout = stripAnsi(rawStdout);
  const tests = new Set<string>();
  let capturing = false;

  for (const line of stdout.split(/\r?\n|\r/)) {
    if (line.includes(MARKER)) {
      capturing = true;
      continue;
    }
    if (!capturing) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      capturing = false;
      continue;
    }
    if (TEST_NAME_RE.test(trimmed)) {
      tests.add(trimmed);
    }
  }

  return [...tests];
}

export type DiscoveryProgressCallback = (foundCount: number) => void;

function logStdout(stdout: string): void {
  if (!stdout) {
    return;
  }
  const clean = stripAnsi(stdout);
  const head = clean.slice(0, 500);
  const tail = clean.length > 1500 ? `\n... (truncated) ...\n${clean.slice(-1000)}` : '';
  log(`[stdout] ${head}${tail}`);
}

interface RunListTestsResult {
  stdout: string;
  tests: string[];
}

function runListTests(
  slnPath: string,
  token: vscode.CancellationToken | undefined,
  terminalLoggerOff: boolean,
  onProgress?: DiscoveryProgressCallback
): Promise<RunListTestsResult> {
  const args = ['test', slnPath, '--list-tests', '--nologo', '-v', 'q'];
  if (terminalLoggerOff) {
    args.push('--tl:off');
  }
  logCommand('dotnet', args);

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let lineRemainder = '';
    let capturing = false;
    const tests = new Set<string>();
    let lastReportedCount = 0;
    let throttleTimer: NodeJS.Timeout | undefined;

    const reportProgress = (): void => {
      if (tests.size !== lastReportedCount) {
        lastReportedCount = tests.size;
        onProgress?.(lastReportedCount);
      }
    };

    const processLine = (line: string): void => {
      const cleanLine = stripAnsi(line);
      if (cleanLine.includes(MARKER)) {
        capturing = true;
        return;
      }
      if (!capturing) {
        return;
      }
      const trimmed = cleanLine.trim();
      if (trimmed.length === 0) {
        capturing = false;
        return;
      }
      if (TEST_NAME_RE.test(trimmed)) {
        tests.add(trimmed);
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = undefined;
            reportProgress();
          }, 100);
        }
      }
    };

    const child = spawnTracked('dotnet', args);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const timeoutTimer = setTimeout(() => {
      log(`[timeout] dotnet test --list-tests timed out after ${LIST_TESTS_TIMEOUT_MS / 1000}s`);
      killProcessTree(child);
      reject(new Error('Discovery timed out'));
    }, LIST_TESTS_TIMEOUT_MS);

    const cancelSub = token?.onCancellationRequested(() => {
      log('[cancel] dotnet test discovery cancelled');
      clearTimeout(timeoutTimer);
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
      killProcessTree(child);
    });

    child.stdout?.on('data', (text: string) => {
      if (stdoutBuffer.length < MAX_STDOUT_BUFFER) {
        stdoutBuffer += text;
      }
      // Same cap as stdoutBuffer: a pathologically long unterminated line
      // must not grow the remainder without bound either.
      if (lineRemainder.length < MAX_STDOUT_BUFFER) {
        lineRemainder += text;
      }
      const lines = lineRemainder.split(/\r?\n|\r/);
      lineRemainder = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr?.on('data', (text: string) => {
      if (stderrBuffer.length < MAX_STDOUT_BUFFER) {
        stderrBuffer += text;
      }
    });

    child.on('error', err => {
      cancelSub?.dispose();
      clearTimeout(timeoutTimer);
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
      log(`[error] dotnet test --list-tests process error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code, signal) => {
      cancelSub?.dispose();
      clearTimeout(timeoutTimer);
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
      if (lineRemainder.length > 0) {
        processLine(lineRemainder);
        lineRemainder = '';
      }
      reportProgress();

      logStdout(stdoutBuffer);
      if (stderrBuffer) {
        log(`[stderr] ${stripAnsi(stderrBuffer).slice(0, 500)}${stderrBuffer.length > 500 ? '\n... (truncated)' : ''}`);
      }

      if (token?.isCancellationRequested) {
        reject(new Error('Discovery cancelled'));
        return;
      }

      if (code !== 0 && code !== null) {
        // Include what dotnet said (it prints option errors on stdout or stderr):
        // callers pattern-match on it, e.g. to retry without --tl:off.
        const detail = stripAnsi(stderrBuffer.trim() || stdoutBuffer.trim()).slice(-ERROR_EXCERPT_CHARS);
        const errorMsg = `dotnet test --list-tests exited with code ${code}${signal ? ` (signal ${signal})` : ''}${detail ? `: ${detail}` : ''}`;
        log(`[error] ${errorMsg}`);
        reject(new Error(errorMsg));
        return;
      }

      resolve({ stdout: stdoutBuffer, tests: [...tests] });
    });
  });
}

function delay(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    const sub = token?.onCancellationRequested(done);
    function done(): void {
      clearTimeout(timer);
      sub?.dispose();
      resolve();
    }
  });
}

const ENOENT_RETRIES = 3;
const ENOENT_RETRY_DELAY_MS = 5000;
// Older SDKs reject `--tl:off`; their wording varies ("Unknown switch",
// "Unrecognized command or argument", ...) but always names the switch or
// uses one of these phrases.
const UNSUPPORTED_TL_RE = /--tl\b|MSB1001|unrecogni[sz]ed|unknown (?:option|switch)/i;

/**
 * Run `dotnet test <solution> --list-tests` against the solution file and
 * return every discovered test name. Retries on ENOENT because the extension
 * host can start before the remote environment's PATH is fully set up.
 */
export async function discoverSolutionTests(
  slnPath: string,
  token?: vscode.CancellationToken,
  onProgress?: DiscoveryProgressCallback
): Promise<string[]> {
  let result: RunListTestsResult | undefined;
  let lastError: unknown;
  let terminalLoggerOff = true;

  for (let attempt = 1; attempt <= ENOENT_RETRIES; attempt++) {
    try {
      result = await runListTests(slnPath, token, terminalLoggerOff, onProgress);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (terminalLoggerOff && !token?.isCancellationRequested && UNSUPPORTED_TL_RE.test(message)) {
        // Retry without the switch; this does not consume an ENOENT attempt, and
        // a failure of the retry flows through the same handling as any other.
        log('SDK does not support --tl:off; retrying without it');
        terminalLoggerOff = false;
        attempt--;
        continue;
      }
      if (/ENOENT/.test(message) && attempt < ENOENT_RETRIES && !token?.isCancellationRequested) {
        log(`dotnet not found on PATH (attempt ${attempt}/${ENOENT_RETRIES}); retrying in ${ENOENT_RETRY_DELAY_MS / 1000}s...`);
        await delay(ENOENT_RETRY_DELAY_MS, token);
        continue;
      }
      break;
    }
  }

  if (result === undefined) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`dotnet test --list-tests failed for ${path.basename(slnPath)}: ${message}`);
  }

  // Use the incrementally parsed tests, or fall back to full stdout parsing if none were parsed
  const tests = result.tests.length > 0 ? result.tests : parseListTestsOutput(result.stdout);
  log(`Discovered ${tests.length} tests in solution ${slnPath}`);
  return tests;
}
