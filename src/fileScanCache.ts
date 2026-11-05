import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SourceLocation } from './sourceScan';

/**
 * Per-file extraction result shared by the regex scanner (sourceScan.ts) and
 * the AST scanner (astScan.ts); csproj-agnostic, so it can be memoized per
 * file and refolded into the input-order-dependent maps (methodIndex,
 * locations, projects) on every scan.
 */
export interface ExtractedMethod {
  bare: string;
  fullyQualifiedName: string;
  line: number; // 1-based
}

export type FileExtractor = (content: string) => ExtractedMethod[];

/**
 * Fold per-file extraction results into the three solution-level maps.
 * Preserves the exact first-wins semantics of the pre-incremental scanners:
 * maps must be fresh, and callers must iterate csprojs/files in the same
 * order as always (readdir order), because identical FQNs across overlapping
 * project directories resolve to the first owner met.
 */
export function foldMethods(
  methods: readonly ExtractedMethod[],
  file: string,
  csprojPath: string,
  methodIndex: Map<string, Set<string>>,
  locations: Map<string, SourceLocation>,
  projects: Map<string, string>
): void {
  for (const method of methods) {
    const bareNames = methodIndex.get(method.bare) ?? new Set<string>();
    bareNames.add(method.fullyQualifiedName);
    methodIndex.set(method.bare, bareNames);

    if (!locations.has(method.fullyQualifiedName)) {
      locations.set(method.fullyQualifiedName, { file, line: method.line });
    }
    if (!projects.has(method.fullyQualifiedName)) {
      projects.set(method.fullyQualifiedName, csprojPath);
    }
  }
}

/**
 * Write a file so readers never see a half-written result: the data goes to a
 * temp sibling first and is then renamed over the target. If the rename is
 * refused (some Windows setups), fall back to a direct write.
 */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore
    }
    fs.writeFileSync(file, data);
  }
}

/**
 * Order-independent digest of the FQNs a source scan found. Stored with the
 * cached `dotnet test --list-tests` result so adding/removing/renaming a test
 * in a .cs file (which changes no .sln/.csproj mtime) still invalidates it.
 */
export function fingerprintFqns(fqns: Iterable<string>): string {
  const sorted = [...fqns].sort();
  return crypto.createHash('sha1').update(sorted.join('\n')).digest('hex');
}

interface FileRecord {
  /** mtime in ms */
  m: number;
  /** file size in bytes */
  s: number;
  /** content digest — the key into `content` */
  h: string;
}

interface ContentRecord {
  /** scanner version that produced the extraction */
  v: string;
  /** compact [bare, fqn, line] tuples for each test method */
  t: [string, string, number][];
}

/** Bumped when the persisted shape changes; a mismatch starts an empty store. */
const STORE_SCHEMA = 2;

/**
 * Content identity of one file. Extraction depends on nothing but the text and
 * the scanner version, so identical content anywhere (another worktree, another
 * branch, another checkout of the same repo) can reuse the same extraction.
 */
