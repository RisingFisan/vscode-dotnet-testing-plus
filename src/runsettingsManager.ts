import * as path from 'path';
import * as fs from 'fs';

export interface RunsettingsValue {
  key: string;
  section: string;
  label: string;
  value: string;
  overridden: boolean;
}

export interface BaseRunsettingsParameter {
  key: string;
  name: string;
  value: string;
  overridden?: boolean;
}

export interface CustomRunsettingsParameter {
  id: string;
  name: string;
  value: string;
}

export interface CustomRunsettingsState {
  sourcePath?: string;
  overrides: Record<string, string>;
  parameters: CustomRunsettingsParameter[];
}

export interface CustomRunsettingsViewState {
  available: boolean;
  values: RunsettingsValue[];
  parameters: BaseRunsettingsParameter[];
  customParameters: CustomRunsettingsParameter[];
  unresolved: string[];
  hasCustomizations: boolean;
}

interface AttributeNode {
  name: string;
  value: string;
  valueStart: number;
  valueEnd: number;
}

interface TextNode {
  start: number;
  end: number;
}

interface ElementNode {
  name: string;
  parent?: ElementNode;
  children: ElementNode[];
  text: TextNode[];
  attributes: AttributeNode[];
  openStart: number;
  openEnd: number;
  closeStart?: number;
  closeEnd?: number;
  selfClosing: boolean;
}

interface EditableValue {
  key: string;
  section: string;
  label: string;
  value: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

interface ParsedRunsettings {
  xml: string;
  values: EditableValue[];
  parameters: (BaseRunsettingsParameter & { start: number; end: number })[];
  testRunParameters?: ElementNode;
  root?: ElementNode;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

const ROOT_NAME = 'RunSettings';

export function createCustomRunsettingsState(): CustomRunsettingsState {
  return { overrides: {}, parameters: [] };
}

export function hasCustomRunsettings(state: CustomRunsettingsState | undefined): boolean {
  return state !== undefined &&
    (Object.keys(state.overrides).length > 0 || state.parameters.length > 0);
}

export function normalizeCustomRunsettingsState(value: unknown): CustomRunsettingsState {
  const raw = value as Partial<CustomRunsettingsState> | undefined;
  const overrides: Record<string, string> = {};
  if (raw?.overrides && typeof raw.overrides === 'object') {
    Object.entries(raw.overrides).forEach(([key, override]) => {
      if (typeof override === 'string') {
        overrides[key] = override;
      }
    });
  }

  const parameters = Array.isArray(raw?.parameters)
    ? raw.parameters.flatMap(parameter => {
      if (!parameter || typeof parameter !== 'object') {
        return [];
      }
      const item = parameter as Partial<CustomRunsettingsParameter>;
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.value !== 'string') {
        return [];
      }
      return [{ id: item.id, name: item.name, value: item.value }];
    })
    : [];

  return {
    sourcePath: typeof raw?.sourcePath === 'string' ? raw.sourcePath : undefined,
    overrides,
    parameters
  };
}

export function validateCustomParameterName(
  name: string,
  baseParameters: BaseRunsettingsParameter[],
  customParameters: CustomRunsettingsParameter[],
  currentId?: string
): string | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return 'Parameter name cannot be blank.';
  }
  if (baseParameters.some(parameter => parameter.name.trim().toLowerCase() === normalized)) {
    return `Parameter "${name}" already exists in the base runsettings file.`;
  }
  if (customParameters.some(parameter =>
    parameter.id !== currentId && parameter.name.trim().toLowerCase() === normalized)) {
    return `Parameter "${name}" is already defined as a custom parameter.`;
  }
  return undefined;
}

export async function inspectRunsettings(
  basePath: string,
  state: CustomRunsettingsState | undefined
): Promise<CustomRunsettingsViewState> {
  const normalized = normalizeCustomRunsettingsState(state);
  const parsed = parseRunsettingsXml(await fs.promises.readFile(basePath, 'utf8'));
  const knownKeys = new Set<string>();
  const values = parsed.values.map(value => {
    knownKeys.add(value.key);
    return {
      key: value.key,
      section: value.section,
      label: value.label,
      value: hasOwn(normalized.overrides, value.key) ? normalized.overrides[value.key] : value.value,
      overridden: hasOwn(normalized.overrides, value.key)
    };
  });
  const parameters = parsed.parameters.map(parameter => {
    knownKeys.add(parameter.key);
    return {
      key: parameter.key,
      name: parameter.name,
      value: hasOwn(normalized.overrides, parameter.key) ? normalized.overrides[parameter.key] : parameter.value,
      overridden: hasOwn(normalized.overrides, parameter.key)
    };
  });
  const unresolved = Object.keys(normalized.overrides)
    .filter(key => !knownKeys.has(key))
    .map(key => `Setting no longer exists: ${key}`);
  const baseNames = new Set(parameters.map(parameter => parameter.name.trim().toLowerCase()));
  const customNames = new Set<string>();
  normalized.parameters.forEach(parameter => {
    const normalizedName = parameter.name.trim().toLowerCase();
    if (!normalizedName) {
      unresolved.push(`Custom parameter "${parameter.id}" has a blank name.`);
    } else if (baseNames.has(normalizedName)) {
      unresolved.push(`Custom parameter "${parameter.name}" conflicts with the base runsettings file.`);
    } else if (customNames.has(normalizedName)) {
      unresolved.push(`Custom parameter "${parameter.name}" duplicates another custom parameter.`);
    } else {
      customNames.add(normalizedName);
    }
  });

  return {
    available: true,
    values,
    parameters,
    customParameters: normalized.parameters,
    unresolved,
    hasCustomizations: hasCustomRunsettings(normalized)
  };
}

