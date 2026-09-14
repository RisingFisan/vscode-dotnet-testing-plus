import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './logger';

const SKILL_NAME = 'dotnet-testing-plus';

type SkillScopeKind = 'global' | 'project' | 'globalWindows';

interface ScopeItem extends vscode.QuickPickItem {
  scopeKind: SkillScopeKind;
  baseDir: string;
}

interface HarnessTarget {
  label: string;
  detail: string;
  projectDir: string[];
  globalDir: string[];
}

function bundledSkillPath(extensionPath: string): string {
  return path.join(extensionPath, 'assets', 'skills', SKILL_NAME, 'SKILL.md');
}

function detectWindowsHomeFromWsl(): string | undefined {
  try {
    const usersRoot = '/mnt/c/Users';
    if (!fs.existsSync(usersRoot)) {
      return undefined;
    }
    const systemNames = new Set(['Public', 'Default', 'DefaultAppPool', 'All Users', 'desktop.ini']);
    const candidates = fs.readdirSync(usersRoot)
      .filter(name => !systemNames.has(name))
      .filter(name => fs.existsSync(path.join(usersRoot, name, 'NTUSER.DAT')));
    return candidates.length === 1 ? path.join(usersRoot, candidates[0]) : undefined;
  } catch {
    return undefined;
  }
}

const HARNESS_TARGETS: HarnessTarget[] = [
  {
    label: 'Generic (recommended — should work for most harnesses)',
    detail: 'Agent Skills standard location',
    projectDir: ['.agents', 'skills'],
    globalDir: ['.agents', 'skills']
  },
  {
    label: 'Claude Code',
    detail: 'Claude Code skills directory',
    projectDir: ['.claude', 'skills'],
    globalDir: ['.claude', 'skills']
  },
  {
    label: 'OpenCode',
    detail: 'OpenCode skills directory',
    projectDir: ['.opencode', 'skills'],
    globalDir: ['.config', 'opencode', 'skills']
  },
  {
    label: 'Codex',
    detail: 'Codex skills directory',
    projectDir: ['.codex', 'skills'],
    globalDir: ['.codex', 'skills']
  }
];

function buildScopeItems(): ScopeItem[] {
  const home = os.homedir();
  const items: ScopeItem[] = [
    { label: '$(globe) Global (recommended)', description: home, scopeKind: 'global', baseDir: home }
  ];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    items.push({ label: '$(folder-active) Project (this workspace)', description: root, scopeKind: 'project', baseDir: root });
  }
  const windowsHome = process.platform === 'linux' ? detectWindowsHomeFromWsl() : undefined;
  if (windowsHome) {
    items.push({ label: '$(window) Global, Windows side', description: windowsHome, scopeKind: 'globalWindows', baseDir: windowsHome });
  }
  return items;
}

export async function installAgentSkill(extensionPath: string | undefined): Promise<void> {
  if (!extensionPath) {
    void vscode.window.showErrorMessage('Agent skill install failed: extension path unavailable.');
    return;
  }
  const source = bundledSkillPath(extensionPath);
  if (!fs.existsSync(source)) {
    void vscode.window.showErrorMessage(`Bundled agent skill not found: ${source}`);
    return;
  }
  const scope = await vscode.window.showQuickPick(buildScopeItems(), {
    placeHolder: 'Install the .NET Testing+ agent skill where?'
  });
  if (!scope) {
    return;
  }
  const target = await vscode.window.showQuickPick(
    HARNESS_TARGETS.map(item => {
      const relativeDirs = scope.scopeKind === 'project' ? item.projectDir : item.globalDir;
      const destination = path.join(scope.baseDir, ...relativeDirs);
      return {
        label: item.label,
        description: destination,
        detail: item.detail,
        relativeDirs
      };
    }),
    { placeHolder: 'Which agent harness?' }
  );
  if (!target) {
    return;
  }
  const destDir = path.join(scope.baseDir, ...target.relativeDirs, SKILL_NAME);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(source, path.join(destDir, 'SKILL.md'));
    log(`Agent skill installed to: ${destDir}`);
    void vscode.window.showInformationMessage(`Agent skill installed to ${destDir}; agents discover it on their next session.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Agent skill install failed for ${destDir}: ${message}`);
    void vscode.window.showErrorMessage(`Agent skill install failed: ${message}`);
  }
}
