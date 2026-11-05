import { PlaylistTest } from './playlistParser';
import { TestResultState } from './testResultFilter';
import { compareText } from './collation';
import { classLabelOf, projectLabel, solutionLabel } from './testTree';

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
  /** False when the test came from the source scan and no listing confirmed it. */
  verified?: boolean;
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
  /** FQNs confirmed by a test-host listing; absent when no listing has run. */
  verified?: ReadonlySet<string>;
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

// Labels (solution/project/class) come from testTree.ts so the screenshot
// always matches what the Test Explorer shows.

function groupState(tests: ScreenshotTest[]): ScreenshotState {
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
  // Flatten the subtree once; both the state and the counts derive from it.
  const tests = collectTests(children);
  const knownDurations = tests
    .map(test => test.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  return {
    kind,
    label,
    state: groupState(tests),
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
      durationMs: session.durations.get(entry.fullyQualifiedName),
      verified: session.verified ? session.verified.has(entry.fullyQualifiedName) : undefined
    });
    let children: ScreenshotNode[];
    if (options.groupBy === 'test') {
      children = sortNodes(tests.map(item => testNode(item.entry, item.state)));
    } else {
      const byProject = new Map<string, Array<{ entry: PlaylistTest; state: ScreenshotState }>>();
      for (const item of tests) {
        const label = projectLabel(item.entry, session.projects.get(item.entry.fullyQualifiedName));
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
          const label = classLabelOf(item.entry.fullyQualifiedName, project);
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
