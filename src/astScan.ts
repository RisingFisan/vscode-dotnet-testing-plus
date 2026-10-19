import * as fs from 'fs';
import * as path from 'path';
import { Parser, Language, Node } from 'web-tree-sitter';
import { log } from './logger';
import { SourceLocation, extractMethodsRegex, walkCsFilesAsync } from './sourceScan';
import { TEST_ATTRIBUTES, mayContainTests } from './testAttributes';
import { ExtractedMethod, FileScanCache, foldMethods } from './fileScanCache';

interface MethodIndexData {
  methodIndex: Map<string, Set<string>>;
  locations: Map<string, SourceLocation>;
  projects: Map<string, string>;
}

export interface MethodIndex extends MethodIndexData {
  /** Identifies the scanner implementation that produced the result; drives cache invalidation. */
  parserVersion: string;
}

const TEST_ATTRIBUTE_LOOKUP = new Set([...TEST_ATTRIBUTES].map(name => name.toLowerCase()));

interface ScanContext {
  namespaces: string[];
  className?: string;
}

const CORE_WASM = path.join('assets', 'wasm', 'tree-sitter.wasm');
const CSHARP_WASM = path.join('assets', 'wasm', 'tree-sitter-c_sharp.wasm');

/**
 * Source scanner driver. A real parse tree replaces the regex heuristics:
 * attribute attachment, nested classes and namespaces come from the grammar,
 * so comments, strings and multi-line attributes can no longer produce false
 * results. Files whose mtime+size (and scanner version) are unchanged reuse
 * their cached per-file extraction — reads and WASM parses happen only for
 * files that actually changed. FQNs keep the existing contract (enclosing
 * namespace + innermost class name + method) and identical fold order, so
 * playlists, locations and the cache stay consistent.
 *
 * Falls back to the regex extractor (`sourceScan.ts`) whenever the tree-sitter
 * runtime cannot initialize — which the scan cache serves as well; the
 * returned `parserVersion` tells both the solution cache and the scan cache
 * which implementation produced the results.
 */
const AST_VERSION = 'ast-1';
const REGEX_VERSION = 'regex-1';
// Files are stat'ed/read concurrently in groups of this size, then folded in
// the original order (the first-wins fold contract depends on it).
const SCAN_CHUNK = 64;
const MAX_LOGGED_AST_FAILURES = 3;
let loggedAstFailures = 0;

/**
 * Identity of the WASM assets (mtime+size of both files), or undefined when
 * either is missing. Used both to predict the scanner version without
 * initializing the parser and to remember that a given build of the assets
 * proved unusable at runtime.
 */
function wasmSignature(extensionPath: string | undefined): string | undefined {
  if (!extensionPath) {
    return undefined;
  }
  try {
    const parts = [CORE_WASM, CSHARP_WASM].map(asset => {
      const stat = fs.statSync(path.join(extensionPath, asset));
      return `${stat.mtimeMs}:${stat.size}`;
    });
    return parts.join('|');
  } catch {
    return undefined;
  }
}

interface LoadedFile {
  file: string;
  stat: fs.Stats;
  /** Cached extraction, when the file is unchanged. */
  methods?: ExtractedMethod[];
  /** File content, only read on a cache miss. */
  content?: string;
}

