import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * File-backed run diagnostics: every captured run stages its stdout/stderr,
 * log lines, TRX and stream-logger JSONL in a temp directory, and only failed
 * runs are promoted into extension storage. Nothing is accumulated in memory
 * (each chunk is written through) and nothing is ever written into the
 * workspace, so a run can never add files to the solution being tested.
 *
 * This module deliberately has no `vscode` import so it is directly testable
 * by the checked-in harness (`harness/diagnostics.js`).
 */

export const DEFAULT_RETENTION: DiagnosticsRetention = {
  retainRuns: 20,
  retainTotalMb: 200,
  retainDays: 14
};

/** Names of the fixed per-run artifacts, in the order they are written. */
export type FixedArtifactName = 'stdout.log' | 'stderr.log' | 'run.log' | 'stream.jsonl';

/** Default page size for artifact reads over the control API. */
export const DEFAULT_ARTIFACT_PAGE_BYTES = 64 * 1024;

export interface DiagnosticsRetention {
  /** Promoted runs kept on disk; 0 disables retention entirely. */
  retainRuns: number;
  /** Total size budget for retained runs; 0 means unbounded. */
  retainTotalMb: number;
  /** Runs older than this are pruned; 0 means unbounded. */
  retainDays: number;
}

export enum CaptureKind {
  Build = 'build',
  Tests = 'tests'
}

export enum CaptureStatus {
  Passed = 'passed',
  Failed = 'failed',
  Error = 'error',
  Cancelled = 'cancelled'
}

export interface CaptureMeta {
  kind: CaptureKind;
  solutionPath: string;
  projectPath?: string;
  debug?: boolean;
  command?: readonly string[];
}

export interface ArtifactEntry {
  name: string;
  bytes: number;
}

export interface RunManifest extends CaptureMeta {
  runId: string;
  status: CaptureStatus;
  /** Failures reported in this capture (test failures, or 1 for a failed build). */
  failureCount: number;
  startedAt: string;
  finishedAt: string;
  artifacts: ArtifactEntry[];
}

export interface RunSummary {
  runId: string;
  kind: CaptureKind;
  status: CaptureStatus;
  solutionPath: string;
  projectPath?: string;
  debug: boolean;
  failureCount: number;
  startedAt: string;
  finishedAt: string;
  directory: string;
  totalBytes: number;
}

export interface ArtifactPage {
  runId: string;
  name: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  totalBytes: number;
  text: string;
}

export interface ChunkPreview {
  text: string;
  omittedChars: number;
}

const MANIFEST_NAME = 'manifest.json';
const STAGING_PREFIX = 'dotnet-testing-plus-';

/**
 * Cut `text` to at most `max` UTF-16 code units without splitting a surrogate
 * pair: a preview may be short, but it must never emit a broken character.
 */
export function previewChunk(text: string, max: number): ChunkPreview {
  if (max <= 0) {
    return { text: '', omittedChars: text.length };
  }
  if (text.length <= max) {
    return { text, omittedChars: 0 };
  }
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return { text: text.slice(0, cut), omittedChars: text.length - cut };
}

/**
 * The line a captured chunk logs. Truncation is never silent: it names both the
 * number of omitted characters and where the full text lives.
 */
export function formatChunkPreview(text: string, max: number, artifactPath?: string): string {
  const preview = previewChunk(text, max);
  if (preview.omittedChars === 0) {
    return preview.text;
  }
  const where = artifactPath
    ? `full text: ${artifactPath}`
    : 'full text not retained (dotnetTestingPlus.diagnostics.retainRuns = 0)';
  return `${preview.text}\n... (${preview.omittedChars} chars omitted; ${where})`;
}

