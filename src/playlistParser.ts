import { XMLParser } from 'fast-xml-parser';

export interface PlaylistTest {
  project?: string;
  namespace?: string;
  className?: string;
  testName: string;
  fullyQualifiedName: string;
}

interface XmlProperty {
  '@_Name': string;
  '@_Value'?: string;
}

interface XmlRule {
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

export function parsePlaylist(xml: string): PlaylistTest[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const root = doc.Playlist;
  if (!root) {
    throw new Error('Not a valid .playlist file: missing <Playlist> root element.');
  }

  const tests: PlaylistTest[] = [];

  for (const add of asArray<any>(root.Add)) {
    const fqn: string | undefined = add['@_Test'];
    if (fqn) {
      const segments = fqn.split('.');
      const testName = segments.pop()!;
      const className = segments.pop();
      const namespace = segments.length ? segments.join('.') : undefined;
      tests.push({ project: undefined, namespace, className, testName, fullyQualifiedName: fqn });
    }
  }

  interface Context {
    project?: string;
    namespace?: string;
    className?: string;
  }

  const walk = (rule: XmlRule, ctx: Context): void => {
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
      }
    }

    if (testName) {
      const fullyQualifiedName = [namespace, className, testName].filter(Boolean).join('.');
      tests.push({ project, namespace, className, testName, fullyQualifiedName });
    }

    for (const child of asArray(rule.Rule)) {
      walk(child, { project, namespace, className });
    }
  };

  for (const rule of asArray<XmlRule>(root.Rule)) {
    walk(rule, {});
  }

  return tests;
}
