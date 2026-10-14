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

interface StorageEntry {
  /** mtime in ms */
  m: number;
  /** file size in bytes */
  s: number;
  /** scanner version that produced the extraction */
  v: string;
  /** compact [bare, fqn, line] tuples for each test method */
  t: [string, string, number][];
}

/**
 * Scan cache keyed by absolute file path. An entry is valid as long as the
 * file's mtime and size are unchanged and the scanner version matches;
 * extraction logic changes must bump the version so every entry invalidates
 * exactly once (mirrors SolutionCache's parserVersion contract).
 *
 * Persisted to `<storageDir>/scan-cache.json` (whole-map write, best-effort —
 * like SolutionCache) when dirty. `storageDir === undefined` keeps the store
 * memory-only, which is what harnesses use.
 */
export class FileScanCache {
  private data: Record<string, StorageEntry> = {};
  private readonly file: string | undefined;
  private readonly engineFile: string | undefined;
  private dirty = false;

  constructor(storageDir: string | undefined) {
    this.file = storageDir ? path.join(storageDir, 'scan-cache.json') : undefined;
    this.engineFile = storageDir ? path.join(storageDir, 'scan-engine.json') : undefined;
    if (this.file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.data = parsed;
        }
      } catch {
        // Missing or corrupt cache: start fresh, same as SolutionCache.
      }
    }
  }

  get(file: string, mtimeMs: number, size: number, version: string): ExtractedMethod[] | undefined {
    const entry = this.data[file];
    if (!entry || entry.m !== mtimeMs || entry.s !== size || entry.v !== version || !Array.isArray(entry.t)) {
      return undefined;
    }
    return entry.t.map(([bare, fullyQualifiedName, line]) => ({ bare, fullyQualifiedName, line }));
  }

  set(file: string, mtimeMs: number, size: number, version: string, methods: readonly ExtractedMethod[]): void {
    const stored: StorageEntry = {
      m: mtimeMs,
      s: size,
      v: version,
      t: methods.map(method => [method.bare, method.fullyQualifiedName, method.line])
    };
    const before = this.data[file];
    // The common case for known files is an identical extraction, so only
    // genuinely changed entries mark the store for persistence.
    if (
      !before ||
      before.m !== stored.m ||
      before.s !== stored.s ||
      before.v !== stored.v ||
      JSON.stringify(before.t) !== JSON.stringify(stored.t)
    ) {
      this.data[file] = stored;
      this.dirty = true;
    }
  }

  /**
   * Drop entries for files that no longer exist. Only entries under one of
   * `roots` (directories whose listing succeeded this scan) are candidates, so
   * scanning one solution never evicts another solution's entries.
   */
  prune(seenFiles: ReadonlySet<string>, roots: readonly string[]): void {
    if (roots.length === 0) {
      return;
    }
    const prefixes = roots.map(root => (root.endsWith(path.sep) ? root : root + path.sep));
    for (const key of Object.keys(this.data)) {
      if (!seenFiles.has(key) && prefixes.some(prefix => key.startsWith(prefix))) {
        delete this.data[key];
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
      writeFileAtomic(this.file, JSON.stringify(this.data));
      this.dirty = false;
    } catch {
      // Persistence is best-effort.
    }
  }
}