export async function buildMethodIndex(
  projectPaths: string[],
  extensionPath: string | undefined,
  storageDir?: string
): Promise<MethodIndex> {
  const scanned = ensureScanStore(storageDir);
  // Predict the version from asset presence without initializing the parser:
  // a fully-cached scan (window reload on an unchanged repo) must not pay the
  // one-time WASM init. The parser initializes lazily on the first actual
  // extraction miss. Assets that already failed to initialize are treated as
  // absent, so the regex-keyed entries written after that failure keep hitting.
  const signature = wasmSignature(extensionPath);
  const wasmUsable = signature !== undefined && !scanned.isAstBroken(signature);
  const hitVersion = wasmUsable ? AST_VERSION : REGEX_VERSION;
  // undefined = not yet attempted; null = attempted and unavailable (regex fallback).
  let parser: Parser | null | undefined = wasmUsable ? undefined : null;
  let lastMissVersion = hitVersion;

  const methodIndex = new Map<string, Set<string>>();
  const locations = new Map<string, SourceLocation>();
  const projects = new Map<string, string>();
  // Files already folded. Overlapping project directories list the same file
  // more than once; re-folding it can only repeat first-wins no-ops, so skip
  // the stat/read/fold entirely.
  const seen = new Set<string>();
  const scannedRoots: string[] = [];
  // Directories already listed by an earlier project root; nested or
  // overlapping project directories would otherwise re-walk entire subtrees.
  const visitedDirs = new Set<string>();

  const loadFile = async (file: string): Promise<LoadedFile | undefined> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return undefined;
    }
    const cached = scanned.get(file, stat.mtimeMs, stat.size, hitVersion);
    if (cached) {
      return { file, stat, methods: cached };
    }
    try {
      return { file, stat, content: await fs.promises.readFile(file, 'utf8') };
    } catch {
      return undefined;
    }
  };

  for (const csprojPath of projectPaths) {
    const root = path.dirname(csprojPath);
    let files: string[];
    try {
      // Async + chunked so a large solution does not block the extension host.
      files = await walkCsFilesAsync(root, true, visitedDirs);
    } catch {
      continue;
    }
    scannedRoots.push(root);
    const fresh = files.filter(file => !seen.has(file));
    fresh.forEach(file => seen.add(file));

    for (let i = 0; i < fresh.length; i += SCAN_CHUNK) {
      const loaded = await Promise.all(fresh.slice(i, i + SCAN_CHUNK).map(loadFile));
      for (const item of loaded) {
        if (!item) {
          continue;
        }
        let methods = item.methods;
        if (!methods) {
          if (parser === undefined) {
            parser = await ensureParser(extensionPath);
            if (!parser && signature !== undefined) {
              // Assets are present but the runtime could not start: remember
              // it so later windows don't retry and miss the whole cache.
              scanned.markAstBroken(signature);
            }
          }
          const missVersion = parser ? AST_VERSION : REGEX_VERSION;
          methods = extractFile(parser, item.content ?? '', item.file);
          scanned.set(item.file, item.stat.mtimeMs, item.stat.size, missVersion, methods);
          lastMissVersion = missVersion;
        }
        foldMethods(methods, item.file, csprojPath, methodIndex, locations, projects);
      }
    }
  }

  // Forget cache entries for deleted/renamed files, only under directories
  // that were actually listed (never evicts another solution's entries).
  scanned.prune(seen, scannedRoots);
  scanned.save();
  return { methodIndex, locations, projects, parserVersion: lastMissVersion };
}

/**
 * Extract one file's test methods. Files without any test marker word are
 * known-empty (no parse needed). A parser fault on a single file degrades to
 * the regex extractor for that file instead of failing the whole scan.
 */