export interface RetentionEntry {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * Which retained runs to delete, given the bounds. The newest run is never
 * pruned, so a single run larger than the whole budget still survives.
 */
export function planRetention(
  entries: readonly RetentionEntry[],
  retention: DiagnosticsRetention,
  now = Date.now()
): string[] {
  if (retention.retainRuns <= 0) {
    return entries.map(entry => entry.name);
  }
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const maxAgeMs = retention.retainDays > 0 ? retention.retainDays * 24 * 60 * 60 * 1000 : Infinity;
  const doomed = new Set<string>();
  const kept: RetentionEntry[] = [];
  newestFirst.forEach((entry, index) => {
    if (index >= retention.retainRuns) {
      doomed.add(entry.name);
      return;
    }
    // Keep at least one run regardless of age.
    if (index > 0 && now - entry.mtimeMs > maxAgeMs) {
      doomed.add(entry.name);
      return;
    }
    kept.push(entry);
  });
  const maxBytes = retention.retainTotalMb > 0 ? retention.retainTotalMb * 1024 * 1024 : Infinity;
  let total = 0;
  kept.forEach((entry, index) => {
    total += entry.bytes;
    if (total > maxBytes && index > 0) {
      doomed.add(entry.name);
    }
  });
  return [...doomed];
}

/**
 * Index window of a UTF-8 buffer that holds only complete characters: leading
 * continuation bytes and a trailing incomplete sequence are excluded so pages
 * never contain U+FFFD and reassemble losslessly.
 */
export function completeUtf8Window(buffer: Buffer): { start: number; end: number } {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  let end = buffer.length;
  let back = 0;
  while (back < Math.min(3, end - start) && (buffer[end - 1 - back] & 0xc0) === 0x80) {
    back += 1;
  }
  const lead = end - 1 - back;
  if (lead >= start) {
    const leadByte = buffer[lead];
    const needed = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 1;
    if (needed > back + 1) {
      end = lead;
    }
  }
  return { start, end };
}

function compactTimestamp(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** Filesystem- and URL-safe id fragment. */
function slugify(value: string, fallback = 'run'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 60) : fallback;
}

function uniqueDirectory(parent: string, base: string, suffix: string): string {
  let candidate = path.join(parent, `${base}${suffix ? `-${suffix}` : ''}`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base}-${counter}${suffix ? `-${suffix}` : ''}`);
    counter += 1;
  }
  return candidate;
}

/**
 * One run capture in its staging directory. Writes are synchronous and go
 * straight to disk so ordering is exact and nothing is buffered in memory;
 * a diagnostics failure disables further writes instead of breaking the run.
 */
export class RunCapture {
  private readonly handles = new Map<string, number>();
  private readonly bytes = new Map<string, number>();
  private readonly startedAt = new Date();
  private failureCount = 0;
  private broken = false;

  private constructor(
    readonly runId: string,
    readonly directory: string,
    readonly meta: CaptureMeta
  ) {}

  /** Stage a capture in a fresh temp directory; never throws. */
  static begin(meta: CaptureMeta, stagingRoot?: string): RunCapture | undefined {
    const id = slugify(path.basename(meta.projectPath ?? meta.solutionPath).replace(/\.[^.]+$/, ''));
    try {
      const root = stagingRoot ?? path.join(os.tmpdir(), 'dotnet-testing-plus-diagnostics');
      fs.mkdirSync(root, { recursive: true });
      const directory = fs.mkdtempSync(path.join(root, `${STAGING_PREFIX}${id}-`));
      const runId = `${compactTimestamp(new Date())}-${meta.kind}-${id}`;
      return new RunCapture(runId, directory, meta);
    } catch {
      return undefined;
    }
  }

  addFailures(count: number): void {
    this.failureCount += Math.max(0, count);
  }

  /** Append a chunk verbatim; the caller decides what is stdout vs stderr. */
  append(name: string, text: string): void {
    if (this.broken || text.length === 0) {
      return;
    }
    try {
      let handle = this.handles.get(name);
      if (handle === undefined) {
        handle = fs.openSync(path.join(this.directory, name), 'a');
        this.handles.set(name, handle);
      }
      fs.writeSync(handle, text);
      this.bytes.set(name, (this.bytes.get(name) ?? 0) + Buffer.byteLength(text, 'utf8'));
    } catch {
      this.broken = true;
    }
  }

  /** Path of an artifact inside the capture, for log messages. */
  artifactPath(name: string): string {
    return path.join(this.directory, name);
  }

  /**
   * Copy an externally written artifact (a TRX, the stream logger's JSONL) into
   * the capture. The caller owns removing the original.
   */
  attach(sourcePath: string, name: string): boolean {
    if (this.broken) {
      return false;
    }
    try {
      const target = path.join(this.directory, name);
      fs.copyFileSync(sourcePath, target);
      this.bytes.set(name, fs.statSync(target).size);
      return true;
    } catch {
      return false;
    }
  }

  /** Freeze the capture and write its manifest; never throws. */
  finish(status: CaptureStatus): RunManifest | undefined {
    const finishedAt = new Date();
    this.closeHandles();
    const artifacts: ArtifactEntry[] = [];
    for (const [name, bytes] of this.bytes) {
      artifacts.push({ name, bytes });
    }
    artifacts.sort((a, b) => a.name.localeCompare(b.name));
    const manifest: RunManifest = {
      ...this.meta,
      runId: this.runId,
      status,
      failureCount: this.failureCount,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      artifacts
    };
    try {
      fs.writeFileSync(path.join(this.directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
      return undefined;
    }
    return manifest;
  }

  /** Remove the staging directory (green run, or retention disabled). */
  discard(): void {
    this.closeHandles();
    try {
      fs.rmSync(this.directory, { recursive: true, force: true });
    } catch {
      // best effort: temp directories are also reclaimed by the OS
    }
  }

  private closeHandles(): void {
    for (const handle of this.handles.values()) {
      try {
        fs.closeSync(handle);
      } catch {
        // already closed
      }
    }
    this.handles.clear();
  }
}

/**
 * Promoted-run store: the authoritative, durable record of failed runs.
 *
 * Layout: `<root>/<runId>/{manifest.json, stdout.log, stderr.log, run.log,
 * stream.jsonl, results-N.trx}`.
 */
export class RunDiagnosticsStore {
  private readonly stagingRoot: string;

  constructor(
    readonly root: string,
    private retention: DiagnosticsRetention = DEFAULT_RETENTION,
    stagingRoot?: string
  ) {
    this.stagingRoot = stagingRoot ?? path.join(os.tmpdir(), 'dotnet-testing-plus-diagnostics');
  }

  setRetention(retention: DiagnosticsRetention): void {
    this.retention = retention;
  }

  get enabled(): boolean {
    return this.retention.retainRuns > 0;
  }

  /** Start a capture; returns undefined when retention is disabled. */
  begin(meta: CaptureMeta): RunCapture | undefined {
    if (!this.enabled) {
      return undefined;
    }
    return RunCapture.begin(meta, this.stagingRoot);
  }

  /**
   * Promote a finished capture into the store (or delete it). Returns the
   * retained directory, or undefined when nothing was kept.
   */
  settle(capture: RunCapture | undefined, status: CaptureStatus, keep: boolean): string | undefined {
    if (!capture) {
      return undefined;
    }
    const manifest = capture.finish(status);
    if (!keep || !manifest) {
      capture.discard();
      return undefined;
    }
    // Two captures can share a second and a project, so never reuse a name.
    const target = uniqueDirectory(this.root, capture.runId, '');
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.renameSync(capture.directory, target);
    } catch {
      // A cross-device rename fails; fall back to a copy.
      try {
        fs.cpSync(capture.directory, target, { recursive: true });
      } catch {
        capture.discard();
        return undefined;
      }
    }
    capture.discard();
    rewriteRunId(target, path.basename(target));
    this.prune();
    return target;
  }

  /** Delete runs outside the configured bounds. */
  prune(now = Date.now()): string[] {
    const entries = this.entries();
    const doomed = planRetention(entries, this.retention, now);
    for (const name of doomed) {
      try {
        fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    return doomed;
  }

  list(): RunSummary[] {
    return this.entries()
      .map(entry => this.summary(entry))
      .filter((summary): summary is RunSummary => summary !== undefined)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  manifest(runId: string): RunManifest | undefined {
    const directory = this.resolve(runId);
    if (!directory) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_NAME), 'utf8')) as RunManifest;
      return typeof parsed.runId === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One page of a retained artifact. The artifact must be listed in the run's
   * manifest, so a run id plus a name can never read outside its directory.
   */
  readArtifact(runId: string, name: string, offset: number, limit: number): ArtifactPage | undefined {
    const manifest = this.manifest(runId);
    if (!manifest || !manifest.artifacts.some(entry => entry.name === name)) {
      return undefined;
    }
    const directory = this.resolve(runId);
    if (!directory) {
      return undefined;
    }
    const file = path.join(directory, name);
    try {
      const size = fs.statSync(file).size;
      const start = Math.min(Math.max(0, offset), size);
      const pageSize = Math.min(Math.max(1, limit), DEFAULT_ARTIFACT_PAGE_BYTES * 16);
      const requested = Math.min(pageSize, size - start);
      // A character is at most 4 bytes, so a few extra bytes let the window end
      // on a character boundary instead of returning a page with no progress.
      const length = Math.min(requested + 4, size - start);
      const buffer = Buffer.alloc(length);
      const handle = fs.openSync(file, 'r');
      let read = 0;
      try {
        read = fs.readSync(handle, buffer, 0, length, start);
      } finally {
        fs.closeSync(handle);
      }
      const window = completeUtf8Window(buffer.subarray(0, read));
      // An offset inside a character can leave nothing complete in the window;
      // return the raw bytes rather than a page that cannot make progress.
      const bounded = window.end > window.start ? window : { start: 0, end: read };
      return {
        runId,
        name,
        offset: start,
        nextOffset: start + bounded.end,
        eof: start + bounded.end >= size,
        totalBytes: size,
        text: buffer.subarray(bounded.start, bounded.end).toString('utf8')
      };
    } catch {
      return undefined;
    }
  }

  /** Delete every retained run; returns how many were removed. */
  clear(): number {
    const entries = this.entries();
    for (const entry of entries) {
      try {
        fs.rmSync(path.join(this.root, entry.name), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    return entries.length;
  }

  /** Retained run directories, newest first, with their on-disk size. */
  private entries(): RetentionEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const entries: RetentionEntry[] = [];
    for (const name of names) {
      const directory = path.join(this.root, name);
      try {
        const stat = fs.statSync(directory);
        if (!stat.isDirectory()) {
          continue;
        }
        const manifest = this.manifest(name);
        const bytes = manifest
          ? manifest.artifacts.reduce((total, artifact) => total + artifact.bytes, 0)
          : directorySize(directory);
        entries.push({ name, bytes, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished while listing
      }
    }
    return entries;
  }

  private summary(entry: RetentionEntry): RunSummary | undefined {
    const manifest = this.manifest(entry.name);
    if (!manifest) {
      return undefined;
    }
    return {
      runId: manifest.runId,
      kind: manifest.kind,
      status: manifest.status,
      solutionPath: manifest.solutionPath,
      projectPath: manifest.projectPath,
      debug: manifest.debug ?? false,
      failureCount: manifest.failureCount,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      directory: path.join(this.root, entry.name),
      totalBytes: entry.bytes
    };
  }

  /** Map a run id to a directory under the root, rejecting anything else. */
  private resolve(runId: string): string | undefined {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(runId) || runId.includes('..')) {
      return undefined;
    }
    const directory = path.join(this.root, runId);
    return fs.existsSync(directory) ? directory : undefined;
  }
}

/** Point a promoted manifest at the directory name it actually got. */
function rewriteRunId(directory: string, runId: string): void {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_NAME), 'utf8')) as RunManifest;
    if (manifest.runId === runId) {
      return;
    }
    manifest.runId = runId;
    fs.writeFileSync(path.join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // A manifest that cannot be rewritten still lists its artifacts.
  }
}

function directorySize(directory: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      total += entry.isDirectory() ? directorySize(child) : fs.statSync(child).size;
    }
  } catch {
    // best effort
  }
  return total;
}
