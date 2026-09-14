import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
const recentLines: string[] = [];
const MAX_RECENT_LINES = 500;

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

export function log(message: string): void {
  initLogger();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  channel?.appendLine(line);
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
