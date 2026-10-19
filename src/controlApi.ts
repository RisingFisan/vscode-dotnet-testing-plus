import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { log } from './logger';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_LOG_LINES = 200;
const SSE_HEARTBEAT_INTERVAL_MS = 20000;

export class ControlApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export enum HttpMethod {
  Get = 'GET',
  Post = 'POST'
}

export enum ControlApiSseEvent {
  State = 'state',
  TestState = 'testState',
  RunStart = 'runStart',
  RunEnd = 'runEnd'
}

/** A loaded solution within a session, as surfaced to the API. */
export interface ControlApiSolutionSummary {
  /** URL id, unique within the session. */
  id: string;
  /** Canonical solution path (stable identity). */
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
  apiVersion: 2;
  /** URL id of the session (VS Code window) serving this state. */
  sessionId: string;
  activeSolutionKey?: string;
  solutions: ControlApiSolutionSummary[];
  runInProgress: boolean;
  filter: string;
  resultCounts: Record<string, number>;
  notFoundTests: string[];
  runsettings?: { mode: string; path?: string };
}

export interface ControlApiTest {
  solutionPath: string;
  solutionId: string;
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
  /** Restrict an `all` run to one solution (by URL id). */
  solution?: string;
  debug?: boolean;
}

/** One runsettings mutation requested by the web dashboard modal. */
export type ControlApiRunsettingsAction =
  | { action: 'selectFile'; path?: string }
  | { action: 'setValue'; key: string; value: string }
  | { action: 'resetValue'; key: string }
  | { action: 'lockValue'; key: string; isPermanent: boolean }
  | { action: 'addParameter' }
  | { action: 'updateParameter'; id: string; field: 'name' | 'value'; value: string }
  | { action: 'removeParameter'; id: string }
  | { action: 'lockParameter'; id: string; isPermanent: boolean };

export interface ControlApiHandlers {
  getState(): ControlApiState;
  getTests(solutionId: string): { tests: ControlApiTest[] };
  runTests(options: ControlApiRunOptions): Promise<ControlApiRunResult>;
  cancelRun(options: { loading?: boolean }): { cancelled: boolean; cancelledLoading: boolean };
  setPlaylist(solutionId: string, playlistPath: string | undefined): Promise<{ matched: number; notFound: number }>;
  setFilter(text: string): void;
  selectSolution(solutionId: string): Promise<boolean>;
  logLines(limit: number): string[];
  getScreenshot(settings: unknown): unknown;
  getCode(solutionId: string, fqn: string): { fqn: string; file?: string; line?: number; code: string };
  getRunsettings(solutionId: string): Promise<unknown>;
  applyRunsettings(solutionId: string, action: ControlApiRunsettingsAction): Promise<unknown>;
}

/** A loopback-only server that serves one window's session data. Reached by the hub, never directly by browsers. */
export interface LocalApiServer extends vscode.Disposable {
  readonly port: number;
  broadcast(event: ControlApiSseEvent | string, data: unknown): void;
}

export interface LocalApiOptions {
  getSecret: () => string;
  handlers: ControlApiHandlers;
}

/**
 * Starts the per-window data server on an ephemeral loopback port. The hub
 * reverse-proxies to it; it requires the shared internal secret so a stray
 * local process cannot drive tests through it.
 */
