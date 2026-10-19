import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { assignUniqueId } from './apiIds';
import {
  ControlApiSolutionSummary,
  isAllowedOrigin,
  isLoopbackHost,
  parseApiPath,
  readJson,
  sendHtml,
  sendJson,
  timingSafeEquals
} from './controlApi';
import { log } from './logger';

const PEER_HEARTBEAT_INTERVAL_MS = 5000;
const PEER_TTL_MS = 16000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Human-readable reference for the control API. `main` ships the API without
 * the browser dashboard, so the webview links here instead.
 */
function apiCommandsPage(sessions: HubSession[]): string {
  const rows: Array<[string, string, string]> = [
    ['GET', '/api/sessions', 'Open sessions and their solutions'],
    ['GET', '/api/<session>/state', 'Solutions, active solution and run state'],
    ['GET', '/api/<session>/events', 'Server-Sent Events: state, testState, runStart, runEnd'],
    ['GET', '/api/<session>/log?lines=200', 'Recent extension log lines'],
    ['POST', '/api/<session>/run', 'Run tests: {"fqns":[...]} or {"all":true}'],
    ['POST', '/api/<session>/cancel', 'Cancel the active run or discovery'],
    ['POST', '/api/<session>/filter', 'Set the VS Code text filter'],
    ['POST', '/api/<session>/screenshot', 'Screenshot snapshot for explicit fqns'],
    ['GET', '/api/<session>/<solution>/tests', 'All discovered tests and their states'],
    ['GET', '/api/<session>/<solution>/code?fqn=...', 'Source of a test method'],
    ['POST', '/api/<session>/<solution>/playlist', 'Select or clear a .playlist'],
    ['POST', '/api/<session>/<solution>/select', 'Switch the active solution'],
    ['GET', '/api/<session>/<solution>/runsettings', 'Read the runsettings state'],
    ['POST', '/api/<session>/<solution>/runsettings', 'Apply one runsettings change']
  ];
  const table = rows
    .map(([method, endpoint, purpose]) =>
      `<tr><td><code>${method}</code></td><td><code>${escapeHtml(endpoint)}</code></td><td>${purpose}</td></tr>`)
    .join('\n');
  const sessionItems = sessions.length === 0
    ? '<li class="muted">No session currently has the API enabled.</li>'
    : sessions.map(session => {
        const solutions = session.solutions.length === 0
          ? '<span class="muted">no solutions loaded</span>'
          : session.solutions.map(solution => `<code>${escapeHtml(solution.id)}</code>`).join(', ');
        return `<li><code>${escapeHtml(session.id)}</code> — solutions: ${solutions}</li>`;
      }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>.NET Testing+ — API</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 32px; background: #0d1117; color: #c9d1d9; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    h2 { font-size: 14px; margin: 26px 0 8px; }
    p { color: #8b949e; margin: 0 0 18px; max-width: 980px; }
    table { border-collapse: collapse; width: 100%; max-width: 980px; font-size: 13px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #30363d; vertical-align: top; }
    th { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #58a6ff; }
    ul { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; }
    .muted { color: #8b949e; }
  </style>
</head>
<body>
  <h1>.NET Testing+ control API</h1>
  <p>Every non-UI request uses the <code>/api</code> prefix. Replace <code>&lt;session&gt;</code> and <code>&lt;solution&gt;</code> with the ids listed below. When a token is configured, send <code>Authorization: Bearer &lt;token&gt;</code>.</p>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
    <tbody>
${table}
    </tbody>
  </table>
  <h2>Open sessions</h2>
  <ul>
${sessionItems}
  </ul>
</body>
</html>`;
}

export interface ApiRegistryEntry {
  pid: number;
  port: number;
  secret: string;
}

export function registryPath(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'api-registry.json');
}

export function readRegistry(globalStorageDir: string): ApiRegistryEntry | undefined {
  try {
    const raw = fs.readFileSync(registryPath(globalStorageDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ApiRegistryEntry>;
    if (typeof parsed.port === 'number' && parsed.port > 0 && typeof parsed.secret === 'string' && typeof parsed.pid === 'number') {
      return { pid: parsed.pid, port: parsed.port, secret: parsed.secret };
    }
  } catch {
    // Missing or corrupt registry: treated as "no hub".
  }
  return undefined;
}

export function writeRegistry(globalStorageDir: string, entry: ApiRegistryEntry): void {
  fs.mkdirSync(globalStorageDir, { recursive: true });
  fs.writeFileSync(registryPath(globalStorageDir), JSON.stringify(entry, null, 2), 'utf8');
}

export function removeRegistry(globalStorageDir: string, pid: number): void {
  const current = readRegistry(globalStorageDir);
  if (current?.pid === pid) {
    try {
      fs.rmSync(registryPath(globalStorageDir), { force: true });
    } catch {
      // Best effort: a stale file is harmless because liveness is probed.
    }
  }
}

/** Probe a hub's unauthenticated liveness endpoint. Never throws. */
export async function pingHub(port: number, timeoutMs = 1000): Promise<{ app: string; pid: number } | undefined> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/internal/ping', method: 'GET', timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { app?: string; pid?: number };
          resolve(parsed.app === 'dotnet-testing-plus' ? { app: parsed.app, pid: parsed.pid ?? -1 } : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

interface Peer {
  pid: number;
  sessionId: string;
  label: string;
  localPort: number;
  solutions: ControlApiSolutionSummary[];
  lastSeen: number;
}

export interface HubOptions {
  /** Desired public port (0 = OS-assigned). */
  port: number;
  token: string;
  secret: string;
  /** This window's own local data server port. */
  selfLocalPort: number;
  /** This window's proposed session id (before uniqueness suffixing). */
  selfBaseId: string;
  /** Human-readable label for this window. */
  selfLabel: string;
  onSelfSessionId: (sessionId: string) => void;
}

export interface HubServer extends vscode.Disposable {
  readonly port: number;
  readonly sessionId: string;
  /** Refresh this window's own entry (solutions change over time). */
  updateSelf(solutions: ControlApiSolutionSummary[]): void;
  dispose(): void;
}

interface HubSession {
  id: string;
  label: string;
  solutions: ControlApiSolutionSummary[];
}

/**
 * The shared public server. It owns no test state of its own: it keeps a
 * registry of peer windows, serves the HTML shell, and reverse-proxies
 * `/api/<session>/...` to the owning window's loopback data server. Exactly one
 * window holds it (elected via the bind), so every window shares one API.
 */
export function startHub(options: HubOptions): Promise<HubServer> {
  const peers = new Map<number, Peer>();
  let selfSessionId = '';

  const sessionsList = (): HubSession[] =>
    [...peers.values()]
      .map(peer => ({ id: peer.sessionId, label: peer.label, solutions: peer.solutions }))
      .sort((a, b) => a.id.localeCompare(b.id));

  const server = http.createServer((req, res) => {
    void handleHubRequest(req, res, {
      options,
      peers,
      sessionsList,
      assignId
    }).catch(() => undefined);
  });

  server.on('error', err => {
    log(`Control API (hub) error: ${err instanceof Error ? err.message : String(err)}`);
  });

  const evict = setInterval(() => {
    const now = Date.now();
    for (const [pid, peer] of peers) {
      if (pid !== process.pid && now - peer.lastSeen > PEER_TTL_MS) {
        peers.delete(pid);
      }
    }
  }, PEER_HEARTBEAT_INTERVAL_MS);

  function assignId(baseId: string, pid: number): string {
    const taken = new Set([...peers.values()].map(peer => peer.sessionId));
    const existing = peers.get(pid);
    if (existing) {
      taken.delete(existing.sessionId);
    }
    return assignUniqueId(baseId, taken, new Set(['api', 'internal', 'sessions', 'index.html', 'favicon.ico']));
  }

  return new Promise<HubServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      // Register this window itself so the hub's own session is served like any peer.
      selfSessionId = assignId(options.selfBaseId, process.pid);
      peers.set(process.pid, {
        pid: process.pid,
        sessionId: selfSessionId,
        label: options.selfLabel,
        localPort: options.selfLocalPort,
        solutions: [],
        lastSeen: Date.now()
      });
      options.onSelfSessionId(selfSessionId);
      log(`Control API hub listening on http://127.0.0.1:${port} (session ${selfSessionId})`);

      resolve({
        port,
        get sessionId() {
          return selfSessionId;
        },
        updateSelf: solutions => {
          const peer = peers.get(process.pid);
          if (peer) {
            peer.solutions = solutions;
            peer.lastSeen = Date.now();
          }
        },
        dispose: () => {
          clearInterval(evict);
          server.close();
          server.closeAllConnections();
          log('Control API hub stopped');
        }
      });
    });
  });
}

interface HubRequestContext {
  options: HubOptions;
  peers: Map<number, Peer>;
  sessionsList: () => HubSession[];
  assignId: (baseId: string, pid: number) => string;
}

async function handleHubRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: HubRequestContext): Promise<void> {
  try {
    if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'Forbidden: browser cross-origin requests are not accepted.' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/api/internal/ping' && req.method === 'GET') {
      sendJson(res, 200, { app: 'dotnet-testing-plus', pid: process.pid });
      return;
    }
    if (pathname === '/api/internal/register' && req.method === 'POST') {
      await handleRegister(req, res, ctx);
      return;
    }

    // Human-readable command reference, linked from the VS Code webview.
    if ((pathname === '/api' || pathname === '/api/') && req.method === 'GET') {
      sendHtml(res, 200, apiCommandsPage(ctx.sessionsList()));
      return;
    }

    const api = parseApiPath(pathname);
    if (api) {
      if (!isAuthorized(req, ctx.options.token, url)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (api.sessionId === 'sessions' && api.rest.length === 0) {
        sendJson(res, 200, { apiVersion: 2, sessions: ctx.sessionsList() });
        return;
      }
      proxyToPeer(req, res, api.sessionId, ctx);
      return;
    }

    // This build ships the API only; the browser dashboard lives on the
    // `feat/web-ui` branch. Serve the command reference for the root and old
    // session links so no link looks like a broken server.
    if ((pathname === '/' || pathname === '/index.html' || /^\/[^/]+\/?$/.test(pathname)) && req.method === 'GET') {
      sendHtml(res, 200, apiCommandsPage(ctx.sessionsList()));
      return;
    }

    sendJson(res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, err instanceof Error && 'status' in err ? (err as { status: number }).status : 500, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

async function handleRegister(req: http.IncomingMessage, res: http.ServerResponse, ctx: HubRequestContext): Promise<void> {
  const header = req.headers['x-internal-secret'];
  const secret = Array.isArray(header) ? header[0] : header;
  if (!secret || !timingSafeEquals(secret, ctx.options.secret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  const body = await readJson(req);
  const pid = typeof body.pid === 'number' ? body.pid : undefined;
  const localPort = typeof body.localPort === 'number' ? body.localPort : undefined;
  const baseId = typeof body.baseId === 'string' ? body.baseId : undefined;
  if (!pid || !localPort || !baseId) {
    sendJson(res, 400, { error: 'Provide "pid", "localPort" and "baseId".' });
    return;
  }
  const label = typeof body.label === 'string' ? body.label : baseId;
  const solutions = Array.isArray(body.solutions) ? (body.solutions as ControlApiSolutionSummary[]) : [];
  const sessionId = ctx.assignId(baseId, pid);
  ctx.peers.set(pid, { pid, sessionId, label, localPort, solutions, lastSeen: Date.now() });
  sendJson(res, 200, { sessionId });
}

function isAuthorized(req: http.IncomingMessage, token: string, url: URL): boolean {
  if (!token) {
    return true;
  }
  const header = req.headers.authorization ?? '';
  if (header.length > 0) {
    return timingSafeEquals(header, `Bearer ${token}`);
  }
  // EventSource cannot set headers, so allow ?token= for the stream.
  const queryToken = url.searchParams.get('token');
  return queryToken !== null && timingSafeEquals(queryToken, token);
}

function proxyToPeer(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, ctx: HubRequestContext): void {
  const peer = [...ctx.peers.values()].find(item => item.sessionId === sessionId);
  if (!peer) {
    sendJson(res, 404, { error: `Unknown session: ${sessionId}` });
    return;
  }
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: peer.localPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${peer.localPort}`, 'x-internal-secret': ctx.options.secret }
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: `Session ${sessionId} is not responding.` });
    }
  });
  // A closed browser tab must not leave the upstream connection dangling (SSE).
  res.on('close', () => proxyReq.destroy());
  req.pipe(proxyReq);
}
