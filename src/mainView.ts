import * as vscode from 'vscode';
import * as path from 'path';
import { CustomRunsettingsViewState } from './runsettingsManager';
import { TestResultFilter, TestResultFilterKey, createDefaultTestResultFilter } from './testResultFilter';
import { ScreenshotOptions, ScreenshotSnapshot } from './screenshot';

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
  screenshotEmpty: boolean;
  playlistPath?: string;
  runsettingsPath?: string;
  runsettingsIsDefault: boolean;
  runsettingsMode: RunsettingsMode;
  defaultRunsettingsAvailable: boolean;
  hasExplicitRunsettings: boolean;
  filter: string;
  searchAllSolutions: boolean;
  resultFilter: TestResultFilter;
  skipPreBreakpoint: boolean;
  notFoundTests: string[];
  customRunsettings?: CustomRunsettingsViewState;
  controlApiEnabled: boolean;
  controlApiRunningPort?: number;
}

export interface ScreenshotExportSettings extends ScreenshotOptions {
  saveImage: boolean;
  customSavePath: boolean;
}

export type MainViewAction =
  | { type: 'addSolution' | 'selectPlaylist' | 'clearPlaylist' | 'selectRunsettings' | 'clearRunsettings' | 'openRunsettings' | 'saveAsPlaylist' | 'openScreenshot' | 'closeScreenshot' | 'selectScreenshotSavePath' }
  | { type: 'removeSolution'; key?: string }
  | { type: 'selectSession'; key: string }
  | { type: 'setRunsettingsMode'; mode: RunsettingsMode }
  | { type: 'filter'; text: string }
  | { type: 'toggleSearchAllSolutions'; checked: boolean }
  | { type: 'clearFilter' }
  | { type: 'setResultFilter'; key: TestResultFilterKey; checked: boolean }
  | { type: 'toggleSkipPreBreakpoint'; checked: boolean }
  | { type: 'toggleControlApi'; checked: boolean }
  | { type: 'setCustomRunsettingsValue'; key: string; value: string }
  | { type: 'resetCustomRunsettingsValue'; key: string }
  | { type: 'addCustomRunsettingsParameter' }
  | { type: 'updateCustomRunsettingsParameter'; id: string; field: 'name' | 'value'; value: string }
  | { type: 'removeCustomRunsettingsParameter'; id: string }
  | { type: 'requestScreenshotPreview'; settings: ScreenshotExportSettings }
  | { type: 'saveScreenshot'; data: string; savePath?: string };

interface WebviewMessage {
  type: string;
  text?: string;
  checked?: boolean;
  key?: string;
  value?: string;
  id?: string;
  field?: 'name' | 'value';
  mode?: RunsettingsMode;
  resultFilterKey?: TestResultFilterKey;
  settings?: ScreenshotExportSettings;
  data?: string;
  savePath?: string;
}

export class MainViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private screenshotPanel: vscode.WebviewPanel | undefined;
  private state: MainViewState = {
    sessions: [],
    solutionReady: false,
    screenshotEmpty: true,
    runsettingsIsDefault: false,
    runsettingsMode: 'default',
    defaultRunsettingsAvailable: false,
    hasExplicitRunsettings: false,
    filter: '',
    searchAllSolutions: false,
    resultFilter: createDefaultTestResultFilter(),
    skipPreBreakpoint: true,
    notFoundTests: [],
    customRunsettings: undefined,
    controlApiEnabled: false,
    controlApiRunningPort: undefined
  };

  constructor(private readonly onAction: (action: MainViewAction) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml();
    view.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
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

  openScreenshotPanel(): void {
    if (this.screenshotPanel) {
      this.screenshotPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dotnet-testing-plus.screenshot',
      'Export Test Screenshot',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.screenshotPanel = panel;
    panel.webview.html = renderHtml(true);
    panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    panel.onDidDispose(() => {
      if (this.screenshotPanel === panel) {
        this.screenshotPanel = undefined;
      }
    });
  }

  closeScreenshotPanel(): void {
    this.screenshotPanel?.dispose();
  }

  postScreenshotPreview(snapshot: ScreenshotSnapshot): void {
    void this.screenshotPanel?.webview.postMessage({ type: 'screenshotPreview', snapshot });
  }

  postScreenshotPath(savePath: string): void {
    void this.screenshotPanel?.webview.postMessage({ type: 'screenshotPath', savePath });
  }

  postScreenshotSaveResult(message: string, error = false): void {
    void this.screenshotPanel?.webview.postMessage({ type: 'screenshotSaveResult', message, error });
  }

  private handleMessage(msg: WebviewMessage): void {
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
    } else if (msg.type === 'toggleControlApi') {
      this.onAction({ type: 'toggleControlApi', checked: !!msg.checked });
    } else if (msg.type === 'toggleSearchAllSolutions') {
      this.onAction({ type: 'toggleSearchAllSolutions', checked: !!msg.checked });
    } else if (msg.type === 'setCustomRunsettingsValue' && msg.key !== undefined) {
      this.onAction({ type: 'setCustomRunsettingsValue', key: msg.key, value: msg.value ?? '' });
    } else if (msg.type === 'resetCustomRunsettingsValue' && msg.key !== undefined) {
      this.onAction({ type: 'resetCustomRunsettingsValue', key: msg.key });
    } else if (msg.type === 'addCustomRunsettingsParameter') {
      this.onAction({ type: 'addCustomRunsettingsParameter' });
    } else if (msg.type === 'updateCustomRunsettingsParameter' && msg.id !== undefined && msg.field !== undefined) {
      this.onAction({ type: 'updateCustomRunsettingsParameter', id: msg.id, field: msg.field, value: msg.value ?? '' });
    } else if (msg.type === 'removeCustomRunsettingsParameter' && msg.id !== undefined) {
      this.onAction({ type: 'removeCustomRunsettingsParameter', id: msg.id });
    } else if (msg.type === 'requestScreenshotPreview' && msg.settings !== undefined) {
      this.onAction({ type: 'requestScreenshotPreview', settings: msg.settings });
    } else if (msg.type === 'saveScreenshot' && msg.data !== undefined) {
      this.onAction({ type: 'saveScreenshot', data: msg.data, savePath: msg.savePath });
    } else {
      this.onAction({ type: msg.type } as MainViewAction);
    }
  }

  private postState(): void {
    const s = this.state;
    const state = {
      type: 'state',
      sessions: s.sessions,
      activeSessionKey: s.activeSessionKey,
      solutionReady: s.solutionReady,
      screenshotEmpty: s.screenshotEmpty,
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
      searchAllSolutions: s.searchAllSolutions,
      resultFilter: s.resultFilter,
      skipPreBreakpoint: s.skipPreBreakpoint,
      controlApiEnabled: s.controlApiEnabled,
      controlApiRunningPort: s.controlApiRunningPort,
      notFoundTests: s.notFoundTests,
      customRunsettings: s.customRunsettings
    };
    void this.view?.webview.postMessage(state);
    void this.screenshotPanel?.webview.postMessage(state);
  }
}

