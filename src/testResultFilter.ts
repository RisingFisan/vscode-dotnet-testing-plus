export type TestResultState = 'notRun' | 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

export interface TestResultFilter {
  passing: boolean;
  failing: boolean;
  notRun: boolean;
  skipped: boolean;
}

export type TestResultFilterKey = keyof TestResultFilter;

export function createDefaultTestResultFilter(): TestResultFilter {
  return { passing: true, failing: true, notRun: true, skipped: true };
}

export function isTestResultVisible(filter: TestResultFilter, state: TestResultState): boolean {
  switch (state) {
    case 'queued':
    case 'running':
      return true;
    case 'passed':
      return filter.passing;
    case 'failed':
      return filter.failing;
    case 'skipped':
      return filter.skipped;
    default:
      return filter.notRun;
  }
}
