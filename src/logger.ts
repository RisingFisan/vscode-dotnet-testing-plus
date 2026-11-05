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
 *
 * Only `log()` uses this: raw stdout/stderr carry the capture explicitly
 * (`logChunk`), so overlapping runs cannot swap their bulk output. Two runs on
 * different solutions can still interleave `run.log` lines.
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
 *
 * The capture is passed in rather than read from the module state: two runs on
 * different solutions may overlap, and a shared global would write one run's
 * output into the other's artifacts.
 */
export function logChunk(capture: RunCapture | undefined, stream: 'stdout' | 'stderr', text: string): void {
  initLogger();
  // Name the artifact by run id, not by its staging path: the staging directory
  // is deleted when the run passes and moved when it is retained, so an absolute
  // staging path would be a dead pointer by the time anyone reads the log.
  const artifact = capture ? `${capture.runId}/${stream}.log` : undefined;
  capture?.append(`${stream}.log`, text);
  const timestamp = new Date().toISOString();
  channel?.appendLine(`[${timestamp}] [${stream}] ${formatChunkPreview(text, CHUNK_CHANNEL_LIMIT, artifact)}`);
  pushRecent(`[${timestamp}] [${stream}] ${formatChunkPreview(text, CHUNK_RECENT_LIMIT, artifact)}`);
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