export function startLocalApi(options: LocalApiOptions): Promise<LocalApiServer> {
  const sseClients = new Set<http.ServerResponse>();

  const broadcast = (event: ControlApiSseEvent | string, data: unknown): void => {
    if (sseClients.size === 0) {
      return;
    }
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(message);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': heartbeat\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, options.handlers, options.getSecret(), sseClients).catch(() => undefined);
  });

  server.on('error', err => {
    log(`Control API (local) error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return new Promise<LocalApiServer>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        broadcast,
        dispose: () => {
          clearInterval(heartbeatTimer);
          for (const client of sseClients) {
            try {
              client.end();
            } catch {
              // Socket already ended
            }
          }
          sseClients.clear();
          server.close();
          server.closeAllConnections();
        }
      });
    });
  });
}

export interface ApiPath {
  sessionId: string;
  rest: string[];
}

/** Parse `/api/<session>/<rest...>`; returns undefined for any other path. */
export function parseApiPath(pathname: string): ApiPath | undefined {
  const match = /^\/api\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  const rest = match[2] ? match[2].split('/').filter(Boolean) : [];
  return { sessionId: decodeURIComponent(match[1]), rest };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: ControlApiHandlers,
  secret: string,
  sseClients: Set<http.ServerResponse>
): Promise<void> {
  try {
    if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'Forbidden: browser cross-origin requests are not accepted.' });
      return;
    }
    if (!isInternalAuthorized(req, secret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parsed = parseApiPath(url.pathname);
    if (!parsed) {
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }

    await routeLocalRequest(req, res, url, parsed, handlers, sseClients);
  } catch (err) {
    const status = err instanceof ControlApiError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      sendJson(res, status, { error: message });
    }
  }
}

async function routeLocalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  parsed: ApiPath,
  handlers: ControlApiHandlers,
  sseClients: Set<http.ServerResponse>
): Promise<void> {
  const [first, second] = parsed.rest;
  const method = req.method;

  // Session-scoped routes (single segment).
  if (parsed.rest.length === 1) {
    switch (first) {
      case 'state':
        requireMethod(method, HttpMethod.Get, url.pathname);
        sendJson(res, 200, handlers.getState());
        return;
      case 'events':
        requireMethod(method, HttpMethod.Get, url.pathname);
        serveEvents(req, res, handlers, sseClients);
        return;
      case 'log': {
        requireMethod(method, HttpMethod.Get, url.pathname);
        const raw = url.searchParams.get('lines');
        const parsedLines = raw === null ? DEFAULT_LOG_LINES : Number.parseInt(raw, 10);
        const limit = Number.isFinite(parsedLines) && parsedLines > 0 ? parsedLines : DEFAULT_LOG_LINES;
        sendJson(res, 200, { lines: handlers.logLines(limit) });
        return;
      }
      case 'run': {
        requireMethod(method, HttpMethod.Post, url.pathname);
        const body = await readJson(req);
        sendJson(res, 200, await handlers.runTests(body as ControlApiRunOptions));
        return;
      }
      case 'cancel': {
        requireMethod(method, HttpMethod.Post, url.pathname);
        const body = await readJson(req).catch(() => ({}));
        const loading = 'loading' in body && typeof body.loading === 'boolean' ? body.loading : undefined;
        sendJson(res, 200, handlers.cancelRun(loading !== undefined ? { loading } : {}));
        return;
      }
      case 'filter': {
        requireMethod(method, HttpMethod.Post, url.pathname);
        const body = await readJson(req);
        if (typeof body.text !== 'string') {
          throw new ControlApiError(400, 'Provide "text" (string; empty string clears the filter).');
        }
        handlers.setFilter(body.text);
        sendJson(res, 200, { ok: true });
        return;
      }
      case 'screenshot': {
        requireMethod(method, HttpMethod.Post, url.pathname);
        const body = await readJson(req).catch(() => ({}));
        sendJson(res, 200, handlers.getScreenshot(body));
        return;
      }
      default:
        sendJson(res, 404, { error: 'Unknown endpoint' });
        return;
    }
  }

  // Solution-scoped routes (two segments): <solution>/<action>.
  if (parsed.rest.length === 2) {
    const solutionId = decodeURIComponent(first);
    switch (second) {
      case 'tests':
        requireMethod(method, HttpMethod.Get, url.pathname);
        // Potentially tens of thousands of entries: skip pretty-printing.
        sendJson(res, 200, handlers.getTests(solutionId), false);
        return;
      case 'code': {
        requireMethod(method, HttpMethod.Get, url.pathname);
        const fqn = optionalQuery(url, 'fqn');
        if (!fqn) {
          throw new ControlApiError(400, 'Provide "fqn" query parameter.');
        }
        sendJson(res, 200, handlers.getCode(solutionId, fqn));
        return;
      }
      case 'playlist': {
        requireMethod(method, HttpMethod.Post, url.pathname);
        const body = await readJson(req);
        const clear = body.clear === true;
        const playlistPath = clear ? undefined : optionalString(body.path);
        if (!clear && !playlistPath) {
          throw new ControlApiError(400, 'Provide "path" (absolute .playlist path) or "clear": true.');
        }
        sendJson(res, 200, await handlers.setPlaylist(solutionId, playlistPath));
        return;
      }
      case 'select':
        requireMethod(method, HttpMethod.Post, url.pathname);
        if (!(await handlers.selectSolution(solutionId))) {
          throw new ControlApiError(404, `Unknown solution: ${solutionId}`);
        }
        sendJson(res, 200, { ok: true });
        return;
      case 'runsettings': {
        if (method === HttpMethod.Get) {
          sendJson(res, 200, await handlers.getRunsettings(solutionId));
          return;
        }
        if (method === HttpMethod.Post) {
          const body = await readJson(req);
          const action = parseRunsettingsAction(body);
          sendJson(res, 200, await handlers.applyRunsettings(solutionId, action));
          return;
        }
        throw new ControlApiError(405, `Use GET or POST for ${url.pathname}`);
      }
      default:
        sendJson(res, 404, { error: 'Unknown endpoint' });
        return;
    }
  }

  sendJson(res, 404, { error: 'Unknown endpoint' });
}

function serveEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: ControlApiHandlers,
  sseClients: Set<http.ServerResponse>
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  res.write(`event: ${ControlApiSseEvent.State}\ndata: ${JSON.stringify(handlers.getState())}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
}

function parseRunsettingsAction(body: Record<string, unknown>): ControlApiRunsettingsAction {
  const action = optionalString(body.action);
  switch (action) {
    case 'selectFile':
      return { action: 'selectFile', path: optionalString(body.path) };
    case 'setValue':
      return { action: 'setValue', key: requiredString(body.key, 'key'), value: typeof body.value === 'string' ? body.value : '' };
    case 'resetValue':
      return { action: 'resetValue', key: requiredString(body.key, 'key') };
    case 'lockValue':
      return { action: 'lockValue', key: requiredString(body.key, 'key'), isPermanent: body.isPermanent === true };
    case 'addParameter':
      return { action: 'addParameter' };
    case 'updateParameter':
      return {
        action: 'updateParameter',
        id: requiredString(body.id, 'id'),
        field: body.field === 'name' ? 'name' : 'value',
        value: typeof body.value === 'string' ? body.value : ''
      };
    case 'removeParameter':
      return { action: 'removeParameter', id: requiredString(body.id, 'id') };
    case 'lockParameter':
      return { action: 'lockParameter', id: requiredString(body.id, 'id'), isPermanent: body.isPermanent === true };
    default:
      throw new ControlApiError(400, `Unknown runsettings action: ${action ?? '(missing)'}`);
  }
}

function requireMethod(method: string | undefined, expected: HttpMethod, pathname: string): void {
  if (method !== expected) {
    throw new ControlApiError(405, `Use ${expected} for ${pathname}`);
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  // Strip an optional :port (IPv6 literals keep their brackets).
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

export function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (originHeader === undefined) {
    // Agents, curl, or standard navigation
    return true;
  }
  try {
    const parsed = new URL(originHeader);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isInternalAuthorized(req: http.IncomingMessage, secret: string): boolean {
  const header = req.headers['x-internal-secret'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return false;
  }
  const digest = (input: string): Buffer => crypto.createHash('sha256').update(input).digest();
  return crypto.timingSafeEqual(digest(value), digest(secret));
}

export function timingSafeEquals(a: string, b: string): boolean {
  const digest = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (parsed === undefined) {
    throw new ControlApiError(400, `Provide "${field}" (string).`);
  }
  return parsed;
}

export function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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
    return parsed as Record<string, unknown>;
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

export function sendJson(res: http.ServerResponse, status: number, payload: unknown, pretty = true): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, pretty ? 2 : undefined)}\n`);
}

export function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