export async function materializeRunsettings(
  basePath: string,
  state: CustomRunsettingsState,
  storageDirectory: string
): Promise<{ path: string; unresolved: string[] }> {
  const parsed = parseRunsettingsXml(await fs.promises.readFile(basePath, 'utf8'));
  const knownKeys = new Set<string>();
  parsed.values.forEach(value => knownKeys.add(value.key));
  parsed.parameters.forEach(parameter => knownKeys.add(parameter.key));
  const replacements: Replacement[] = [];
  parsed.values.forEach(value => {
    if (hasOwn(state.overrides, value.key)) {
      replacements.push({
        start: value.start,
        end: value.end,
        value: value.prefix + encodeXml(state.overrides[value.key]) + value.suffix
      });
    }
  });
  parsed.parameters.forEach(parameter => {
    if (hasOwn(state.overrides, parameter.key)) {
      replacements.push({
        start: parameter.start,
        end: parameter.end,
        value: encodeXml(state.overrides[parameter.key])
      });
    }
  });

  const unresolved = Object.keys(state.overrides)
    .filter(key => !knownKeys.has(key))
    .map(key => `Setting no longer exists: ${key}`);
  const baseNames = new Set(parsed.parameters.map(parameter => parameter.name.trim().toLowerCase()));
  const customNames = new Set<string>();
  const validParameters: CustomRunsettingsParameter[] = [];
  state.parameters.forEach(parameter => {
    const normalizedName = parameter.name.trim().toLowerCase();
    if (!normalizedName) {
      unresolved.push(`Custom parameter "${parameter.id}" has a blank name.`);
    } else if (baseNames.has(normalizedName)) {
      unresolved.push(`Custom parameter "${parameter.name}" conflicts with the base runsettings file.`);
    } else if (customNames.has(normalizedName)) {
      unresolved.push(`Custom parameter "${parameter.name}" duplicates another custom parameter.`);
    } else {
      customNames.add(normalizedName);
      validParameters.push(parameter);
    }
  });

  if (validParameters.length > 0) {
    const insertion = createParameterInsertion(parsed, validParameters);
    replacements.push(insertion);
  }

  let output = parsed.xml;
  replacements
    .sort((left, right) => right.start - left.start)
    .forEach(replacement => {
      output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
    });

  await fs.promises.mkdir(storageDirectory, { recursive: true });
  const outputPath = path.join(storageDirectory, 'custom.runsettings');
  await fs.promises.writeFile(outputPath, output, 'utf8');
  return { path: outputPath, unresolved };
}

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseRunsettingsXml(xml: string): ParsedRunsettings {
  const roots: ElementNode[] = [];
  const stack: ElementNode[] = [];
  let position = 0;
  while (position < xml.length) {
    if (xml[position] !== '<') {
      const nextTag = xml.indexOf('<', position);
      const end = nextTag < 0 ? xml.length : nextTag;
      const current = stack[stack.length - 1];
      if (current && end > position) {
        current.text.push({ start: position, end });
      }
      position = end;
      continue;
    }

    if (xml.startsWith('<!--', position)) {
      const commentEnd = xml.indexOf('-->', position + 4);
      position = commentEnd < 0 ? xml.length : commentEnd + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', position)) {
      const cdataEnd = xml.indexOf(']]>', position + 9);
      position = cdataEnd < 0 ? xml.length : cdataEnd + 3;
      continue;
    }
    if (xml.startsWith('<?', position)) {
      const processingEnd = findTagEnd(xml, position + 2);
      position = processingEnd < 0 ? xml.length : processingEnd + 1;
      continue;
    }
    if (xml.startsWith('<!', position)) {
      const declarationEnd = findTagEnd(xml, position + 2);
      position = declarationEnd < 0 ? xml.length : declarationEnd + 1;
      continue;
    }

    const tagEnd = findTagEnd(xml, position + 1);
    if (tagEnd < 0) {
      break;
    }
    const rawTag = xml.slice(position, tagEnd + 1);
    const closing = /^<\s*\/\s*([A-Za-z_][\w:.-]*)/.exec(rawTag);
    if (closing) {
      const closingName = closing[1];
      const matchingIndex = [...stack].reverse().findIndex(node => node.name === closingName);
      if (matchingIndex >= 0) {
        const stackIndex = stack.length - matchingIndex - 1;
        const node = stack[stackIndex];
        node.closeStart = position;
        node.closeEnd = tagEnd + 1;
        stack.length = stackIndex;
      }
      position = tagEnd + 1;
      continue;
    }

    const opening = /^<\s*([A-Za-z_][\w:.-]*)/.exec(rawTag);
    if (!opening) {
      position = tagEnd + 1;
      continue;
    }
    const name = opening[1];
    const node: ElementNode = {
      name,
      parent: stack[stack.length - 1],
      children: [],
      text: [],
      attributes: parseAttributes(rawTag, position),
      openStart: position,
      openEnd: tagEnd + 1,
      selfClosing: /\/\s*>$/.test(rawTag)
    };
    if (node.parent) {
      node.parent.children.push(node);
    } else {
      roots.push(node);
    }
    if (!node.selfClosing) {
      stack.push(node);
    }
    position = tagEnd + 1;
  }

  const root = roots.find(candidate => candidate.name === ROOT_NAME) ?? roots[0];
  const allNodes = root ? flatten(root) : [];
  const values: EditableValue[] = [];
  const parameters: (BaseRunsettingsParameter & { start: number; end: number })[] = [];
  allNodes.forEach(node => {
    const pathName = getPathName(node);
    const parameterContainer = ancestors(node).some(ancestor => ancestor.name === 'TestRunParameters');
    const nameAttribute = node.attributes.find(attribute => attribute.name === 'name');
    const valueAttribute = node.attributes.find(attribute => attribute.name === 'value');
    if (parameterContainer && node.name === 'Parameter' && nameAttribute && valueAttribute) {
      const key = getParameterKey(node, nameAttribute.value);
      parameters.push({ key, name: nameAttribute.value, value: valueAttribute.value, start: valueAttribute.valueStart, end: valueAttribute.valueEnd });
      return;
    }
    node.attributes.forEach(attribute => {
      const display = getDisplayPath(pathName);
      values.push({
        key: `attribute:${pathName}/@${attribute.name}`,
        section: display.section,
        label: `${display.label}/@${attribute.name}`,
        value: attribute.value,
        start: attribute.valueStart,
        end: attribute.valueEnd,
        prefix: '',
        suffix: ''
      });
    });
    if (node.selfClosing || node.children.length > 0 || node.closeStart === undefined) {
      return;
    }
    const start = node.openEnd;
    const end = node.closeStart;
    const rawValue = node.text.length > 0
      ? node.text.map(text => xml.slice(text.start, text.end)).join('')
      : xml.slice(start, end);
    const whitespace = /^(\s*)([\s\S]*?)(\s*)$/.exec(rawValue);
    const prefix = whitespace?.[1] ?? '';
    const suffix = whitespace?.[3] ?? '';
    const value = decodeXml((whitespace?.[2] ?? rawValue));
    const display = getDisplayPath(pathName);
    values.push({
      key: `value:${pathName}`,
      section: display.section,
      label: display.label,
      value,
      start,
      end,
      prefix,
      suffix
    });
  });
  return { xml, values, parameters, testRunParameters: allNodes.find(node => node.name === 'TestRunParameters'), root };
}

