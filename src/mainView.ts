import * as vscode from 'vscode';
import * as path from 'path';

export interface MainViewState {
  solutionReady: boolean;
  playlistPath?: string;
  runsettingsPath?: string;
  runsettingsIsDefault: boolean;
  hasExplicitRunsettings: boolean;
  filter: string;
  skipPreBreakpoint: boolean;
}

export type MainViewAction =
  | { type: 'selectPlaylist' | 'clearPlaylist' | 'selectRunsettings' | 'clearRunsettings' }
  | { type: 'filter'; text: string }
  | { type: 'toggleSkipPreBreakpoint'; checked: boolean };

export class MainViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private state: MainViewState = {
    solutionReady: false,
    runsettingsIsDefault: false,
    hasExplicitRunsettings: false,
    filter: '',
    skipPreBreakpoint: true
  };

  constructor(private readonly onAction: (action: MainViewAction) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml();
    view.webview.onDidReceiveMessage((msg: { type: string; text?: string; checked?: boolean }) => {
      if (msg.type === 'ready') {
        this.postState();
      } else if (msg.type === 'filter') {
        this.onAction({ type: 'filter', text: msg.text ?? '' });
      } else if (msg.type === 'toggleSkipPreBreakpoint') {
        this.onAction({ type: 'toggleSkipPreBreakpoint', checked: msg.checked ?? true });
      } else {
        this.onAction({ type: msg.type } as MainViewAction);
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  setState(state: MainViewState): void {
    this.state = state;
    this.postState();
  }

  private postState(): void {
    const s = this.state;
    void this.view?.webview.postMessage({
      type: 'state',
      solutionReady: s.solutionReady,
      playlistName: s.playlistPath ? path.basename(s.playlistPath) : undefined,
      playlistFull: s.playlistPath,
      runsettingsName: s.runsettingsPath
        ? path.basename(s.runsettingsPath) + (s.runsettingsIsDefault ? ' (default)' : '')
        : undefined,
      runsettingsFull: s.runsettingsPath,
      hasExplicitRunsettings: s.hasExplicitRunsettings,
      filter: s.filter,
      skipPreBreakpoint: s.skipPreBreakpoint
    });
  }
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body {
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  .filter-row { display: flex; gap: 4px; align-items: center; }
  input#filter {
    flex: 1;
    min-width: 0;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px;
    font-family: inherit;
    font-size: inherit;
  }
  input#filter:focus { outline: 1px solid var(--vscode-focusBorder); }
  input#filter::placeholder { color: var(--vscode-input-placeholderForeground); }
  button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 3px 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .section { display: flex; align-items: center; gap: 6px; }
  .section .label { font-weight: 600; }
  .section .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .section .name.empty { opacity: 0.6; font-style: italic; }
  .toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .toggle input { margin: 0; }
</style>
</head>
<body>
  <div class="section">
    <span class="label">Advanced Search</span>
  </div>
  <div class="filter-row">
    <input id="filter" type="text"
      placeholder="Filter: class:Checkout project:Web|class:Cart"
      title="Space-separated terms are AND-ed, '|' separates OR-ed alternatives. class:/project: qualify a term; unqualified terms match the test name."/>
    <button id="clearFilter" title="Clear filter">Clear</button>
  </div>
  <div class="section">
    <span class="label">Playlist</span>
    <span class="name empty" id="playlistName">No playlist selected</span>
    <button id="selectPlaylist" title="Select Playlist File...">Select</button>
    <button id="clearPlaylist" title="Clear Playlist">Clear</button>
  </div>
  <div class="section">
    <span class="label">Runsettings</span>
    <span class="name empty" id="runsettingsName">None</span>
    <button id="selectRunsettings" title="Select Runsettings File...">Select</button>
    <button id="clearRunsettings" title="Clear Runsettings Selection">Clear</button>
  </div>
  <div class="section">
    <label class="toggle" title="When debugging, automatically continue past the test host's initial Debugger.Break() so the run starts without a manual Continue.">
      <input type="checkbox" id="skipPreBreakpoint"/>
      <span class="label">Skip pre-breakpoint</span>
    </label>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const input = $('filter');

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => vscode.postMessage({ type: 'filter', text: input.value }), 300);
  });
  $('clearFilter').addEventListener('click', () => {
    input.value = '';
    vscode.postMessage({ type: 'filter', text: '' });
  });
  $('selectPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'selectPlaylist' }));
  $('clearPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'clearPlaylist' }));
  $('selectRunsettings').addEventListener('click', () => vscode.postMessage({ type: 'selectRunsettings' }));
  $('clearRunsettings').addEventListener('click', () => vscode.postMessage({ type: 'clearRunsettings' }));
  $('skipPreBreakpoint').addEventListener('change', e =>
    vscode.postMessage({ type: 'toggleSkipPreBreakpoint', checked: e.target.checked }));

  function setName(el, name, emptyText, tooltip) {
    if (name) {
      el.textContent = name;
      el.classList.remove('empty');
      el.title = tooltip || name;
    } else {
      el.textContent = emptyText;
      el.classList.add('empty');
      el.title = emptyText;
    }
  }

  window.addEventListener('message', event => {
    const s = event.data;
    if (s.type !== 'state') { return; }
    if (input.value !== (s.filter ?? '')) {
      input.value = s.filter ?? '';
    }
    setName($('playlistName'), s.playlistName, 'No playlist selected', s.playlistFull);
    setName($('runsettingsName'), s.runsettingsName, 'None', s.runsettingsFull);
    $('selectPlaylist').disabled = !s.solutionReady;
    $('clearPlaylist').disabled = !s.playlistName;
    $('selectRunsettings').disabled = !s.solutionReady;
    $('clearRunsettings').disabled = !s.hasExplicitRunsettings;
    $('skipPreBreakpoint').checked = !!s.skipPreBreakpoint;
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
