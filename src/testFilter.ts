import { PlaylistTest } from './playlistParser';

type TermKind = 'class' | 'project' | 'name';

interface FilterTerm {
  kind: TermKind;
  value: string;
}

export interface TestFilter {
  raw: string;
  groups: FilterTerm[][];
}

export function parseTestFilter(input: string): TestFilter | undefined {
  const raw = input.trim();
  if (!raw) {
    return undefined;
  }

  const groups = raw
    .split(/\s+/)
    .map(group => {
      const groupQualifier = /^(class|project):(.+)$/i.exec(group);
      const inheritedKind = groupQualifier ? (groupQualifier[1].toLowerCase() as TermKind) : undefined;
      const body = groupQualifier ? groupQualifier[2] : group;
      return body
        .split('|')
        .map(alternative => {
          const qualified = /^(class|project):(.+)$/i.exec(alternative);
          if (qualified) {
            return { kind: qualified[1].toLowerCase() as TermKind, value: qualified[2].toLowerCase() };
          }
          return { kind: inheritedKind ?? ('name' as TermKind), value: alternative.toLowerCase() };
        })
        .filter(term => term.value.length > 0);
    })
    .filter(group => group.length > 0);

  if (groups.length === 0) {
    return undefined;
  }
  return { raw, groups };
}

export function matchesTestFilter(filter: TestFilter, entry: PlaylistTest): boolean {
  return filter.groups.every(alternatives =>
    alternatives.some(term => {
      const haystack =
        term.kind === 'class' ? entry.className :
        term.kind === 'project' ? entry.project :
        entry.testName;
      return haystack !== undefined && haystack.toLowerCase().includes(term.value);
    })
  );
}

export function filterEntries(entries: PlaylistTest[], filter: TestFilter | undefined): PlaylistTest[] {
  if (!filter) {
    return entries;
  }
  return entries.filter(entry => matchesTestFilter(filter, entry));
}