export function contentHash(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Element-wise equality of the stored tuples (stringifying both arrays was
 * pure allocation overhead). A corrupt cache entry (missing or non-array
 * `t`, non-tuple elements) simply reports unequal so the entry gets
 * rewritten instead of throwing.
 */
function sameMethods(before: [string, string, number][] | undefined, after: [string, string, number][]): boolean {
  if (!Array.isArray(before) || before.length !== after.length) {
    return false;
  }
  return before.every((tuple, index) =>
    Array.isArray(tuple) &&
    tuple[0] === after[index][0] &&
    tuple[1] === after[index][1] &&
    tuple[2] === after[index][2]);
}

/**
 * Scan cache keyed by absolute file path, with extraction results stored by
 * content hash rather than by path.
 *
 * Two lookups, cheapest first: a path whose mtime+size are unchanged is served
 * without reading the file; a path whose stat changed is hashed after reading
 * and, if that content was seen before, reuses the extraction without parsing.
 * That second tier is what makes a different worktree or branch checkout of the
 * same sources warm instead of a full re-parse.
 *
 * Persisted to `<storageDir>/scan-cache.json` (whole-map write, best-effort —
 * like SolutionCache) when dirty. `storageDir === undefined` keeps the store
 * memory-only, which is what harnesses use.
 */
export class FileScanCache {
  private files: Record<string, FileRecord> = {};
  private content: Record<string, ContentRecord> = {};
  private readonly file: string | undefined;
  private readonly engineFile: string | undefined;
  // Materialized views of each content record's tuples, keyed by record object
  // — a WeakMap (rather than a field) keeps the persisted JSON free of the
  // duplicate form.
  private readonly materialized = new WeakMap<ContentRecord, ExtractedMethod[]>();
  private dirty = false;

  constructor(storageDir: string | undefined) {
    this.file = storageDir ? path.join(storageDir, 'scan-cache.json') : undefined;
    this.engineFile = storageDir ? path.join(storageDir, 'scan-engine.json') : undefined;
    if (this.file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.schema === STORE_SCHEMA) {
          this.files = parsed.files ?? {};
          this.content = parsed.content ?? {};
        }
      } catch {
        // Missing, corrupt or older-schema cache: start fresh, same as SolutionCache.
      }
    }
  }

  /** Path-keyed lookup: valid while mtime+size are unchanged. */
  get(file: string, mtimeMs: number, size: number, version: string): ExtractedMethod[] | undefined {
    const record = this.files[file];
    if (!record || record.m !== mtimeMs || record.s !== size) {
      return undefined;
    }
    return this.getByContent(record.h, version);
  }

  /** Content-keyed lookup: what a file's bytes extracted to, if seen before. */
  getByContent(hash: string, version: string): ExtractedMethod[] | undefined {
    const record = this.content[hash];
    if (!record || record.v !== version || !Array.isArray(record.t)) {
      return undefined;
    }
    // Materialize once per record — a fully-cached reload hits this for every
    // unchanged file — and share the result; callers must treat it as read-only.
    const cached = this.materialized.get(record);
    if (cached) {
      return cached;
    }
    const methods = record.t.map(([bare, fullyQualifiedName, line]) => ({ bare, fullyQualifiedName, line }));
    this.materialized.set(record, methods);
    return methods;
  }

  /** Record a path→content association without re-extracting (known content). */
  reuse(file: string, mtimeMs: number, size: number, hash: string): void {
    const before = this.files[file];
    if (!before || before.m !== mtimeMs || before.s !== size || before.h !== hash) {
      this.files[file] = { m: mtimeMs, s: size, h: hash };
      this.dirty = true;
    }
  }

  set(file: string, mtimeMs: number, size: number, hash: string, version: string, methods: readonly ExtractedMethod[]): void {
    this.reuse(file, mtimeMs, size, hash);
    const tuples = methods.map(method => [method.bare, method.fullyQualifiedName, method.line] as [string, string, number]);
    const before = this.content[hash];
    // The common case for known content is an identical extraction, so only
    // genuinely changed records mark the store for persistence.
    if (!before || before.v !== version || !sameMethods(before.t, tuples)) {
      this.content[hash] = { v: version, t: tuples };
      this.dirty = true;
    }
  }

  /**
   * Drop entries for files that no longer exist, then garbage-collect content
   * records nothing refers to any more. Only entries under one of `roots`
   * (directories whose listing succeeded this scan) are candidates, so scanning
   * one solution never evicts another solution's entries.
   */
  prune(seenFiles: ReadonlySet<string>, roots: readonly string[]): void {
    if (roots.length === 0) {
      return;
    }
    const prefixes = roots.map(root => (root.endsWith(path.sep) ? root : root + path.sep));
    for (const key of Object.keys(this.files)) {
      if (!seenFiles.has(key) && prefixes.some(prefix => key.startsWith(prefix))) {
        delete this.files[key];
        this.dirty = true;
      }
    }
    const reachable = new Set<string>();
    for (const record of Object.values(this.files)) {
      reachable.add(record.h);
    }
    for (const hash of Object.keys(this.content)) {
      if (!reachable.has(hash)) {
        delete this.content[hash];
        this.dirty = true;
      }
    }
  }

  /**
   * Whether the tree-sitter engine was previously found unusable for the given
   * asset signature. Persisted so a broken runtime does not make every window
   * start re-attempt WASM init and miss the whole cache (the cached entries
   * are keyed by the regex version in that case).
   */
  isAstBroken(signature: string): boolean {
    if (!this.engineFile) {
      return false;
    }
    try {
      return JSON.parse(fs.readFileSync(this.engineFile, 'utf8')).astBroken === signature;
    } catch {
      return false;
    }
  }

  markAstBroken(signature: string): void {
    if (!this.engineFile) {
      return;
    }
    try {
      writeFileAtomic(this.engineFile, JSON.stringify({ astBroken: signature }));
    } catch {
      // best-effort
    }
  }

  save(): void {
    if (!this.file || !this.dirty) {
      return;
    }
    try {
      writeFileAtomic(this.file, JSON.stringify({ schema: STORE_SCHEMA, files: this.files, content: this.content }));
      this.dirty = false;
    } catch {
      // Persistence is best-effort.
    }
  }
}
