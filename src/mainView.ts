import * as vscode from 'vscode';
import * as path from 'path';
import { CustomRunsettingsViewState } from './runsettingsManager';
import { TestResultFilter, TestResultFilterKey, createDefaultTestResultFilter } from './testResultFilter';

export type RunsettingsMode = 'default' | 'override' | 'custom';

export interface SolutionTabState {
  key: string;
  label: string;
  detail: string;
  ready: boolean;
  loading: boolean;
  testCount?: number;
}

export interface MainViewState {
  sessions: SolutionTabState[];
  activeSessionKey?: string;
  solutionReady: boolean;
  playlistPath?: string;
  runsettingsPath?: string;
  runsettingsIsDefault: boolean;
  runsettingsMode: RunsettingsMode;
  defaultRunsettingsAvailable: boolean;
  hasExplicitRunsettings: boolean;
  filter: string;
  resultFilter: TestResultFilter;
  skipPreBreakpoint: boolean;
  notFoundTests: string[];
  customRunsettings?: CustomRunsettingsViewState;
}

export type MainViewAction =
  | { type: 'addSolution' | 'selectPlaylist' | 'clearPlaylist' | 'selectRunsettings' | 'clearRunsettings' | 'saveAsPlaylist' }
  | { type: 'removeSolution'; key?: string }
  | { type: 'selectSession'; key: string }
  | { type: 'setRunsettingsMode'; mode: RunsettingsMode }
  | { type: 'filter'; text: string }
  | { type: 'clearFilter' }
  | { type: 'setResultFilter'; key: TestResultFilterKey; checked: boolean }
  | { type: 'toggleSkipPreBreakpoint'; checked: boolean }
  | { type: 'setCustomRunsettingsValue'; key: string; value: string }
  | { type: 'resetCustomRunsettingsValue'; key: string }
  | { type: 'addCustomRunsettingsParameter' }
  | { type: 'updateCustomRunsettingsParameter'; id: string; field: 'name' | 'value'; value: string }
  | { type: 'removeCustomRunsettingsParameter'; id: string };