function parseAttributes(rawTag: string, absoluteStart: number): AttributeNode[] {
  const attributes: AttributeNode[] = [];
  const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(rawTag)) !== null) {
    const quoteOffset = match[0].indexOf(match[2]);
    const valueStart = absoluteStart + match.index + quoteOffset + 1;
    attributes.push({
      name: match[1],
      value: decodeXml(match[3]),
      valueStart,
      valueEnd: valueStart + match[3].length
    });
  }
  return attributes;
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < xml.length; index++) {
    const character = xml[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function flatten(root: ElementNode): ElementNode[] {
  const nodes = [root];
  root.children.forEach(child => nodes.push(...flatten(child)));
  return nodes;
}

function ancestors(node: ElementNode): ElementNode[] {
  const result: ElementNode[] = [];
  let current: ElementNode | undefined = node;
  while (current) {
    result.unshift(current);
    current = current.parent;
  }
  return result;
}

function getPathName(node: ElementNode): string {
  return ancestors(node)
    .map(current => {
      const siblings = current.parent?.children.filter(child => child.name === current.name) ?? [current];
      const index = siblings.indexOf(current) + 1;
      return `${current.name}${siblings.length > 1 ? `[${index}]` : ''}`;
    })
    .join('/')
    .replace(/^RunSettings\//, '');
}

function getDisplayPath(pathName: string): { section: string; label: string } {
  const segments = pathName.split('/');
  const section = segments.shift() || ROOT_NAME;
  return {
    section,
    label: segments.length > 0 ? segments.join(' / ') : section
  };
}

function getParameterKey(node: ElementNode, name: string): string {
  const siblings = node.parent?.children.filter(child => child.name === node.name) ?? [node];
  const sameName = siblings.filter(sibling =>
    sibling.attributes.find(attribute => attribute.name === 'name')?.value === name);
  const index = sameName.indexOf(node) + 1;
  return `parameter:${name}${sameName.length > 1 ? `#${index}` : ''}`;
}

function createParameterInsertion(
  parsed: ParsedRunsettings,
  parameters: CustomRunsettingsParameter[]
): Replacement {
  const newline = parsed.xml.includes('\r\n') ? '\r\n' : '\n';
  const parameterLines = parameters.map(parameter =>
    `<Parameter name="${encodeXml(parameter.name)}" value="${encodeXml(parameter.value)}" />`);
  const section = parsed.testRunParameters;
  if (section?.closeStart !== undefined) {
    const lineStart = parsed.xml.lastIndexOf('\n', section.closeStart) + 1;
    const linePrefix = parsed.xml.slice(lineStart, section.closeStart);
    const closeIndent = linePrefix.match(/^[ \t]*/)?.[0] ?? '';
    const childIndent = closeIndent + '  ';
    if (linePrefix.trim() !== '') {
      return {
        start: section.closeStart,
        end: section.closeStart,
        value: `${newline}${parameterLines.map(line => `${childIndent}${line}`).join(newline)}${newline}${closeIndent}`
      };
    }
    return {
      start: lineStart,
      end: lineStart,
      value: parameterLines.map(line => `${childIndent}${line}${newline}`).join('')
    };
  }
  if (section?.selfClosing) {
    const lineStart = parsed.xml.lastIndexOf('\n', section.openStart) + 1;
    const indent = parsed.xml.slice(lineStart, section.openStart).match(/^[ \t]*/)?.[0] ?? '';
    const childIndent = indent + '  ';
    return {
      start: section.openStart,
      end: section.openEnd,
      value: `<TestRunParameters>${newline}${parameterLines.map(line => `${childIndent}${line}`).join(newline)}${newline}${indent}</TestRunParameters>`
    };
  }
  const root = parsed.root;
  if (!root || root.closeStart === undefined) {
    throw new Error('The runsettings file has no closing RunSettings element.');
  }
  const lineStart = parsed.xml.lastIndexOf('\n', root.closeStart) + 1;
  const rootPrefix = parsed.xml.slice(lineStart, root.closeStart);
  const rootIndent = rootPrefix.match(/^[ \t]*/)?.[0] ?? '';
  const childIndent = rootIndent + '  ';
  const sectionValue = `${childIndent}<TestRunParameters>${newline}${parameterLines.map(line => `${childIndent}${line}`).join(newline)}${newline}${childIndent}</TestRunParameters>`;
  if (rootPrefix.trim() !== '') {
    return {
      start: root.closeStart,
      end: root.closeStart,
      value: `${newline}${sectionValue}${newline}${rootIndent}`
    };
  }
  return {
    start: lineStart,
    end: lineStart,
    value: `${sectionValue}${newline}`
  };
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function findDefaultRunsettings(solutionPath: string): string | undefined {
  const slnDir = path.dirname(solutionPath);
  const slnName = path.basename(solutionPath, '.sln');
  const candidates: string[] = [];
  try {
    for (const entry of fs.readdirSync(slnDir)) {
      if (entry.toLowerCase().endsWith('.runsettings')) {
        candidates.push(path.join(slnDir, entry));
      }
    }
  } catch {
    return undefined;
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const sameBase = candidates.find(c => path.basename(c, '.runsettings').toLowerCase() === slnName.toLowerCase());
  if (sameBase) {
    return sameBase;
  }

  const namedDefault = candidates.find(c => path.basename(c, '.runsettings').toLowerCase() === 'default');
  if (namedDefault) {
    return namedDefault;
  }

  return candidates[0];
}

export function resolveRunsettingsPath(solutionPath: string, explicitPath: string | undefined): string | undefined {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  return findDefaultRunsettings(solutionPath);
}