function extractFile(parser: Parser | null, content: string, file: string): ExtractedMethod[] {
  if (!mayContainTests(content)) {
    return [];
  }
  if (parser) {
    try {
      return extractMethodsAst(parser, content);
    } catch (err) {
      if (loggedAstFailures++ < MAX_LOGGED_AST_FAILURES) {
        log(`AST scan failed for ${file}, using regex for this file: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        parser.reset();
      } catch {
        // A parser that cannot reset keeps failing; every file then falls back.
      }
    }
  }
  return extractMethodsRegex(content);
}

function extractMethodsAst(parser: Parser, content: string): ExtractedMethod[] {
  const tree = parser.parse(content);
  if (!tree) {
    return [];
  }
  try {
    const methods: ExtractedMethod[] = [];
    const collect = (node: Node, context: ScanContext): void => {
      if (node.type === 'namespace_declaration') {
        const nameNode = node.childForFieldName('name');
        const childContext: ScanContext = {
          namespaces: nameNode ? [...context.namespaces, nameNode.text] : context.namespaces,
          className: undefined
        };
        for (const child of node.children) {
          collect(child, childContext);
        }
        return;
      }
      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName('name');
        // FQN contract: innermost class name only (matches what the regex path
        // and Visual Studio playlists have always used for nested classes).
        const childContext: ScanContext = { namespaces: context.namespaces, className: nameNode?.text };
        for (const child of node.children) {
          collect(child, childContext);
        }
        return;
      }
      if (node.type === 'method_declaration') {
        if (context.namespaces.length > 0 && context.className !== undefined) {
          const nameNode = node.childForFieldName('name');
          if (nameNode && hasTestAttribute(node)) {
            methods.push({
              bare: nameNode.text,
              fullyQualifiedName: `${context.namespaces.join('.')}.${context.className}.${nameNode.text}`,
              line: nameNode.startPosition.row + 1
            });
          }
        }
        return;
      }
      // Structural nodes (compilation_unit, bodies, ...). A file-scoped
      // namespace does not wrap its declarations in the grammar: everything
      // declared after the node is inside that namespace.
      let current = context;
      for (const child of node.children) {
        if (child.type === 'file_scoped_namespace_declaration') {
          const nameNode = child.childForFieldName('name');
          current = {
            namespaces: nameNode ? [...current.namespaces, nameNode.text] : current.namespaces,
            className: undefined
          };
          continue;
        }
        collect(child, current);
      }
    };
    collect(tree.rootNode, { namespaces: [] });
    return methods;
  } finally {
    tree.delete();
  }
}

function hasTestAttribute(methodDeclaration: Node): boolean {
  for (const child of methodDeclaration.children) {
    if (child.type !== 'attribute_list') {
      continue;
    }
    for (const listChild of child.children) {
      if (listChild.type !== 'attribute') {
        continue;
      }
      const nameNode = listChild.childForFieldName('name');
      if (!nameNode) {
        continue;
      }
      const lastSegment = nameNode.text.split('.').pop() ?? '';
      if (TEST_ATTRIBUTE_LOOKUP.has(lastSegment.replace(/Attribute$/, '').toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

let parserPromise: Promise<Parser | null> | undefined;
let scanStore: FileScanCache | undefined;

/**
 * One scan store per extension-host process. Lazily created on first use; the
 * storage directory should be identical across callers (it always is: the
 * extension's global storage), so the JSON is parsed at most once per window.
 */
function ensureScanStore(storageDir: string | undefined): FileScanCache {
  if (!scanStore) {
    scanStore = new FileScanCache(storageDir);
  }
  return scanStore;
}

/**
 * Lazily initializes one tree-sitter parser per extension-host process, bound
 * to the WASM files under `<extension>/assets/wasm/`. Resolves to `null`
 * (with a single log line) whenever the runtime or WASM files are unusable —
 * callers then fall back to the regex extraction.
 */
async function ensureParser(extensionPath: string | undefined): Promise<Parser | null> {
  if (!parserPromise) {
    parserPromise = createParser(extensionPath).catch(err => {
      log(`tree-sitter WASM unavailable, using regex scan: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  }
  return parserPromise;
}

async function createParser(extensionPath: string | undefined): Promise<Parser | null> {
  if (!extensionPath) {
    return null;
  }
  const coreWasm = path.join(extensionPath, CORE_WASM);
  const csharpWasm = path.join(extensionPath, CSHARP_WASM);
  if (!fs.existsSync(coreWasm) || !fs.existsSync(csharpWasm)) {
    log('tree-sitter WASM assets missing, using regex scan');
    return null;
  }
  await Parser.init({ locateFile: () => coreWasm });
  const language = await Language.load(csharpWasm);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
