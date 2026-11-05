import * as vscode from 'vscode';
import { formatChunkPreview, RunCapture } from './runDiagnostics';

let channel: vscode.OutputChannel | undefined;
const recentLines: string[] = [];
/** Recent-window size, in log calls (not physical lines). */
const MAX_RECENT_LINES = 500;
/** Cap for one chunk in the output channel; the run artifact holds the rest. */
const CHUNK_CHANNEL_LIMIT = 64 * 1024;
/** Cap for one chunk in the in-memory recent window. */
const CHUNK_RECENT_LIMIT = 4 * 1024;

/** Capture active for the current run; its stdout/stderr stay off the heap. */
let runCapture: RunCapture | undefined;

export function recentLogLines(limit = 200): string[] {
  if (limit <= 0) {
    return [];
  }
  return recentLines.slice(-limit);
}

export function initLogger(): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('.NET Testing+');
  }
}

export function showLog(): void {
  initLogger();
  channel?.show();
}

/**
 * Route extension log lines into the active run's `run.log`. Cleared by the
 * runner when the capture settles, so lines after a run never land in it.
 */
export function setRunCapture(capture: RunCapture | undefined): void {
  runCapture = capture;
}

export function log(message: string): void {
  initLogger();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  channel?.appendLine(line);
  runCapture?.append('run.log', `${line}\n`);
  pushRecent(line);
}

/**
 * Log one raw stdout/stderr chunk. The full text goes to the run artifact; the
 * output channel and the recent window keep bounded previews that name the
 * artifact, so nothing is dropped silently.
 */
export function logChunk(stream: 'stdout' | 'stderr', text: string): void {
  initLogger();
  const artifactPath = runCapture?.artifactPath(`${stream}.log`);
  runCapture?.append(`${stream}.log`, text);
  const timestamp = new Date().toISOString();
  channel?.appendLine(`[${timestamp}] [${stream}] ${formatChunkPreview(text, CHUNK_CHANNEL_LIMIT, artifactPath)}`);
  pushRecent(`[${timestamp}] [${stream}] ${formatChunkPreview(text, CHUNK_RECENT_LIMIT, artifactPath)}`);
}

function pushRecent(line: string): void {
  recentLines.push(line);
  if (recentLines.length > MAX_RECENT_LINES) {
    recentLines.splice(0, recentLines.length - MAX_RECENT_LINES);
  }
}

export function logCommand(program: string, args: string[], cwd?: string, env?: Record<string, string>): void {
  const cwdText = cwd ? ` (cwd: ${cwd})` : '';
  const envText = env ? ` (env: ${JSON.stringify(env)})` : '';
  log(`> ${program} ${args.join(' ')}${cwdText}${envText}`);
}