export class MainViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private state: MainViewState = {
    sessions: [],
    solutionReady: false,
    runsettingsIsDefault: false,
    runsettingsMode: 'default',
    defaultRunsettingsAvailable: false,
    hasExplicitRunsettings: false,
    filter: '',
    resultFilter: createDefaultTestResultFilter(),
    skipPreBreakpoint: true,
    notFoundTests: [],
    customRunsettings: undefined
  };

  constructor(private readonly onAction: (action: MainViewAction) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml();
    view.webview.onDidReceiveMessage((msg: {
      type: string;
      text?: string;
      checked?: boolean;
      key?: string;
      value?: string;
      id?: string;
      field?: 'name' | 'value';
      mode?: RunsettingsMode;
      resultFilterKey?: TestResultFilterKey;
    }) => {
      if (msg.type === 'ready') {
        this.postState();
      } else if (msg.type === 'selectSession' && msg.key !== undefined) {
        this.onAction({ type: 'selectSession', key: msg.key });
      } else if (msg.type === 'removeSolution' && msg.key !== undefined) {
        this.onAction({ type: 'removeSolution', key: msg.key });
      } else if (msg.type === 'filter') {
        this.onAction({ type: 'filter', text: msg.text ?? '' });
      } else if (msg.type === 'setResultFilter' && msg.resultFilterKey !== undefined) {
        this.onAction({ type: 'setResultFilter', key: msg.resultFilterKey, checked: msg.checked ?? true });
      } else if (msg.type === 'setRunsettingsMode' && msg.mode !== undefined) {
        this.onAction({ type: 'setRunsettingsMode', mode: msg.mode });
      } else if (msg.type === 'toggleSkipPreBreakpoint') {
        this.onAction({ type: 'toggleSkipPreBreakpoint', checked: msg.checked ?? true });
      } else if (msg.type === 'setCustomRunsettingsValue' && msg.key !== undefined) {
        this.onAction({ type: 'setCustomRunsettingsValue', key: msg.key, value: msg.value ?? '' });
      } else if (msg.type === 'resetCustomRunsettingsValue' && msg.key !== undefined) {
        this.onAction({ type: 'resetCustomRunsettingsValue', key: msg.key });
      } else if (msg.type === 'addCustomRunsettingsParameter') {
        this.onAction({ type: 'addCustomRunsettingsParameter' });
      } else if (msg.type === 'updateCustomRunsettingsParameter' && msg.id !== undefined && msg.field !== undefined) {
        this.onAction({
          type: 'updateCustomRunsettingsParameter',
          id: msg.id,
          field: msg.field,
          value: msg.value ?? ''
        });
      } else if (msg.type === 'removeCustomRunsettingsParameter' && msg.id !== undefined) {
        this.onAction({ type: 'removeCustomRunsettingsParameter', id: msg.id });
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
      sessions: s.sessions,
      activeSessionKey: s.activeSessionKey,
      solutionReady: s.solutionReady,
      playlistName: s.playlistPath ? path.basename(s.playlistPath) : undefined,
      playlistFull: s.playlistPath,
      runsettingsName: s.runsettingsPath
        ? path.basename(s.runsettingsPath).replace(/^(.+)\.runsettings$/i, '$1') +
          (s.runsettingsMode === 'override' ? ' (overridden)' : '')
        : undefined,
      runsettingsFull: s.runsettingsPath,
      runsettingsMode: s.runsettingsMode,
      defaultRunsettingsAvailable: s.defaultRunsettingsAvailable,
      hasExplicitRunsettings: s.hasExplicitRunsettings,
      filter: s.filter,
      resultFilter: s.resultFilter,
      skipPreBreakpoint: s.skipPreBreakpoint,
      notFoundTests: s.notFoundTests,
      customRunsettings: s.customRunsettings
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
  input[type="text"] { border-radius: 4px; }
  .result-filter { position: relative; }
  .result-filter-menu {
    position: absolute;
    z-index: 1;
    top: calc(100% + 2px);
    right: 0;
    min-width: 180px;
    padding: 6px;
    background: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow);
    overflow: hidden;
  }
  .result-filter-option { display: flex; align-items: center; gap: 6px; padding: 3px; cursor: pointer; white-space: nowrap; }
  .result-filter-option:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  .icon-button { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 3px; }
  .icon-button svg { width: 16px; height: 16px; fill: currentColor; }
  .tabs-wrapper { display: flex; flex-direction: column; border: 1px solid var(--vscode-surface-border, var(--vscode-widget-border)); border-radius: 8px; background: var(--vscode-panel-background); }
   .solution-tabs { display: flex; gap: 4px; align-items: center; overflow-x: auto; padding: 4px; margin-bottom: 6px; }
  #solutionTabs { display: flex; gap: 4px; flex: 0 0 auto; align-items: center; height: 24px; }
  .solution-tab { display: flex; flex: 0 0 auto; align-items: center; max-width: 180px; height: 100%; color: var(--vscode-tab-inactiveForeground); }
  .solution-tab:hover { background: var(--vscode-modernTab-hoverBackground, var(--vscode-button-secondaryHoverBackground)); }
  .solution-tab.active { background: var(--vscode-modernTab-activeBackground, var(--vscode-button-secondaryHoverBackground)); color: var(--vscode-tab-activeForeground); font-weight: bold; border-radius: 4px; }
  .solution-tab-select { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: transparent; color: inherit; }
  .solution-tab-close { background: transparent; color: inherit; padding: 3px; width: 18px; height: 100%; }
  .solution-tab-close:hover:not(:disabled) { background: var(--vscode-modernEditorTab-activeHoverBackground); }
  #addSolution { display: flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; line-height: 1; }
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
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
  }
  button.solid {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.solid:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  select#runsettingsMode {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 0;
    font-family: inherit;
    font-size: inherit;
    padding: 2px 4px;
  }
  select#runsettingsMode:disabled { opacity: 0.5; }
  #selectRunsettings { align-self: flex-start; }
  #customRunsettingsSection { padding: 4px; }
  .section { padding: 2px 8px; }
  .row { display: flex; flex-direction: row; gap: 6px; align-items: center; min-height: 32px; }
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
  .skip-pre-breakpoint { display: inline-flex; flex-direction: row; align-items: center; }
  .toggle input { margin: 0; }
  .runsettings-zone { display: flex; flex-direction: column; gap: 4px; }
  details { padding: 0; }
  summary { cursor: pointer; font-weight: 600; }
  .custom-content { padding-top: 6px; display: flex; flex-direction: column; gap: 5px; }
  .custom-group { display: flex; flex-direction: column; gap: 4px; }
  .custom-group-title { font-weight: 600; margin-top: 4px; }
  .custom-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; gap: 4px; align-items: center; }
  .custom-row .path, .custom-row .parameter-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .custom-row input { min-width: 0; width: auto; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; font-family: inherit; font-size: inherit; }
  .custom-row input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .custom-row input[readonly] { opacity: 0.75; }
  .custom-row button { padding-left: 5px; padding-right: 5px; }
  .custom-label { opacity: 0.7; font-size: 0.9em; }
  .custom-warning { color: var(--vscode-editorWarning-foreground); overflow-wrap: anywhere; }
  .custom-empty { opacity: 0.7; font-style: italic; }
  #saveAsPlaylist { align-self: flex-start; }
  .not-found { display: flex; flex-direction: column; gap: 4px; }
  .not-found[hidden] { display: none; }
  .not-found .label { font-weight: 600; margin-top: 4px; }
  .not-found-list { margin-top: 4px; opacity: 0.8; list-style-type: disc; padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
  .not-found-item { overflow-wrap: anywhere; }
</style>
</head>
<body>
  <div class="section">
    <span class="label">Advanced Search</span>
  </div>
  <div class="filter-row">
     <input id="filter" type="text"
       placeholder="Filter: class:Checkout & (project:Web|class:Cart)"
       title="Spaces are ignored. '&' ANDs terms, '|' ORs them, parentheses group. class:/project: qualify a term or group; unqualified terms match the test name."/>
      <button class="icon-button" id="clearFilter" title="Clear" aria-label="Clear"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 7.293 4.646-4.647.708.708L8.707 8l4.647 4.646-.708.708L8 8.707l-4.646 4.647-.708-.708L7.293 8 2.646 3.354l.708-.708z"/></svg></button>
      <div class="result-filter">
        <button class="icon-button" id="resultFilterButton" title="Filter" aria-label="Filter" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v2.5L9 9v4.5l-2 1V9L2 4.5z"/></svg></button>
       <div class="result-filter-menu" id="resultFilterMenu" hidden>
         <label class="result-filter-option"><input id="resultFilter-passing" type="checkbox" data-result-filter-key="passing"/>Show passing tests</label>
         <label class="result-filter-option"><input id="resultFilter-failing" type="checkbox" data-result-filter-key="failing"/>Show failing tests</label>
         <label class="result-filter-option"><input id="resultFilter-notRun" type="checkbox" data-result-filter-key="notRun"/>Show not run tests</label>
         <label class="result-filter-option"><input id="resultFilter-skipped" type="checkbox" data-result-filter-key="skipped"/>Show skipped tests</label>
       </div>
     </div>
   </div>
  <div class="section">
    <button id="saveAsPlaylist" title="Export the tests currently visible in the Test Explorer to a .playlist file" disabled>Save As Playlist</button>
  </div>
  <div class="divider" style="border-top: 1px solid var(--vscode-surface-border);"></div>
  <div class="section">
    <span class="label">Solution Manager</span>
  </div>
  <div class="tabs-wrapper">
    <div class="solution-tabs">
      <div id="solutionTabs" aria-label="Loaded solutions"></div>
      <button class="icon-button" id="addSolution" title="Add Solution..." aria-label="Add solution"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11"/></svg></button>
    </div>
    <div class="section row">
      <span class="label">Playlist</span>
      <span class="name empty" id="playlistName">No playlist selected</span>
      <button class="solid" id="selectPlaylist" title="Select Playlist File...">Select</button>
      <button class="solid" id="clearPlaylist" title="Clear Playlist">Clear</button>
    </div>
    <div class="section runsettings-zone">
      <div class="runsettings-section row">
        <span class="label">Runsettings</span>
        <select id="runsettingsMode" title="Default: use the .runsettings next to the solution. Override: edit the default file's values (stored separately). Custom: pick another .runsettings file (no overrides).">
          <option value="default">Default</option>
          <option value="override">Override</option>
          <option value="custom">Custom</option>
        </select>
        <span class="name empty" id="runsettingsName">None</span>
      </div>
      <button class="solid" id="selectRunsettings" title="Select Runsettings File..." hidden>Select Runsettings File...</button>
      <details id="customRunsettingsSection" hidden>
        <summary>Custom runsettings</summary>
        <div class="custom-content">
          <div class="custom-label" id="customRunsettingsHint">Values are inherited from the selected runsettings file until changed.</div>
          <div id="customRunsettingsGroups"></div>
          <button id="addCustomParameter" title="Add a removable test run parameter">Add parameter</button>
          <div class="custom-warning" id="customRunsettingsWarnings" hidden></div>
        </div>
      </details>
    </div>
    <div class="section row">
      <label class="toggle skip-pre-breakpoint" title="When debugging, automatically continue past the test host's initial Debugger.Break() so the run starts without a manual Continue.">
        <span class="label">Skip pre-breakpoint:</span>
        <input type="checkbox" id="skipPreBreakpoint"/>
      </label>
    </div>
    <div class="section not-found" id="notFoundSection" hidden>
      <div class="label">Playlist tests not found in solution:</div>
      <ul class="not-found-list" id="notFoundList"></ul>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const input = $('filter');

  function createIcon(pathData) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
  }

  function renderSessions(sessions, activeKey) {
    const tabs = $('solutionTabs');
    tabs.replaceChildren();
    (sessions || []).forEach(session => {
       const tab = document.createElement('div');
       tab.className = 'solution-tab' + (session.key === activeKey ? ' active' : '') + (session.loading ? ' loading' : '');
       tab.title = session.detail + (session.loading ? ' (loading)' : session.ready ? ' (ready)' : '');
       const select = document.createElement('button');
       select.className = 'solution-tab-select';
       select.textContent = session.label + (session.loading ? ' (...)' : session.testCount !== undefined ? ' (' + session.testCount + ')' : '');
       select.title = tab.title;
       select.addEventListener('click', () => vscode.postMessage({ type: 'selectSession', key: session.key }));
        const close = document.createElement('button');
        close.className = 'solution-tab-close icon-button';
        close.appendChild(createIcon('m8 7.293 4.646-4.647.708.708L8.707 8l4.647 4.646-.708.708L8 8.707l-4.646 4.647-.708-.708L7.293 8 2.646 3.354l.708-.708z'));
       close.title = 'Unload ' + session.label;
       close.setAttribute('aria-label', 'Unload ' + session.label);
       close.addEventListener('click', event => {
         event.stopPropagation();
         vscode.postMessage({ type: 'removeSolution', key: session.key });
       });
       tab.append(select, close);
       tabs.appendChild(tab);
     });
  }

  function updateSaveAsPlaylist() {
    $('saveAsPlaylist').disabled = input.value.trim().length === 0;
  }

  let debounce;
  input.addEventListener('input', () => {
    updateSaveAsPlaylist();
    clearTimeout(debounce);
    debounce = setTimeout(() => vscode.postMessage({ type: 'filter', text: input.value }), 300);
  });
  $('clearFilter').addEventListener('click', () => {
    input.value = '';
    updateSaveAsPlaylist();
    vscode.postMessage({ type: 'clearFilter' });
  });
  const resultFilterButton = $('resultFilterButton');
  const resultFilterMenu = $('resultFilterMenu');
  function closeResultFilterMenu() {
    resultFilterMenu.hidden = true;
    resultFilterButton.setAttribute('aria-expanded', 'false');
  }
  resultFilterButton.addEventListener('click', event => {
    event.stopPropagation();
    resultFilterMenu.hidden = !resultFilterMenu.hidden;
    resultFilterButton.setAttribute('aria-expanded', String(!resultFilterMenu.hidden));
  });
  resultFilterMenu.addEventListener('click', event => event.stopPropagation());
  resultFilterMenu.querySelectorAll('input[data-result-filter-key]').forEach(checkbox => {
    checkbox.addEventListener('change', () => vscode.postMessage({
      type: 'setResultFilter',
      resultFilterKey: checkbox.dataset.resultFilterKey,
      checked: checkbox.checked
    }));
  });
  document.addEventListener('click', closeResultFilterMenu);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeResultFilterMenu();
    }
  });
   $('saveAsPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'saveAsPlaylist' }));
   $('addSolution').addEventListener('click', () => vscode.postMessage({ type: 'addSolution' }));
  $('selectPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'selectPlaylist' }));
  $('clearPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'clearPlaylist' }));
  $('selectRunsettings').addEventListener('click', () => vscode.postMessage({ type: 'selectRunsettings' }));
  $('runsettingsMode').addEventListener('change', e =>
    vscode.postMessage({ type: 'setRunsettingsMode', mode: e.target.value }));
  $('addCustomParameter').addEventListener('click', () => vscode.postMessage({ type: 'addCustomRunsettingsParameter' }));
  $('skipPreBreakpoint').addEventListener('change', e =>
    vscode.postMessage({ type: 'toggleSkipPreBreakpoint', checked: e.target.checked }));

  const customDebounces = {};
  const pendingCustomValues = Object.create(null);
  let latestCustomRunsettings;
  let latestRunsettingsMode = 'custom';
  let deferredCustomRender = false;
  function postCustomChange(message, debounceKey) {
    clearTimeout(customDebounces[debounceKey]);
    customDebounces[debounceKey] = setTimeout(() => vscode.postMessage(message), 250);
  }

  function isEditingCustomRunsettings() {
    const active = document.activeElement;
    return !!(active && active.dataset && active.dataset.customKey);
  }

  function reconcilePendingCustomValues(custom) {
    const applied = Object.create(null);
    (custom?.parameters || []).forEach(item => { applied[item.key] = item.value; });
    (custom?.values || []).forEach(item => { applied[item.key] = item.value; });
    (custom?.customParameters || []).forEach(item => {
      applied[item.id + ':name'] = item.name;
      applied[item.id + ':value'] = item.value;
    });
    Object.keys(pendingCustomValues).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(applied, key) && applied[key] === pendingCustomValues[key]) {
        delete pendingCustomValues[key];
      }
    });
  }

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

  function setNotFoundTests(tests) {
    const section = $('notFoundSection');
    const list = $('notFoundList');
    list.replaceChildren();
    section.hidden = !tests || tests.length === 0;
    (tests || []).forEach(test => {
      const item = document.createElement('li');
      item.className = 'not-found-item';
      item.textContent = test;
      list.appendChild(item);
    });
  }

  function createCustomInput(value, key, onInput, readOnly) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = Object.prototype.hasOwnProperty.call(pendingCustomValues, key) ? pendingCustomValues[key] : (value ?? '');
    input.dataset.customKey = key;
    input.readOnly = !!readOnly;
    if (!readOnly) {
      input.addEventListener('input', () => {
        pendingCustomValues[key] = input.value;
        onInput(input.value);
      });
      input.addEventListener('blur', () => setTimeout(() => {
        if (deferredCustomRender && !isEditingCustomRunsettings()) {
          deferredCustomRender = false;
          renderCustomRunsettings(latestCustomRunsettings, latestRunsettingsMode);
        }
      }, 0));
    }
    return input;
  }

  function createResetButton(key, overridden) {
    const button = document.createElement('button');
    button.textContent = 'Reset';
    button.disabled = !overridden;
    button.title = 'Use the value from the base runsettings file';
    button.addEventListener('click', () => {
      delete pendingCustomValues[key];
      vscode.postMessage({ type: 'resetCustomRunsettingsValue', key });
    });
    return button;
  }

  function createValueRow(item, parameter) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const label = document.createElement('span');
    label.className = parameter ? 'parameter-name' : 'path';
    label.textContent = parameter ? item.name : item.label;
    label.title = parameter ? item.name : item.label;
    row.appendChild(label);
    row.appendChild(createCustomInput(item.value, item.key, value =>
      postCustomChange({ type: 'setCustomRunsettingsValue', key: item.key, value }, item.key), false));
    row.appendChild(createResetButton(item.key, !!item.overridden));
    return row;
  }

  function createCustomParameterRow(item) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = createCustomInput(item.name, item.id + ':name', value =>
      postCustomChange({ type: 'updateCustomRunsettingsParameter', id: item.id, field: 'name', value }, item.id + ':name'), false);
    name.placeholder = 'Name';
    row.appendChild(name);
    const value = createCustomInput(item.value, item.id + ':value', nextValue =>
      postCustomChange({ type: 'updateCustomRunsettingsParameter', id: item.id, field: 'value', value: nextValue }, item.id + ':value'), false);
    value.placeholder = 'Value';
    row.appendChild(value);
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.title = 'Remove custom parameter';
    remove.addEventListener('click', () => {
      delete pendingCustomValues[item.id + ':name'];
      delete pendingCustomValues[item.id + ':value'];
      vscode.postMessage({ type: 'removeCustomRunsettingsParameter', id: item.id });
    });
    row.appendChild(remove);
    return row;
  }

  function createCustomGroup(section) {
    const group = document.createElement('div');
    group.className = 'custom-group';
    const title = document.createElement('div');
    title.className = 'custom-group-title';
    title.textContent = section;
    group.appendChild(title);
    const rows = document.createElement('div');
    group.appendChild(rows);
    $('customRunsettingsGroups').appendChild(group);
    return rows;
  }

  function renderCustomRunsettings(custom, mode) {
    latestCustomRunsettings = custom;
    latestRunsettingsMode = mode;
    reconcilePendingCustomValues(custom);
    // Extension state is persisted asynchronously. Do not replace this editor
    // with an older state echo while a user is typing in one of its fields.
    if (isEditingCustomRunsettings()) {
      deferredCustomRender = true;
      return;
    }
    deferredCustomRender = false;
    const section = $('customRunsettingsSection');
    // The override editor only exists in Override mode: Default uses the file
    // as-is and Custom files can never be overridden.
    if (mode !== 'override') {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const hint = $('customRunsettingsHint');
    const groups = $('customRunsettingsGroups');
    const warnings = $('customRunsettingsWarnings');
    const add = $('addCustomParameter');
    groups.replaceChildren();
    if (!custom || !custom.available) {
      section.open = false;
      hint.textContent = custom?.unresolved?.[0] || 'Select a runsettings file to customize its values.';
      add.disabled = true;
      warnings.hidden = true;
      return;
    }
    hint.textContent = custom.hasCustomizations
      ? 'Changed values are stored in workspace storage; the original file is never edited.'
      : 'Values are inherited from the selected runsettings file until changed.';
    const groupRows = Object.create(null);
    function rowsFor(sectionName) {
      if (!groupRows[sectionName]) {
        groupRows[sectionName] = createCustomGroup(sectionName);
      }
      return groupRows[sectionName];
    }
    custom.parameters.forEach(item => rowsFor('TestRunParameters').appendChild(createValueRow(item, true)));
    custom.values.forEach(item => rowsFor(item.section).appendChild(createValueRow(item, false)));
    custom.customParameters.forEach(item => rowsFor('TestRunParameters').appendChild(createCustomParameterRow(item)));
    add.disabled = false;
    warnings.hidden = !custom.unresolved || custom.unresolved.length === 0;
    warnings.replaceChildren();
    (custom.unresolved || []).forEach(message => {
      const line = document.createElement('div');
      line.textContent = message;
      warnings.appendChild(line);
    });
  }

  window.addEventListener('message', event => {
    const s = event.data;
    if (s.type !== 'state') { return; }
    renderSessions(s.sessions, s.activeSessionKey);
    // Never stomp the input while the user is typing: state echoes carry the
    // last *applied* filter, which lags in-progress text by the debounce.
    if (document.activeElement !== input && input.value !== (s.filter ?? '')) {
      input.value = s.filter ?? '';
    }
    ['passing', 'failing', 'notRun', 'skipped'].forEach(key => {
      $('resultFilter-' + key).checked = s.resultFilter?.[key] !== false;
    });
    updateSaveAsPlaylist();
    setName($('playlistName'), s.playlistName, 'No playlist selected', s.playlistFull);
    setName($('runsettingsName'), s.runsettingsName, 'None', s.runsettingsFull);
    const modeSelect = $('runsettingsMode');
    modeSelect.value = s.runsettingsMode ?? 'custom';
    modeSelect.disabled = !s.solutionReady;
    modeSelect.querySelector('option[value="default"]').disabled = !s.defaultRunsettingsAvailable;
    modeSelect.querySelector('option[value="override"]').disabled = !s.defaultRunsettingsAvailable;
    $('selectPlaylist').disabled = !s.solutionReady;
    $('clearPlaylist').disabled = !s.playlistName;
    $('selectRunsettings').hidden = s.runsettingsMode !== 'custom';
    $('selectRunsettings').disabled = !s.solutionReady;
    $('skipPreBreakpoint').checked = !!s.skipPreBreakpoint;
    setNotFoundTests(s.notFoundTests);
    renderCustomRunsettings(s.customRunsettings, s.runsettingsMode);
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
