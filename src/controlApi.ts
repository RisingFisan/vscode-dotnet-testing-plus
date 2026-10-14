import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { log } from './logger';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_LOG_LINES = 200;

export class ControlApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ControlApiSessionSummary {
  key: string;
  label: string;
  solutionPath: string;
  ready: boolean;
  loading: boolean;
  testCount?: number;
  playlistPath?: string;
  message?: string;
}

export interface ControlApiState {
  apiVersion: 1;
  activeSessionKey?: string;
  sessions: ControlApiSessionSummary[];
  runInProgress: boolean;
  filter: string;
  resultCounts: Record<string, number>;
  notFoundTests: string[];
  runsettings?: { mode: string; path?: string };
}

export interface ControlApiTest {
  solutionPath: string;
  project?: string;
  fqn: string;
  name: string;
  class?: string;
  state: string;
  durationMs?: number;
  file?: string;
  line?: number;
}

export interface ControlApiRunResult {
  started: boolean;
  matched: number;
  missing: string[];
}

export interface ControlApiRunOptions {
  all?: boolean;
  fqns?: string[];
  solution?: string;
  debug?: boolean;
}

export interface ControlApiHandlers {
  getState(): ControlApiState;
  getTests(solutionKey?: string): { tests: ControlApiTest[] };
  runTests(options: ControlApiRunOptions): Promise<ControlApiRunResult>;
  cancelRun(options: { loading?: boolean }): { cancelled: boolean; cancelledLoading: boolean };
  setPlaylist(solutionKey: string | undefined, playlistPath: string | undefined): Promise<{ matched: number; notFound: number }>;
  setFilter(text: string): void;
  selectSession(key: string): Promise<boolean>;
  logLines(limit: number): string[];
}

const ENDPOINTS: Record<string, 'GET' | 'POST'> = {
  '/state': 'GET',
  '/tests': 'GET',
  '/log': 'GET',
  '/run': 'POST',
  '/cancel': 'POST',
  '/playlist': 'POST',
  '/filter': 'POST',
  '/session': 'POST'
};

export function startControlApi(
  port: number,
  token: string,
  handlers: ControlApiHandlers,
  onListening?: (boundPort: number) => void
): vscode.Disposable {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, token, handlers).catch(() => undefined);
  });
  server.on('error', err => {
    log(`Control API error: ${err instanceof Error ? err.message : String(err)}`);
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    log(`Control API listening on http://127.0.0.1:${boundPort}`);
    if (onListening) {
      onListening(boundPort);
    }
  });
  return new vscode.Disposable(() => {
    server.close();
    server.closeAllConnections();
    log('Control API stopped');
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  handlers: ControlApiHandlers
): Promise<void> {
  try {
    // Browsers can reach a loopback server too. A page the user happens to
    // visit could otherwise POST /run or /playlist (cross-origin 'simple'
    // requests need no preflight) or rebind its DNS name to 127.0.0.1. Agents
    // and curl send neither an Origin header nor a foreign Host.
    if (req.headers.origin !== undefined || !isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'Forbidden: browser/cross-origin requests are not accepted.' });
      return;
    }
    if (token && !isAuthorized(req, token)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const expectedMethod = ENDPOINTS[url.pathname];
    if (!expectedMethod) {
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }
    if (req.method !== expectedMethod) {
      sendJson(res, 405, { error: `Use ${expectedMethod} for ${url.pathname}` });
      return;
    }
    switch (url.pathname) {
      case '/state': {
        sendJson(res, 200, handlers.getState());
        return;
      }
      case '/tests': {
        // Potentially tens of thousands of entries: skip pretty-printing.
        sendJson(res, 200, handlers.getTests(optionalQuery(url, 'solution')), false);
        return;
      }
      case '/log': {
        const raw = url.searchParams.get('lines');
        const parsed = raw === null ? DEFAULT_LOG_LINES : Number.parseInt(raw, 10);
        const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOG_LINES;
        sendJson(res, 200, { lines: handlers.logLines(limit) });
        return;
      }
      case '/run': {
        const body = await readJson(req);
        sendJson(res, 200, await handlers.runTests(body as ControlApiRunOptions));
        return;
      }
      case '/cancel': {
        const body = await readJson(req).catch(() => ({}));
        const options = typeof body.loading === 'boolean' ? { loading: body.loading } : {};
        sendJson(res, 200, handlers.cancelRun(options));
        return;
      }
      case '/playlist': {
        const body = await readJson(req);
        const clear = body.clear === true;
        const playlistPath = clear ? undefined : optionalString(body.path);
        if (!clear && !playlistPath) {
          throw new ControlApiError(400, 'Provide "path" (absolute .playlist path) or "clear": true.');
        }
        sendJson(res, 200, await handlers.setPlaylist(optionalString(body.solution), playlistPath));
        return;
      }
      case '/filter': {
        const body = await readJson(req);
        if (typeof body.text !== 'string') {
          throw new ControlApiError(400, 'Provide "text" (string; empty string clears the filter).');
        }
        handlers.setFilter(body.text);
        sendJson(res, 200, { ok: true });
        return;
      }
      case '/session': {
        const body = await readJson(req);
        const key = optionalString(body.key);
        if (!key) {
          throw new ControlApiError(400, 'Provide "key" (solution key from GET /state).');
        }
        if (!(await handlers.selectSession(key))) {
          throw new ControlApiError(404, `Unknown solution key: ${key}`);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }
  } catch (err) {
    const status = err instanceof ControlApiError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    }
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  // Strip an optional :port (IPv6 literals keep their brackets).
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (typeof header !== 'string') {
    return false;
  }
  // Constant-time comparison (hash both sides so lengths always match).
  const digest = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return readBody(req).then(raw => {
    if (!raw.trim()) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ControlApiError(400, 'Invalid JSON body.');
    }
    // Handlers read named fields; null, arrays and scalars would throw.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ControlApiError(400, 'JSON body must be an object.');
    }
    return parsed;
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ControlApiError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, pretty = true): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, pretty ? 2 : undefined)}\n`);
}
