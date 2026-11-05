#!/usr/bin/env node
/*
 * Verification harness for run diagnostics (src/runDiagnostics.ts,
 * src/logger.ts). Checked in on purpose: it is the only executable evidence
 * that failure output survives losslessly, so it is re-runnable after changes.
 *
 *   npm run compile && npm run harness
 *
 * Runs against the compiled out/ build with a stubbed `vscode` module, so no
 * extension host and no dotnet process is needed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// --- vscode stub -----------------------------------------------------------
const outputLines = [];
const vscodeStub = {
  window: {
    createOutputChannel: () => ({
      appendLine: line => outputLines.push(line),
      show: () => undefined
    })
  }
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') {
    return 'vscode-stub';
  }
  return originalResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

const out = file => path.join(__dirname, '..', 'out', file);
const {
  CaptureKind,
  CaptureStatus,
  RunCapture,
  RunDiagnosticsStore,
  completeUtf8Window,
  formatChunkPreview,
  planRetention,
  previewChunk
} = require(out('runDiagnostics.js'));
const { logChunk, log, recentLogLines, setRunCapture } = require(out('logger.js'));

// --- tiny runner -----------------------------------------------------------
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dnt-harness-'));
let tempCounter = 0;
function tempDir(name) {
  const dir = path.join(tempRoot, `${name}-${tempCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function beginCapture(meta = {}) {
  const capture = RunCapture.begin(
    {
      kind: CaptureKind.Tests,
      solutionPath: '/src/Product/MES/UI/src/test/e2e/MES.sln',
      projectPath: '/src/Product/MES/UI/src/test/e2e/E2E.Login/E2E.Login.csproj',
      debug: false,
      ...meta
    },
    tempDir('stage')
  );
  assert.ok(capture, 'capture should start');
  return capture;
}

const read = file => fs.readFileSync(file, 'utf8');

// --- chunk preservation ----------------------------------------------------
console.log('chunk preservation');

for (const length of [499, 500, 501]) {
  test(`stdout and stderr keep a ${length}-char chunk byte for byte`, () => {
    const text = 'x'.repeat(length);
    const capture = beginCapture();
    capture.append('stdout.log', text);
    capture.append('stderr.log', text);
    const manifest = capture.finish(CaptureStatus.Failed);
    assert.strictEqual(read(path.join(capture.directory, 'stdout.log')), text);
    assert.strictEqual(read(path.join(capture.directory, 'stderr.log')), text);
    assert.ok(manifest, 'manifest written');
    const names = manifest.artifacts.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['stderr.log', 'stdout.log']);
    capture.discard();
  });
}

test('preview truncation is exact at 500 and 501 characters', () => {
  assert.deepStrictEqual(previewChunk('x'.repeat(500), 500), { text: 'x'.repeat(500), omittedChars: 0 });
  const cut = previewChunk('x'.repeat(501), 500);
  assert.strictEqual(cut.omittedChars, 1);
  assert.strictEqual(cut.text.length, 500);
});

test('a truncated preview names the artifact instead of hiding the loss', () => {
  const preview = formatChunkPreview('y'.repeat(1000), 100, '/storage/diagnostics/run/stdout.log');
  assert.ok(preview.startsWith('y'.repeat(100)), 'preview keeps the head');
  assert.ok(preview.includes('900 chars omitted'), 'states what was omitted');
  assert.ok(preview.includes('/storage/diagnostics/run/stdout.log'), 'names the full text');
  const disabled = formatChunkPreview('y'.repeat(1000), 100);
  assert.ok(disabled.includes('retainRuns = 0'), 'explains why nothing was retained');
});

test('a very long chunk (200 KB) is captured whole', () => {
  const text = 'stack-frame /src/Product/MES/UI/src/test/e2e/Fixtures/Long.cs:line 42\n'.repeat(3000);
  assert.ok(text.length > 200000);
  const capture = beginCapture();
  capture.append('stdout.log', text);
  capture.finish(CaptureStatus.Failed);
  assert.strictEqual(read(path.join(capture.directory, 'stdout.log')), text);
  capture.discard();
});

test('multiline unicode survives, and chunk boundaries are irrelevant', () => {
  const chunks = [
    '   at Ns.Cl',
    'ass.Method() in /src/Product/MES/UI/src/test/e2e/Fixtures/Ünïcode_テスト.cs:line 42\n',
    '😀🚀 émoji 中文 مرحبا\n',
    '   at Ns.Other.Method() in C:\\src\\Product\\MES\\UI\\src\\test\\e2e\\Fixtures\\Ünïcode.cs:line 7\n'
  ];
  const capture = beginCapture();
  for (const chunk of chunks) {
    capture.append('stdout.log', chunk);
  }
  capture.finish(CaptureStatus.Failed);
  assert.strictEqual(read(path.join(capture.directory, 'stdout.log')), chunks.join(''));
  capture.discard();
});

test('debug-mode captures record the same text and the debug flag', () => {
  const text = 'Process Id: 4242\ndebug chunk '.repeat(100);
  const capture = beginCapture({ debug: true });
  capture.append('stdout.log', text);
  const manifest = capture.finish(CaptureStatus.Failed);
  assert.strictEqual(manifest.debug, true);
  assert.strictEqual(read(path.join(capture.directory, 'stdout.log')), text);
  capture.discard();
});

// --- log window vs artifact ------------------------------------------------
console.log('log window vs artifact');

test('the log channel keeps long chunks and the recent window stays bounded', () => {
  const text = 'z'.repeat(1000);
  logChunk(undefined, 'stdout', text);
  assert.strictEqual(outputLines[outputLines.length - 1].split(' ').slice(2).join(' '), text);
  const recent = recentLogLines(1)[0];
  assert.ok(recent.includes('z'.repeat(1000)), 'under the cap, the recent window is lossless');
});

test('more than 500 output events stay recoverable in the artifact', () => {
  const capture = beginCapture();
  const lines = 1000;
  for (let i = 0; i < lines; i += 1) {
    logChunk(capture, 'stdout', `line ${String(i).padStart(4, '0')} ${'y'.repeat(200)}\n`);
  }
  capture.finish(CaptureStatus.Failed);
  const written = read(path.join(capture.directory, 'stdout.log')).split('\n').filter(Boolean);
  assert.strictEqual(written.length, lines, 'every event is in the artifact');
  assert.ok(written[0].startsWith('line 0000 '));
  assert.ok(written[999].startsWith('line 0999 '));
  assert.strictEqual(recentLogLines(200).length, 200, 'the in-memory window is still capped');
  capture.discard();
});

test('run log lines land in run.log only while a capture is active', () => {
  const capture = beginCapture();
  setRunCapture(capture);
  log('inside the run');
  setRunCapture(undefined);
  log('outside the run');
  capture.finish(CaptureStatus.Failed);
  const runLog = read(path.join(capture.directory, 'run.log'));
  assert.ok(runLog.includes('inside the run'));
  assert.ok(!runLog.includes('outside the run'));
  capture.discard();
});

test('a huge chunk keeps the artifact whole while the channel preview is capped', () => {
  const text = 'h'.repeat(100 * 1024);
  const capture = beginCapture();
  logChunk(capture, 'stderr', text);
  capture.finish(CaptureStatus.Failed);
  assert.strictEqual(read(path.join(capture.directory, 'stderr.log')), text);
  const logged = outputLines[outputLines.length - 1];
  assert.ok(logged.includes('chars omitted'), 'channel says it was capped');
  // The run id survives promotion and is not a staging path that disappears.
  assert.ok(logged.includes(`${capture.runId}/stderr.log`), 'and names the artifact by run');
  assert.ok(!logged.includes(capture.directory), 'never a staging path that later vanishes');
  capture.discard();
});

// --- retention -------------------------------------------------------------
console.log('retention');

const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const entries = Array.from({ length: 25 }, (_, index) => ({
  name: `run-${String(index).padStart(2, '0')}`,
  bytes: 10 * 1024 * 1024,
  mtimeMs: now - index * day
}));

test('count bound prunes the oldest runs', () => {
  const doomed = planRetention(entries, { retainRuns: 20, retainTotalMb: 0, retainDays: 0 }, now);
  assert.strictEqual(doomed.length, 5);
  assert.deepStrictEqual(doomed.sort(), ['run-20', 'run-21', 'run-22', 'run-23', 'run-24']);
});

test('age bound prunes old runs but never the newest', () => {
  const old = [
    { name: 'stale', bytes: 1, mtimeMs: now - 30 * day },
    { name: 'fresh', bytes: 1, mtimeMs: now - 1000 }
  ];
  assert.deepStrictEqual(planRetention(old, { retainRuns: 20, retainTotalMb: 0, retainDays: 14 }, now), ['stale']);
  const onlyStale = [{ name: 'stale', bytes: 1, mtimeMs: now - 30 * day }];
  assert.deepStrictEqual(planRetention(onlyStale, { retainRuns: 20, retainTotalMb: 0, retainDays: 14 }, now), []);
});

test('size budget prunes from the oldest end', () => {
  const doomed = planRetention(entries, { retainRuns: 20, retainTotalMb: 100, retainDays: 0 }, now);
  // 10 MB each: only the newest ten fit the 100 MB budget.
  assert.deepStrictEqual(
    doomed.sort(),
    Array.from({ length: 15 }, (_, index) => `run-${String(index + 10).padStart(2, '0')}`)
  );
});

test('retainRuns 0 disables retention', () => {
  assert.strictEqual(planRetention(entries, { retainRuns: 0, retainTotalMb: 200, retainDays: 14 }, now).length, 25);
  const store = new RunDiagnosticsStore(tempDir('disabled'), { retainRuns: 0, retainTotalMb: 200, retainDays: 14 }, tempDir('stage'));
  assert.strictEqual(store.enabled, false);
  assert.strictEqual(store.begin({ kind: CaptureKind.Tests, solutionPath: '/s.sln' }), undefined);
});

// --- store: promote, list, read -------------------------------------------
console.log('store');

function promote(store, { status = CaptureStatus.Failed, keep = true, text = 'out\n', extras = [] } = {}) {
  const capture = store.begin({
    kind: CaptureKind.Tests,
    solutionPath: '/src/Product/MES/UI/src/test/e2e/MES.sln',
    projectPath: '/src/Product/MES/UI/src/test/e2e/E2E.Login/E2E.Login.csproj',
    debug: false
  });
  assert.ok(capture, 'store should stage a capture');
  capture.append('stdout.log', text);
  for (const [source, name] of extras) {
    assert.ok(capture.attach(source, name), `attached ${name}`);
  }
  return { directory: store.settle(capture, status, keep), capture };
}

test('a failed run is promoted with its TRX and JSONL', () => {
  const root = tempDir('store');
  const store = new RunDiagnosticsStore(root, { retainRuns: 20, retainTotalMb: 200, retainDays: 14 }, tempDir('stage'));
  const trx = path.join(tempDir('src'), 'result.trx');
  fs.writeFileSync(trx, '<TestRun><Results /></TestRun>');
  const jsonl = path.join(tempDir('src'), 'stream.jsonl');
  fs.writeFileSync(jsonl, '{"fqn":"Ns.C.M","outcome":"Failed"}\n');
  const { directory } = promote(store, {
    status: CaptureStatus.Failed,
    extras: [[trx, 'results-1.trx'], [jsonl, 'stream.jsonl']]
  });
  assert.ok(directory, 'directory retained');
  const manifest = store.manifest(path.basename(directory));
  assert.strictEqual(manifest.status, 'failed');
  assert.strictEqual(manifest.kind, 'tests');
  assert.ok(manifest.artifacts.some(a => a.name === 'results-1.trx'));
  assert.ok(manifest.artifacts.some(a => a.name === 'stream.jsonl'));
  assert.strictEqual(read(path.join(directory, 'results-1.trx')), '<TestRun><Results /></TestRun>');
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.list()[0].totalBytes > 0, true);
});

test('a passing run leaves nothing behind', () => {
  const root = tempDir('green');
  const store = new RunDiagnosticsStore(root, { retainRuns: 20, retainTotalMb: 200, retainDays: 14 }, tempDir('stage'));
  const { directory, capture } = promote(store, { status: CaptureStatus.Passed, keep: false });
  assert.strictEqual(directory, undefined);
  assert.strictEqual(fs.existsSync(capture.directory), false, 'staging directory removed');
  assert.deepStrictEqual(store.list(), []);
});

test('retention prunes promoted runs down to the bound', () => {
  const root = tempDir('prune');
  const store = new RunDiagnosticsStore(root, { retainRuns: 3, retainTotalMb: 0, retainDays: 0 }, tempDir('stage'));
  for (let i = 0; i < 5; i += 1) {
    const capture = store.begin({ kind: CaptureKind.Tests, solutionPath: '/s.sln', projectPath: `/p${i}.csproj` });
    capture.append('stdout.log', `run ${i}\n`);
    store.settle(capture, CaptureStatus.Failed, true);
  }
  assert.strictEqual(store.list().length, 3, 'only the newest three runs survive');
  assert.strictEqual(fs.readdirSync(root).length, 3);
});

test('artifact reads reject names outside the manifest', () => {
  const root = tempDir('traversal');
  const store = new RunDiagnosticsStore(root, { retainRuns: 20, retainTotalMb: 200, retainDays: 14 }, tempDir('stage'));
  const { directory } = promote(store);
  const runId = path.basename(directory);
  assert.strictEqual(store.readArtifact(runId, '../../../../etc/passwd', 0, 10), undefined);
  assert.strictEqual(store.readArtifact(runId, 'run.log', 0, 10), undefined, 'not in the manifest');
  assert.strictEqual(store.readArtifact('../' + runId, 'stdout.log', 0, 10), undefined, 'invalid run id');
  assert.ok(store.readArtifact(runId, 'stdout.log', 0, 10), 'listed artifact is readable');
});

test('paginated reads reassemble the artifact exactly, even across emoji', () => {
  const root = tempDir('page');
  const store = new RunDiagnosticsStore(root, { retainRuns: 20, retainTotalMb: 200, retainDays: 14 }, tempDir('stage'));
  const text = `${'a'.repeat(1000)}😀${'中'.repeat(700)}${'b'.repeat(5000)}\n`;
  const { directory } = promote(store, { text });
  const runId = path.basename(directory);
  let offset = 0;
  let assembled = '';
  let totalBytes = 0;
  for (let guard = 0; guard < 10000; guard += 1) {
    const page = store.readArtifact(runId, 'stdout.log', offset, 3);
    assert.ok(page, 'page read');
    assert.ok(!page.text.includes('\uFFFD'), 'no replacement characters');
    assert.ok(page.nextOffset > offset || page.eof, 'every page makes progress');
    assembled += page.text;
    totalBytes = page.totalBytes;
    offset = page.nextOffset;
    if (page.eof) {
      break;
    }
  }
  assert.strictEqual(assembled, text);
  const past = store.readArtifact(runId, 'stdout.log', totalBytes + 100, 10);
  assert.strictEqual(past.eof, true);
  assert.strictEqual(past.text, '');
});

test('completeUtf8Window trims only incomplete sequences', () => {
  const emoji = Buffer.from('😀', 'utf8');
  // An offset inside the emoji starts on a continuation byte.
  const window = completeUtf8Window(Buffer.concat([emoji.subarray(1, 3), Buffer.from('ab')]));
  assert.strictEqual(window.start, 2);
  assert.strictEqual(window.end, 4);
  const tail = completeUtf8Window(Buffer.concat([Buffer.from('ab'), emoji.subarray(0, 3)]));
  assert.deepStrictEqual(tail, { start: 0, end: 2 });
  assert.deepStrictEqual(completeUtf8Window(Buffer.from('plain')), { start: 0, end: 5 });
});

test('clear removes every retained run', () => {
  const root = tempDir('clear');
  const store = new RunDiagnosticsStore(root, { retainRuns: 20, retainTotalMb: 200, retainDays: 14 }, tempDir('stage'));
  promote(store);
  promote(store);
  assert.strictEqual(store.list().length, 2);
  assert.strictEqual(store.clear(), 2);
  assert.strictEqual(store.list().length, 0);
});

// --- summary ---------------------------------------------------------------
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
} catch {
  // temp files only
}

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} harness checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
