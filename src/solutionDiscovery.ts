import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { log, logCommand } from './logger';

const LIST_TESTS_TIMEOUT_MS = 15 * 60 * 1000;
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

function logStdout(stdout: string): void {
  if (!stdout) {
    return;
  }
  const clean = stripAnsi(stdout);
  const head = clean.slice(0, 500);
  const tail = clean.length > 1500 ? `\n... (truncated) ...\n${clean.slice(-1000)}` : '';
  log(`[stdout] ${head}${tail}`);
}

function runListTests(
  slnPath: string,
  token: vscode.CancellationToken | undefined,
  terminalLoggerOff: boolean
): Promise<string> {
  const args = ['test', slnPath, '--list-tests', '--nologo', '-v', 'q'];
  if (terminalLoggerOff) {
    args.push('--tl:off');
  }
  logCommand('dotnet', args);

  return new Promise((resolve, reject) => {
    const child = execFile(
      'dotnet',
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: LIST_TESTS_TIMEOUT_MS },
      (err, stdout, stderr) => {
        logStdout(stdout);
        if (stderr) {
          log(`[stderr] ${stripAnsi(stderr).slice(0, 500)}${stderr.length > 500 ? '\n... (truncated)' : ''}`);
        }
        if (token?.isCancellationRequested) {
          reject(new Error('Discovery cancelled'));
          return;
        }
        if (err) {
          log(`[error] dotnet test --list-tests failed: ${err.message}`);
          reject(err);
          return;
        }
        resolve(stdout);
      }
    );
    token?.onCancellationRequested(() => {
      log('[cancel] dotnet test discovery cancelled');
      child.kill();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ENOENT_RETRIES = 3;
const ENOENT_RETRY_DELAY_MS = 5000;

/**
 * Run `dotnet test <solution> --list-tests` against the solution file and
 * return every discovered test name. Retries on ENOENT because the extension
 * host can start before the remote environment's PATH is fully set up.
 */
export async function discoverSolutionTests(
  slnPath: string,
  token?: vscode.CancellationToken
): Promise<string[]> {
  let stdout: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= ENOENT_RETRIES; attempt++) {
    try {
      stdout = await runListTests(slnPath, token, true);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/unrecognized option|unknown option/i.test(message)) {
        log('SDK does not support --tl:off; retrying without it');
        stdout = await runListTests(slnPath, token, false);
        lastError = undefined;
        break;
      }
      if (/ENOENT/.test(message) && attempt < ENOENT_RETRIES && !token?.isCancellationRequested) {
        log(`dotnet not found on PATH (attempt ${attempt}/${ENOENT_RETRIES}); retrying in ${ENOENT_RETRY_DELAY_MS / 1000}s...`);
        await delay(ENOENT_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  if (stdout === undefined) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`dotnet test --list-tests failed for ${path.basename(slnPath)}: ${message}`);
  }

  const tests = parseListTestsOutput(stdout);
  log(`Discovered ${tests.length} tests in solution ${slnPath}`);
  return tests;
}
