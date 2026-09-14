import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

export interface PlaylistTest {
  project?: string;
  namespace?: string;
  className?: string;
  testName: string;
  fullyQualifiedName: string;
}

export interface ParsedPlaylist {
  includes: PlaylistTest[];
  excludes: PlaylistTest[];
}

interface XmlProperty {
  '@_Name': string;
  '@_Value'?: string;
}

interface XmlRule {
  '@_Name'?: string;
  '@_Match'?: string;
  Property?: XmlProperty | XmlProperty[];
  Rule?: XmlRule | XmlRule[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function entryFromFqn(fqn: string, project?: string): PlaylistTest {
  const segments = fqn.split('.');
  const testName = segments.pop()!;
  const className = segments.pop();
  const namespace = segments.length ? segments.join('.') : undefined;
  return { project, namespace, className, testName, fullyQualifiedName: fqn };
}

export function parsePlaylist(xml: string): ParsedPlaylist {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const root = doc.Playlist;
  if (!root) {
    throw new Error('Not a valid .playlist file: missing <Playlist> root element.');
  }

  const includes: PlaylistTest[] = [];
  const excludes: PlaylistTest[] = [];

  for (const add of asArray<any>(root.Add)) {
    const fqn: string | undefined = add['@_Test'];
    if (fqn) {
      includes.push(entryFromFqn(fqn));
    }
  }

  interface Context {
    project?: string;
    namespace?: string;
    className?: string;
  }

  const walk = (rule: XmlRule, ctx: Context, target: PlaylistTest[]): void => {
    let { project, namespace, className } = ctx;
    let testName: string | undefined;

    for (const prop of asArray(rule.Property)) {
      const value = prop['@_Value'];
      switch (prop['@_Name']) {
        case 'Project':
          project = value;
          break;
        case 'Namespace':
          namespace = value;
          break;
        case 'Class':
          className = value;
          break;
        case 'TestWithNormalizedFullyQualifiedName':
          testName = value;
          break;
        case 'FullyQualifiedName':
        case 'Test':
          if (value) {
            target.push(entryFromFqn(value, project));
          }
          break;
      }
    }

    if (testName) {
      const scope = [namespace, className].filter(Boolean).join('.');
      let fullyQualifiedName: string;
      if (scope && testName.startsWith(`${scope}.`)) {
        fullyQualifiedName = testName;
      } else if (className && testName.startsWith(`${className}.`)) {
        fullyQualifiedName = [namespace, testName].filter(Boolean).join('.');
      } else {
        fullyQualifiedName = [namespace, className, testName].filter(Boolean).join('.');
      }
      target.push({ project, namespace, className, testName, fullyQualifiedName });
    }

    for (const child of asArray(rule.Rule)) {
      walk(child, { project, namespace, className }, target);
    }
  };

  for (const rule of asArray<XmlRule>(root.Rule)) {
    walk(rule, {}, rule['@_Name']?.toLowerCase() === 'excludes' ? excludes : includes);
  }

  return { includes, excludes };
}

/**
 * FullyQualifiedName playlist entries may reference a whole class or
 * namespace (Visual Studio writes those when entire classes are added to the
 * playlist). Expand each entry against the discovered test FQNs: exact match
 * first, then FQNs nested under the entry (dot boundary), then substring
 * matches like the default Contains operator Visual Studio uses.
 */
export function expandPlaylist(
  playlist: ParsedPlaylist,
  knownTests: ReadonlySet<string>,
  projectFor?: (fqn: string) => string | undefined
): { entries: PlaylistTest[]; notFound: string[] } {
  const excluded = new Set<string>();
  for (const entry of playlist.excludes) {
    for (const fqn of matchKnownTests(entry.fullyQualifiedName, knownTests)) {
      excluded.add(fqn);
    }
  }
  const entries: PlaylistTest[] = [];
  const notFound: string[] = [];
  for (const entry of playlist.includes) {
    const matches = matchKnownTests(entry.fullyQualifiedName, knownTests);
    if (matches.length === 0) {
      notFound.push(entry.fullyQualifiedName);
      continue;
    }
    for (const fqn of matches) {
      if (excluded.has(fqn)) {
        continue;
      }
      entries.push(entryFromKnownTestFqn(fqn, projectFor?.(fqn)));
    }
  }
  return { entries, notFound };
}

export function entryFromKnownTestFqn(fqn: string, projectPath?: string): PlaylistTest {
  const entry = entryFromFqn(fqn);
  if (projectPath) {
    entry.project = path.basename(projectPath, path.extname(projectPath));
  }
  return entry;
}

function matchKnownTests(prefix: string, knownTests: ReadonlySet<string>): string[] {
  if (knownTests.has(prefix)) {
    return [prefix];
  }
  const scoped = `${prefix}.`;
  const nested: string[] = [];
  const contains: string[] = [];
  for (const fqn of knownTests) {
    if (fqn.startsWith(scoped)) {
      nested.push(fqn);
    } else if (fqn.includes(prefix)) {
      contains.push(fqn);
    }
  }
  const matches = nested.length > 0 ? nested : contains;
  return [...matches].sort((a, b) => a.localeCompare(b));
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type PlaylistSaveFormat = 'v2' | 'v1';

export function serializePlaylist(fqns: string[], format: PlaylistSaveFormat = 'v2'): string {
  const sorted = [...fqns].sort((a, b) => a.localeCompare(b));
  if (format === 'v1') {
    const body = sorted.map(fqn => `  <Add Test="${escapeXmlAttr(fqn)}" />`).join('\n');
    return `<Playlist Version="2.0">\n${body}${body ? '\n' : ''}</Playlist>\n`;
  }
  const body = sorted.map(fqn => `    <Property Name="FullyQualifiedName" Value="${escapeXmlAttr(fqn)}" />`).join('\n');
  return `<Playlist Version="2.0">\n  <Rule Name="Includes" Match="Any">\n${body}${body ? '\n' : ''}  </Rule>\n</Playlist>\n`;
}