function renderHtml(screenshotOnly = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;">
<style>
  body {
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  #mainContent { display: flex; flex-direction: column; gap: 8px; }
  .advanced-search-header { display: flex; align-items: center; justify-content: space-between; position: relative; }
  .help-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--vscode-descriptionForeground, #888);
    color: var(--vscode-descriptionForeground, #888);
    background: transparent;
    font-size: 11px;
    font-weight: bold;
    line-height: 1;
    padding: 0;
    cursor: pointer;
    user-select: none;
  }
  .help-button:hover, .help-button[aria-expanded="true"] {
    color: var(--vscode-foreground);
    border-color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }
  .help-popup {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    right: 0;
    max-width: 310px;
    padding: 10px 12px;
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, #ccc));
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #454545));
    border-radius: 6px;
    box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    font-size: 12px;
    line-height: 1.45;
    white-space: normal;
  }
  .help-popup[hidden] { display: none; }
  .help-popup-title { font-weight: 600; margin-bottom: 2px; margin-top: 6px; color: var(--vscode-foreground); }
  .help-popup-title:first-child { margin-top: 0; }
  .help-popup-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
  .help-popup-note { margin-top: 6px; font-style: italic; opacity: 0.85; }
  .help-popup-example { margin-top: 6px; }
  .help-popup-example code {
    display: inline-block;
    background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.25));
    padding: 2px 5px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    word-break: break-word;
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
  .solution-tab-select { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: transparent; color: inherit; height: 100%; text-box: trim-both cap alphabetic; }
  .solution-tab-close { background: transparent; color: inherit; padding: 3px; width: 18px; height: 100%; }
  .solution-tab-close:hover:not(:disabled) { background: var(--vscode-modernEditorTab-activeHoverBackground); }
  #addSolution { display: flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; line-height: 1; }
  #addSolution.with-text { width: auto; padding: 3px 8px; gap: 6px; }
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
  .row[hidden] { display: none; }
  .section .label { font-weight: 600; }
  .section .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .section .name.empty { opacity: 0.6; font-style: italic; }
  .section .name.clickable { cursor: pointer; }
  .section .name.clickable:hover { text-decoration: underline; }
  .toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .skip-pre-breakpoint { display: inline-flex; flex-direction: row; align-items: center; }
  .toggle input { margin: 0; }
  /* Switch toggle styling */
  .switch-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  .switch-toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    margin: 0;
    pointer-events: none;
  }
  .switch-track {
    position: relative;
    display: inline-block;
    width: 28px;
    height: 16px;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #555));
    border-radius: 8px;
    transition: background-color 0.15s ease, border-color 0.15s ease;
    flex-shrink: 0;
  }
  .switch-thumb {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 10px;
    height: 10px;
    background: var(--vscode-foreground, #ccc);
    border-radius: 50%;
    transform: translateY(-50%);
    transition: transform 0.15s ease, background-color 0.15s ease;
  }
  .switch-toggle input:checked + .switch-track {
    background: var(--vscode-button-background, #0e639c);
    border-color: var(--vscode-button-background, #0e639c);
  }
  .switch-toggle input:checked + .switch-track .switch-thumb {
    transform: translate(12px, -50%);
    background: var(--vscode-button-foreground, #ffffff);
  }
  .switch-toggle:focus-within .switch-track {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
  }
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
   .export-actions { display: flex; gap: 6px; align-items: center; }
   #saveAsPlaylist { align-self: flex-start; }
  .not-found { display: flex; flex-direction: column; gap: 4px; }
  .not-found[hidden] { display: none; }
  .not-found .label { font-weight: 600; margin-top: 4px; }
  .not-found-list { margin-top: 4px; opacity: 0.8; list-style-type: disc; padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
   .not-found-item { overflow-wrap: anywhere; }
  ${screenshotOnly ? screenshotCss() : ''}
</style>
</head>
<body class="${screenshotOnly ? 'screenshot-only' : ''}">
  <div id="mainContent">
  <div class="section advanced-search-header">
    <span class="label">Advanced Search</span>
    <button class="help-button" id="searchHelpButton" type="button" title="Advanced Search syntax help" aria-label="Advanced Search syntax help" aria-expanded="false">?</button>
    <div class="help-popup" id="searchHelpPopup" hidden>
      <div class="help-popup-title">Filters:</div>
      <ul class="help-popup-list">
        <li><strong>Class</strong> — search through class names;</li>
        <li><strong>Project</strong> — search through project names.</li>
      </ul>
      <div class="help-popup-title">Modifiers:</div>
      <ul class="help-popup-list">
        <li><strong>:</strong> — searches within the full name;</li>
        <li><strong>=</strong> — does an exact search.</li>
      </ul>
      <div class="help-popup-title">Connectors:</div>
      <ul class="help-popup-list">
        <li><strong>&amp;</strong> — Boolean AND;</li>
        <li><strong>|</strong> — Boolean OR;</li>
        <li><strong>( ... )</strong> — Parentheses for custom precedence and grouping.</li>
      </ul>
      <div class="help-popup-note">Note: spaces are ignored.</div>
      <div class="help-popup-example">
        <div class="help-popup-title">Example:</div>
        <code>class:Checkout &amp; (project=Web | class:Cart)</code>
      </div>
    </div>
  </div>
  <div class="filter-row">
      <input id="filter" type="text"
        placeholder="Filter: class:Checkout & (project=Web|class:Cart)"/>
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
    <div class="section row search-all-solutions-row" id="searchAllSolutionsRow" hidden>
      <label class="toggle search-all-solutions" title="Apply the Advanced Search filter to every loaded solution instead of only the selected one.">
        <input type="checkbox" id="searchAllSolutions"/>
        <span class="label">Search in All Solutions</span>
      </label>
    </div>
    <div class="section export-actions">
     <button id="saveAsPlaylist" title="Export the tests currently visible in the Test Explorer to a .playlist file" disabled>Save As Playlist</button>
     <button id="exportScreenshot" title="Export an image of the visible test results">Export Screenshot</button>
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
    <div class="divider" style="border-top: 1px solid var(--vscode-surface-border);"></div>
    <div class="section control-api-section">
      <div class="row">
        <label class="switch-toggle" title="Exposes an internal API that allows LLMs to interact with the extension. Install the corresponding skill though the &apos;Install Agent Skill&apos; option in the dropdown.">
          <input type="checkbox" id="controlApiEnabled"/>
          <span class="switch-track"><span class="switch-thumb"></span></span>
          <span class="label">Expose to Agents (Experimental)</span>
        </label>
      </div>
      <div class="row control-api-port-row" id="controlApiPortRow" hidden>
        <span class="label">Port:</span>
        <span class="name" id="controlApiPortDisplay"></span>
      </div>
    </div>
  </div>
  ${screenshotOnly ? screenshotModalHtml() : ''}
<script>
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const input = $('filter');
  const screenshotOnly = document.body.classList.contains('screenshot-only');

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
    const list = sessions || [];
    const addBtn = $('addSolution');
    if (addBtn) {
      const textSpan = $('addSolutionText');
      if (list.length === 0) {
        addBtn.classList.add('with-text');
        if (!textSpan) {
          const span = document.createElement('span');
          span.id = 'addSolutionText';
          span.textContent = 'Add Solution';
          addBtn.insertBefore(span, addBtn.firstChild);
        }
      } else {
        addBtn.classList.remove('with-text');
        if (textSpan) {
          textSpan.remove();
        }
      }
    }
    list.forEach(session => {
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
  let userEditedFilter = false;
  input.addEventListener('input', () => {
    userEditedFilter = true;
    updateSaveAsPlaylist();
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      vscode.postMessage({ type: 'filter', text: input.value });
    }, 300);
  });
  $('clearFilter').addEventListener('click', () => {
    userEditedFilter = false;
    clearTimeout(debounce);
    debounce = undefined;
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

  const searchHelpButton = $('searchHelpButton');
  const searchHelpPopup = $('searchHelpPopup');
  function closeSearchHelp() {
    searchHelpPopup.hidden = true;
    searchHelpButton.setAttribute('aria-expanded', 'false');
  }
  function openSearchHelp() {
    searchHelpPopup.hidden = false;
    searchHelpButton.setAttribute('aria-expanded', 'true');
  }
  let helpPinned = false;
  searchHelpButton.addEventListener('click', event => {
    event.stopPropagation();
    helpPinned = !helpPinned;
    if (helpPinned) {
      openSearchHelp();
    } else {
      closeSearchHelp();
    }
  });
  searchHelpButton.addEventListener('mouseenter', () => {
    if (!helpPinned) {
      openSearchHelp();
    }
  });
  searchHelpButton.addEventListener('mouseleave', event => {
    if (!helpPinned && (!event.relatedTarget || !searchHelpPopup.contains(event.relatedTarget))) {
      closeSearchHelp();
    }
  });
  searchHelpPopup.addEventListener('mouseleave', event => {
    if (!helpPinned && (!event.relatedTarget || !searchHelpButton.contains(event.relatedTarget))) {
      closeSearchHelp();
    }
  });
  searchHelpPopup.addEventListener('click', event => event.stopPropagation());

  document.addEventListener('click', () => {
    closeResultFilterMenu();
    helpPinned = false;
    closeSearchHelp();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeResultFilterMenu();
      helpPinned = false;
      closeSearchHelp();
    }
  });
    $('saveAsPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'saveAsPlaylist' }));
    $('addSolution').addEventListener('click', () => vscode.postMessage({ type: 'addSolution' }));
    $('exportScreenshot').addEventListener('click', () => vscode.postMessage({ type: 'openScreenshot' }));
    $('runsettingsName').addEventListener('click', () => {
      if ($('runsettingsName').classList.contains('clickable')) {
        vscode.postMessage({ type: 'openRunsettings' });
      }
    });
    let latestSessions = [];
    let screenshotPreviewUrl;
    let screenshotPng;
    let screenshotPreviewRequest = 0;

    function screenshotSettings() {
      return {
        solutionKeys: Array.from(document.querySelectorAll('#screenshotSolutions input[type="checkbox"]'))
          .filter(input => input.checked && !input.disabled)
          .map(input => input.dataset.solutionKey),
        groupBy: $('screenshotGroupBy').value,
        show: {
          passing: $('screenshotShowPassing').checked,
          failing: $('screenshotShowFailing').checked,
          skipped: $('screenshotShowSkipped').checked,
          notRun: $('screenshotShowNotRun').checked
        },
        collapsePassingGroups: $('screenshotCollapsePassing').checked,
        showExecutionTime: $('screenshotShowTime').checked,
        saveImage: $('screenshotSaveImage').checked,
        customSavePath: $('screenshotCustomPath').checked
      };
    }

    function updateScreenshotPathControls() {
      const save = $('screenshotSaveImage').checked;
      const custom = $('screenshotCustomPath');
      custom.disabled = !save;
      $('screenshotPathSection').hidden = !save || !custom.checked;
      if (!save || !custom.checked || $('screenshotSavePath').value) {
        $('screenshotPathError').hidden = true;
      }
    }

    function renderScreenshotSolutions() {
      const container = $('screenshotSolutions');
      container.replaceChildren();
      latestSessions.forEach(session => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.solutionKey = session.key;
        input.checked = !!session.ready;
        input.disabled = !session.ready;
        input.title = session.ready ? session.detail : 'Tests are still loading for this solution.';
        input.addEventListener('change', scheduleScreenshotPreview);
        const name = document.createElement('span');
        name.textContent = session.label + (session.ready ? '' : ' (loading)');
        name.title = session.detail;
        label.append(input, name);
        container.appendChild(label);
      });
    }

    function openScreenshotModal() {
      renderScreenshotSolutions();
      $('screenshotGroupBy').value = 'project';
      $('screenshotShowPassing').checked = true;
      $('screenshotShowFailing').checked = true;
      $('screenshotShowSkipped').checked = false;
      $('screenshotShowNotRun').checked = false;
      $('screenshotCollapsePassing').checked = true;
      $('screenshotShowTime').checked = false;
      $('screenshotSaveImage').checked = true;
      $('screenshotCustomPath').checked = false;
      $('screenshotSavePath').value = '';
      $('screenshotExportStatus').textContent = '';
      $('screenshotExportStatus').classList.remove('error');
      updateScreenshotPathControls();
      $('screenshotModal').hidden = false;
      scheduleScreenshotPreview();
    }

    function closeScreenshotModal() {
      if (document.body.classList.contains('screenshot-only')) {
        vscode.postMessage({ type: 'closeScreenshot' });
        return;
      }
      $('screenshotModal').hidden = true;
    }

    function xmlText(value) {
      return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function formatDuration(duration) {
      if (duration === undefined) { return ''; }
      if (duration < 1000) { return duration + ' ms'; }
      if (duration < 60000) {
        const seconds = (duration / 1000).toFixed(duration < 10000 ? 2 : 1);
        return (seconds.endsWith('.0') ? seconds.slice(0, -2) : seconds) + ' s';
      }
      const seconds = Math.round(duration / 1000);
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }

    function screenshotTheme() {
      const style = getComputedStyle(document.body);
      const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
      return {
        background: color('--vscode-editor-background', '#1e1e1e'),
        foreground: color('--vscode-editor-foreground', '#cccccc'),
        muted: color('--vscode-descriptionForeground', '#9d9d9d'),
        border: color('--vscode-widget-border', '#454545'),
        passed: color('--vscode-testing-iconPassed', '#73c991'),
        failed: color('--vscode-testing-iconFailed', '#f48771'),
        skipped: color('--vscode-testing-iconSkipped', '#cca700'),
        notRun: color('--vscode-testing-iconUnset', '#a0a0a0')
      };
    }

    function statusIcon(state, x, y, theme) {
      const color = theme[state] || theme.notRun;
      if (state === 'passed') {
        return '<path d="M' + (x - 5) + ' ' + y + 'l3 3 6-7" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      }
      if (state === 'failed') {
        return '<circle cx="' + x + '" cy="' + (y - 2) + '" r="6" fill="none" stroke="' + color + '" stroke-width="1.5"/><path d="M' + (x - 3) + ' ' + (y - 5) + 'l6 6m0-6l-6 6" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
      if (state === 'skipped') {
        return '<circle cx="' + x + '" cy="' + (y - 2) + '" r="5.5" fill="none" stroke="' + color + '" stroke-width="1.5"/><path d="M' + (x - 3.5) + ' ' + (y + 1.5) + 'l7-7" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round"/>';
      }
      return '<circle cx="' + x + '" cy="' + (y - 2) + '" r="5" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
    }

    function chevron(expanded, x, y, theme) {
      const path = expanded
        ? 'M' + (x - 4) + ' ' + (y - 6) + 'l4 4 4-4'
        : 'M' + (x - 2) + ' ' + (y - 8) + 'l4 4-4 4';
      return '<path d="' + path + '" fill="none" stroke="' + theme.muted + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    }

    function shownChildren(node, settings) {
      return settings.collapsePassingGroups && node.kind !== 'solution' && node.state === 'passed' ? [] : (node.children || []);
    }

    function screenshotBlocks(snapshot, settings) {
      const blocks = [];
      snapshot.solutions.forEach(solution => {
        if (settings.groupBy === 'test') {
          solution.children.forEach(test => blocks.push({ solution, test, rows: 2 }));
          return;
        }
        solution.children.forEach(project => {
          if (settings.groupBy === 'project' || (settings.collapsePassingGroups && project.state === 'passed')) {
            blocks.push({ solution, project, group: project, rows: 2 + shownChildren(project, settings).length });
            return;
          }
          project.children.forEach(group => blocks.push({
            solution,
            project,
            group,
            rows: 3 + shownChildren(group, settings).length
          }));
        });
      });
      return blocks;
    }

    function packScreenshotBlocks(blocks, columnWidth) {
      if (blocks.length === 0) { return [[]]; }
      const totalRows = blocks.reduce((sum, block) => sum + block.rows, 0);
      const suggested = Math.max(1, Math.min(6, Math.round(Math.sqrt(totalRows * 23 / columnWidth))));
      let best;
      for (let count = 1; count <= Math.min(6, blocks.length); count++) {
        const columns = Array.from({ length: count }, () => ({ rows: 0, blocks: [] }));
        blocks.forEach(block => {
          columns.sort((a, b) => a.rows - b.rows);
          columns[0].blocks.push(block);
          columns[0].rows += block.rows;
        });
        const tallest = Math.max(...columns.map(column => column.rows));
        const score = Math.abs(Math.log((count * columnWidth) / Math.max(180, tallest * 23))) + Math.abs(count - suggested) * 0.08;
        if (!best || score < best.score) { best = { score, columns }; }
      }
      return best.columns.map(column => column.blocks);
    }

    function renderScreenshotSvg(snapshot, settings) {
      const theme = screenshotTheme();
      const textContext = document.createElement('canvas').getContext('2d');
      if (textContext) {
        textContext.font = '13px ' + getComputedStyle(document.body).fontFamily;
      }
      let widestLabel = 0;
      function measureLabels(nodes) {
        nodes.forEach(node => {
          const label = node.label + (node.kind === 'test' ? '' : ' (' + node.passed + '/' + node.total + ')');
          widestLabel = Math.max(widestLabel, textContext ? textContext.measureText(label).width : label.length * 8);
          if (node.kind !== 'test') { measureLabels(node.children); }
        });
      }
      measureLabels(snapshot.solutions);
      // Ensure column width accommodates the widest label plus indent/icon offsets and optional duration column.
      const columnWidth = settings.showExecutionTime
        ? Math.max(460, Math.ceil(widestLabel + 140))
        : Math.max(340, Math.ceil(widestLabel + 100));
      const columns = packScreenshotBlocks(screenshotBlocks(snapshot, settings), columnWidth);
      const padding = 18;
      const rowHeight = 23;
      let maxHeight = 0;
      const content = [];
      function row(node, x, y, indent, group, collapsed) {
        const name = node.label + (group ? ' (' + node.passed + '/' + node.total + ')' : '');
        const duration = settings.showExecutionTime ? formatDuration(node.durationMs) : '';
        const available = group ? 29 : 17;
        if (group) {
          content.push(chevron(!collapsed, x + indent + 5, y, theme));
        }
        content.push(statusIcon(node.state, x + indent + available + 7, y - 2, theme));
        content.push('<text x="' + (x + indent + available + 20) + '" y="' + y + '" fill="' + theme.foreground + '" font-size="13" font-weight="' + (group ? '600' : '400') + '">' + xmlText(name) + '</text>');
        if (duration) {
          content.push('<text x="' + (x + columnWidth - 12) + '" y="' + y + '" fill="' + theme.muted + '" font-size="11" text-anchor="end">' + xmlText(duration) + '</text>');
        }
        return y + rowHeight;
      }
      columns.forEach((blocks, columnIndex) => {
        const x = padding + columnIndex * columnWidth;
        let y = padding + 16;
        let previousSolution;
        let previousProject;
        blocks.forEach(block => {
          let startsProject = false;
          if (previousSolution !== block.solution.label) {
            y = row(block.solution, x, y, 0, true, false);
            previousSolution = block.solution.label;
            previousProject = undefined;
          }
          if (block.project && previousProject !== block.project.label) {
            y = row(block.project, x, y, 13, true, settings.collapsePassingGroups && block.project.state === 'passed');
            previousProject = block.project.label;
            startsProject = true;
            if (settings.collapsePassingGroups && block.project.state === 'passed') {
              y += 4;
              return;
            }
          }
          if (block.group && block.group !== block.project) {
            const children = shownChildren(block.group, settings);
            if (startsProject) { y += 4; }
            y = row(block.group, x, y, 28, true, children.length === 0 && block.group.total > 0);
            children.forEach(test => { y = row(test, x, y, 45, false, false); });
          } else if (block.group) {
            const children = shownChildren(block.group, settings);
            children.forEach(test => { y = row(test, x, y, 30, false, false); });
          } else if (block.test) {
            y = row(block.test, x, y, 20, false, false);
          }
          y += 4;
        });
        maxHeight = Math.max(maxHeight, y + padding);
      });
      const width = columns.length * columnWidth + padding * 2;
      const height = Math.max(100, Math.ceil(maxHeight));
      return { width, height, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="100%" height="100%" fill="' + theme.background + '"/><rect x="0.5" y="0.5" width="' + (width - 1) + '" height="' + (height - 1) + '" fill="none" stroke="' + theme.border + '"/><g font-family="' + xmlText(getComputedStyle(document.body).fontFamily) + '">' + content.join('') + '</g></svg>' };
    }

    function rasterizeScreenshot(rendered) {
      return new Promise((resolve, reject) => {
        const source = new Blob([rendered.svg], { type: 'image/svg+xml' });
        const sourceUrl = URL.createObjectURL(source);
        const image = new Image();
        image.onload = () => {
          URL.revokeObjectURL(sourceUrl);
          const canvas = document.createElement('canvas');
          canvas.width = rendered.width * 2;
          canvas.height = rendered.height * 2;
          const context = canvas.getContext('2d');
          if (!context) { reject(new Error('Could not create an image canvas.')); return; }
          context.scale(2, 2);
          context.drawImage(image, 0, 0);
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create a PNG image.')), 'image/png');
        };
        image.onerror = () => { URL.revokeObjectURL(sourceUrl); reject(new Error('Could not render the screenshot preview.')); };
        image.src = sourceUrl;
      });
    }

    function showScreenshotStatus(message, error) {
      const status = $('screenshotExportStatus');
      status.textContent = message;
      status.classList.toggle('error', !!error);
    }

    function requestScreenshotPreview() {
      if ($('screenshotModal').hidden) { return; }
      screenshotPng = undefined;
      $('confirmScreenshot').disabled = true;
      $('screenshotPreviewFrame').replaceChildren(Object.assign(document.createElement('span'), { className: 'screenshot-preview-empty', textContent: 'Preparing preview...' }));
      vscode.postMessage({ type: 'requestScreenshotPreview', settings: screenshotSettings() });
    }

    let screenshotPreviewDebounce;
    function scheduleScreenshotPreview() {
      screenshotPng = undefined;
      $('confirmScreenshot').disabled = true;
      clearTimeout(screenshotPreviewDebounce);
      screenshotPreviewDebounce = setTimeout(requestScreenshotPreview, 80);
    }

    function showScreenshotPreview(snapshot) {
      const request = ++screenshotPreviewRequest;
      const rendered = renderScreenshotSvg(snapshot, screenshotSettings());
      const svgUrl = URL.createObjectURL(new Blob([rendered.svg], { type: 'image/svg+xml' }));
      if (screenshotPreviewUrl) { URL.revokeObjectURL(screenshotPreviewUrl); }
      screenshotPreviewUrl = svgUrl;
      const preview = document.createElement('img');
      preview.src = svgUrl;
      preview.alt = 'Test results screenshot preview';
      $('screenshotPreviewFrame').replaceChildren(preview);
      rasterizeScreenshot(rendered).then(blob => {
        if (request !== screenshotPreviewRequest) { return; }
        screenshotPng = blob;
        $('confirmScreenshot').disabled = snapshot.total === 0;
        showScreenshotStatus(snapshot.total === 0 ? 'No tests match the selected options.' : '', false);
      }).catch(error => {
        if (request !== screenshotPreviewRequest) { return; }
        screenshotPng = undefined;
        $('confirmScreenshot').disabled = true;
        showScreenshotStatus(error.message || String(error), true);
      });
    }

    function blobAsBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error || new Error('Could not read the PNG image.'));
        reader.readAsDataURL(blob);
      });
    }

    async function exportScreenshot() {
      const settings = screenshotSettings();
      if (settings.saveImage && settings.customSavePath && !$('screenshotSavePath').value) {
        $('screenshotPathError').hidden = false;
        return;
      }
      if (!screenshotPng) { return; }
      const image = screenshotPng;
      let clipboardError;
      try {
        if (!navigator.clipboard || !window.ClipboardItem) { throw new Error('Image clipboard support is unavailable in this VS Code version.'); }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      } catch (error) {
        clipboardError = error instanceof Error ? error.message : String(error);
      }
      if (settings.saveImage) {
        try {
          const data = await blobAsBase64(image);
          vscode.postMessage({ type: 'saveScreenshot', data, savePath: settings.customSavePath ? $('screenshotSavePath').value : undefined });
          showScreenshotStatus(clipboardError ? 'Image save requested. Clipboard copy failed: ' + clipboardError : 'Image copied. Saving PNG...', !!clipboardError);
        } catch (error) {
          showScreenshotStatus('Could not prepare PNG: ' + (error.message || String(error)), true);
        }
      } else if (clipboardError) {
        showScreenshotStatus('Clipboard copy failed: ' + clipboardError, true);
      } else {
        showScreenshotStatus('Image copied to the clipboard.', false);
      }
    }

    if (screenshotOnly) {
      $('cancelScreenshot').addEventListener('click', closeScreenshotModal);
      $('confirmScreenshot').addEventListener('click', exportScreenshot);
      $('selectScreenshotPath').addEventListener('click', () => vscode.postMessage({ type: 'selectScreenshotSavePath' }));
      ['screenshotGroupBy', 'screenshotShowPassing', 'screenshotShowFailing', 'screenshotShowSkipped', 'screenshotShowNotRun', 'screenshotCollapsePassing', 'screenshotShowTime'].forEach(id =>
        $(id).addEventListener('change', scheduleScreenshotPreview));
      $('screenshotSaveImage').addEventListener('change', updateScreenshotPathControls);
      $('screenshotCustomPath').addEventListener('change', updateScreenshotPathControls);
    }
  $('selectPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'selectPlaylist' }));
  $('clearPlaylist').addEventListener('click', () => vscode.postMessage({ type: 'clearPlaylist' }));
  $('selectRunsettings').addEventListener('click', () => vscode.postMessage({ type: 'selectRunsettings' }));
  $('runsettingsMode').addEventListener('change', e =>
    vscode.postMessage({ type: 'setRunsettingsMode', mode: e.target.value }));
  $('addCustomParameter').addEventListener('click', () => vscode.postMessage({ type: 'addCustomRunsettingsParameter' }));
  $('skipPreBreakpoint').addEventListener('change', e =>
    vscode.postMessage({ type: 'toggleSkipPreBreakpoint', checked: e.target.checked }));
  $('controlApiEnabled').addEventListener('change', e =>
    vscode.postMessage({ type: 'toggleControlApi', checked: e.target.checked }));
  $('searchAllSolutions').addEventListener('change', e =>
    vscode.postMessage({ type: 'toggleSearchAllSolutions', checked: e.target.checked }));

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

    let screenshotPanelInitialized = false;
    let previousActiveSessionKey;
    window.addEventListener('message', event => {
      const s = event.data;
      if (s.type === 'screenshotPreview') {
        showScreenshotPreview(s.snapshot);
        return;
      }
      if (s.type === 'screenshotPath') {
        $('screenshotSavePath').value = s.savePath || '';
        $('screenshotPathError').hidden = !!s.savePath;
        return;
      }
      if (s.type === 'screenshotSaveResult') {
        showScreenshotStatus(s.message, !!s.error);
        return;
      }
      if (s.type !== 'state') { return; }
    const sessionSwitched = previousActiveSessionKey !== undefined && previousActiveSessionKey !== s.activeSessionKey;
    previousActiveSessionKey = s.activeSessionKey;
    latestSessions = s.sessions || [];
    renderSessions(s.sessions, s.activeSessionKey);
    if (sessionSwitched) {
      userEditedFilter = false;
    }
    // Never stomp the input while the user is typing or if the user has typed
    // something newer than the state echo. The input the user is typing in is
    // the source of truth.
    if (document.activeElement !== input && !debounce && !userEditedFilter && input.value !== (s.filter ?? '')) {
      input.value = s.filter ?? '';
    } else if (!userEditedFilter && (s.filter ?? '') === input.value) {
      userEditedFilter = false;
    }
    ['passing', 'failing', 'notRun', 'skipped'].forEach(key => {
      $('resultFilter-' + key).checked = s.resultFilter?.[key] !== false;
    });
    updateSaveAsPlaylist();
    setName($('playlistName'), s.playlistName, 'No playlist selected', s.playlistFull);
    setName($('runsettingsName'), s.runsettingsName, 'None', s.runsettingsFull);
    const runsettingsNameEl = $('runsettingsName');
    if (s.runsettingsFull && (s.runsettingsMode === 'default' || s.runsettingsMode === 'custom')) {
      runsettingsNameEl.classList.add('clickable');
      runsettingsNameEl.title = 'Click to open file in editor';
    } else {
      runsettingsNameEl.classList.remove('clickable');
    }
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
    $('controlApiEnabled').checked = !!s.controlApiEnabled;
    if (s.controlApiEnabled && s.controlApiRunningPort) {
      $('controlApiPortRow').hidden = false;
      $('controlApiPortDisplay').textContent = String(s.controlApiRunningPort);
    } else {
      $('controlApiPortRow').hidden = true;
    }
    const multiSolutions = (s.sessions || []).length > 1;
    $('searchAllSolutionsRow').hidden = !multiSolutions;
    $('searchAllSolutions').checked = !!s.searchAllSolutions;
    $('exportScreenshot').disabled = !latestSessions.some(session => session.ready) || !!s.screenshotEmpty;
      if (screenshotOnly && !screenshotPanelInitialized) {
       screenshotPanelInitialized = true;
       openScreenshotModal();
     }
    setNotFoundTests(s.notFoundTests);
    renderCustomRunsettings(s.customRunsettings, s.runsettingsMode);
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function screenshotCss(): string {
  return `
   .screenshot-modal[hidden] { display: none; }
   .screenshot-modal { position: fixed; z-index: 10; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, 0.45); }
   .screenshot-dialog { width: min(1040px, 100%); max-height: min(780px, calc(100vh - 24px)); display: flex; flex-direction: column; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-focusBorder)); border-radius: 6px; box-shadow: 0 8px 28px var(--vscode-widget-shadow); }
   .screenshot-dialog-header, .screenshot-dialog-footer { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
   .screenshot-dialog-header { border-bottom: 1px solid var(--vscode-widget-border); font-weight: 600; }
   .screenshot-dialog-footer { justify-content: flex-end; border-top: 1px solid var(--vscode-widget-border); }
   .screenshot-dialog-body { display: grid; grid-template-columns: minmax(250px, 0.8fr) minmax(340px, 1.2fr); gap: 12px; min-height: 0; padding: 12px; overflow: auto; }
    .screenshot-settings { display: flex; flex-direction: column; gap: 12px; }
    .screenshot-option-group { display: flex; flex-direction: column; gap: 5px; }
    .screenshot-option-group[hidden] { display: none; }
   .screenshot-option-group > .label { font-weight: 600; }
   .screenshot-options { display: flex; flex-direction: column; gap: 4px; }
   .screenshot-options label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
   .screenshot-select, .screenshot-path { width: 100%; box-sizing: border-box; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent)); padding: 4px 6px; font: inherit; }
   .screenshot-path-row { display: flex; gap: 6px; }
   .screenshot-path { min-width: 0; flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
   .screenshot-path-error { color: var(--vscode-inputValidation-errorForeground); font-size: 0.9em; }
   .screenshot-preview-panel { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
   .screenshot-preview-frame { min-height: 260px; flex: 1; display: flex; align-items: flex-start; justify-content: flex-start; overflow: auto; padding: 10px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); }
   .screenshot-preview-frame img { max-width: 100%; height: auto; box-shadow: 0 1px 4px var(--vscode-widget-shadow); }
   .screenshot-preview-empty { align-self: center; opacity: 0.7; font-style: italic; }
   .screenshot-export-status { min-height: 1.2em; }
   .screenshot-export-status.error { color: var(--vscode-errorForeground); }
   body.screenshot-only { padding: 0; height: 100vh; box-sizing: border-box; }
   body.screenshot-only #mainContent { display: none; }
   body.screenshot-only .screenshot-modal { position: static; display: block; padding: 0; background: transparent; }
   body.screenshot-only .screenshot-dialog { width: 100%; height: 100vh; max-height: none; border: 0; border-radius: 0; box-shadow: none; }
   body.screenshot-only .screenshot-dialog-body { flex: 1; grid-template-columns: minmax(300px, 0.75fr) minmax(440px, 1.25fr); }
   body.screenshot-only .screenshot-preview-frame { min-height: 0; }
   @media (max-width: 700px) { .screenshot-dialog-body { grid-template-columns: 1fr; } .screenshot-preview-frame { min-height: 180px; } }`;
}

function screenshotModalHtml(): string {
  return `
   <div class="screenshot-modal" id="screenshotModal" hidden role="dialog" aria-modal="true" aria-labelledby="screenshotTitle">
     <div class="screenshot-dialog">
       <div class="screenshot-dialog-header"><span id="screenshotTitle">Export Test Screenshot</span></div>
       <div class="screenshot-dialog-body">
         <div class="screenshot-settings">
           <div class="screenshot-option-group"><span class="label">Solutions</span><div class="screenshot-options" id="screenshotSolutions"></div></div>
           <div class="screenshot-option-group"><label class="label" for="screenshotGroupBy">Group by</label><select class="screenshot-select" id="screenshotGroupBy"><option value="project">Project</option><option value="class">Class</option><option value="test">Test</option></select></div>
           <div class="screenshot-option-group"><span class="label">Show</span><div class="screenshot-options"><label><input id="screenshotShowPassing" type="checkbox" checked/>Passing tests</label><label><input id="screenshotShowFailing" type="checkbox" checked/>Failing tests</label><label><input id="screenshotShowSkipped" type="checkbox"/>Skipped tests</label><label><input id="screenshotShowNotRun" type="checkbox"/>Not run tests</label></div></div>
           <div class="screenshot-option-group screenshot-options"><label><input id="screenshotCollapsePassing" type="checkbox" checked/>Collapse passing groups</label><label><input id="screenshotShowTime" type="checkbox"/>Show execution time</label><label><input id="screenshotSaveImage" type="checkbox" checked/>Save Image</label><label><input id="screenshotCustomPath" type="checkbox"/>Custom Save Path</label></div>
           <div class="screenshot-option-group" id="screenshotPathSection" hidden><span class="label">Save Path</span><div class="screenshot-path-row"><input class="screenshot-path" id="screenshotSavePath" type="text" readonly/><button id="selectScreenshotPath">Select...</button></div><span class="screenshot-path-error" id="screenshotPathError" hidden>Select a save path before exporting.</span></div>
         </div>
         <div class="screenshot-preview-panel"><span class="label">Preview</span><div class="screenshot-preview-frame" id="screenshotPreviewFrame"><span class="screenshot-preview-empty">Preparing preview...</span></div></div>
       </div>
       <div class="screenshot-dialog-footer"><span class="screenshot-export-status" id="screenshotExportStatus"></span><button id="cancelScreenshot">Cancel</button><button class="solid" id="confirmScreenshot" disabled>Export</button></div>
     </div>
   </div>`;
}
