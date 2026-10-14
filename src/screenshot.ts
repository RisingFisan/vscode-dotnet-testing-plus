import * as path from 'path';
import { PlaylistTest } from './playlistParser';
import { TestResultState } from './testResultFilter';
import { compareText } from './collation';

export type ScreenshotGroupBy = 'project' | 'class' | 'test';
export type ScreenshotState = 'passed' | 'failed' | 'skipped' | 'notRun';

export interface ScreenshotShowOptions {
  passing: boolean;
  failing: boolean;
  skipped: boolean;
  notRun: boolean;
}

export interface ScreenshotOptions {
  solutionKeys: string[];
  groupBy: ScreenshotGroupBy;
  show: ScreenshotShowOptions;
  collapsePassingGroups: boolean;
  showExecutionTime: boolean;
}

export interface ScreenshotTest {
  kind: 'test';
  label: string;
  state: ScreenshotState;
  durationMs?: number;
}

export interface ScreenshotGroup {
  kind: 'solution' | 'project' | 'class';
  label: string;
  state: ScreenshotState;
  passed: number;
  total: number;
  durationMs?: number;
  children: ScreenshotNode[];
}

export type ScreenshotNode = ScreenshotTest | ScreenshotGroup;

export interface ScreenshotSnapshot {
  solutions: ScreenshotGroup[];
  total: number;
}

export interface ScreenshotSessionData {
  key: string;
  solutionPath: string;
  entries: PlaylistTest[];
  states: ReadonlyMap<string, TestResultState>;
  durations: ReadonlyMap<string, number>;
  projects: ReadonlyMap<string, string>;
}

function stateForExport(state: TestResultState | undefined): ScreenshotState {
  switch (state) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    default: return 'notRun';
  }
}

function isShown(state: ScreenshotState, show: ScreenshotShowOptions): boolean {
  switch (state) {
    case 'passed': return show.passing;
    case 'failed': return show.failing;
    case 'skipped': return show.skipped;
    default: return show.notRun;
  }
}

function solutionLabel(solutionPath: string): string {
  return path.basename(solutionPath, path.extname(solutionPath));
}

function projectLabel(entry: PlaylistTest, projects: ReadonlyMap<string, string>): string {
  const projectPath = projects.get(entry.fullyQualifiedName);
  return projectPath
    ? path.basename(projectPath, path.extname(projectPath))
    : entry.project ?? entry.namespace?.split('.')[0] ?? 'Playlist';
}

function classLabel(entry: PlaylistTest, project: string): string {
  const fqn = entry.fullyQualifiedName;
  const lastDot = fqn.lastIndexOf('.');
  const className = lastDot === -1 ? fqn : fqn.slice(0, lastDot);
  return className.startsWith(`${project}.`) ? className.slice(project.length + 1) : className;
}

function groupState(children: ScreenshotNode[]): ScreenshotState {
  const tests = collectTests(children);
  if (tests.length > 0 && tests.every(test => test.state === 'passed')) {
    return 'passed';
  }
  if (tests.some(test => test.state === 'failed')) {
    return 'failed';
  }
  if (tests.length > 0 && tests.every(test => test.state === 'skipped')) {
    return 'skipped';
  }
  return 'notRun';
}

function collectTests(nodes: ScreenshotNode[]): ScreenshotTest[] {
  const tests: ScreenshotTest[] = [];
  for (const node of nodes) {
    if (node.kind === 'test') {
      tests.push(node);
    } else {
      tests.push(...collectTests(node.children));
    }
  }
  return tests;
}

function makeGroup(kind: ScreenshotGroup['kind'], label: string, children: ScreenshotNode[]): ScreenshotGroup {
  const tests = collectTests(children);
  const knownDurations = tests
    .map(test => test.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  return {
    kind,
    label,
    state: groupState(children),
    passed: tests.filter(test => test.state === 'passed').length,
    total: tests.length,
    durationMs: knownDurations.length > 0 ? knownDurations.reduce((sum, duration) => sum + duration, 0) : undefined,
    children
  };
}

function sortNodes(nodes: ScreenshotNode[]): ScreenshotNode[] {
  return nodes.sort((a, b) => compareText(a.label, b.label));
}

export function buildScreenshotSnapshot(data: ScreenshotSessionData[], options: ScreenshotOptions): ScreenshotSnapshot {
  const selected = new Set(options.solutionKeys);
  const solutions: ScreenshotGroup[] = [];
  for (const session of data) {
    if (!selected.has(session.key)) {
      continue;
    }
    const tests = session.entries
      .map(entry => ({ entry, state: stateForExport(session.states.get(entry.fullyQualifiedName)) }))
      .filter(item => isShown(item.state, options.show));
    if (tests.length === 0) {
      continue;
    }

    const testNode = (entry: PlaylistTest, state: ScreenshotState): ScreenshotTest => ({
      kind: 'test',
      label: entry.testName ?? entry.fullyQualifiedName.slice(entry.fullyQualifiedName.lastIndexOf('.') + 1),
      state,
      durationMs: session.durations.get(entry.fullyQualifiedName)
    });
    let children: ScreenshotNode[];
    if (options.groupBy === 'test') {
      children = sortNodes(tests.map(item => testNode(item.entry, item.state)));
    } else {
      const byProject = new Map<string, Array<{ entry: PlaylistTest; state: ScreenshotState }>>();
      for (const item of tests) {
        const label = projectLabel(item.entry, session.projects);
        const entries = byProject.get(label) ?? [];
        entries.push(item);
        byProject.set(label, entries);
      }
      children = [];
      for (const [project, projectTests] of byProject) {
        if (options.groupBy === 'project') {
          children.push(makeGroup('project', project, sortNodes(projectTests.map(item => testNode(item.entry, item.state)))));
          continue;
        }
        const byClass = new Map<string, Array<{ entry: PlaylistTest; state: ScreenshotState }>>();
        for (const item of projectTests) {
          const label = classLabel(item.entry, project);
          const entries = byClass.get(label) ?? [];
          entries.push(item);
          byClass.set(label, entries);
        }
        const classGroups = sortNodes([...byClass].map(([label, classTests]) =>
          makeGroup('class', label, sortNodes(classTests.map(item => testNode(item.entry, item.state))))));
        children.push(makeGroup('project', project, classGroups));
      }
      children = sortNodes(children);
    }
    solutions.push(makeGroup('solution', solutionLabel(session.solutionPath), children));
  }
  const total = solutions.reduce((sum, solution) => sum + solution.total, 0);
  return { solutions: sortNodes(solutions) as ScreenshotGroup[], total };
}
