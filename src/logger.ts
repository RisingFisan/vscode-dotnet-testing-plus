import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

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
  channel?.appendLine(`[${timestamp}] ${message}`);
}

export function logCommand(program: string, args: string[], cwd?: string, env?: Record<string, string>): void {
  const cwdText = cwd ? ` (cwd: ${cwd})` : '';
  const envText = env ? ` (env: ${JSON.stringify(env)})` : '';
  log(`> ${program} ${args.join(' ')}${cwdText}${envText}`);
}
