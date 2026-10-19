import * as crypto from 'crypto';
import * as http from 'http';
import { ControlApiSolutionSummary, ControlApiSseEvent, ControlApiHandlers, LocalApiServer, startLocalApi } from './controlApi';
import { HubServer, pingHub, readRegistry, removeRegistry, startHub, writeRegistry } from './apiHub';
import { log } from './logger';

const HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_PORT = 48265;

export type ApiRole = 'off' | 'host' | 'peer' | 'error';

export interface ApiRuntimeState {
  enabled: boolean;
  role: ApiRole;
  sessionId?: string;
  port?: number;
  message?: string;
}

export interface ApiCoordinatorDeps {
  globalStorageDir: string;
  handlers: ControlApiHandlers;
  getPort: () => number;
  getToken: () => string;
  getSessionBase: () => { baseId: string; label: string };
  getSolutions: () => ControlApiSolutionSummary[];
  onStateChange: () => void;
}

/**
 * Owns the election that lets every VS Code window share one API. Each window
 * runs a local data server; the elected host additionally runs the public hub
 * that proxies to everyone. If the host window goes away, a peer takes over and
 * rebinds the same port, so open dashboards reconnect seamlessly.
 */
export class ApiCoordinator {
  private local: LocalApiServer | undefined;
  private hub: HubServer | undefined;
  private secret = crypto.randomBytes(24).toString('hex');
  private hubPort: number | undefined;
  private sessionId: string | undefined;
  private role: ApiRole = 'off';
  private message: string | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  /** Bumped by every start()/stop(); stale async continuations bail out on mismatch. */
  private generation = 0;
  /** Last hub bind failure message, surfaced in the webview when nothing can host. */
  private hubError: string | undefined;

  constructor(private readonly deps: ApiCoordinatorDeps) {}

  get state(): ApiRuntimeState {
    return {
      enabled: this.role === 'host' || this.role === 'peer',
      role: this.role,
      sessionId: this.sessionId,
      port: this.hubPort,
      message: this.message
    };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async start(): Promise<void> {
    const gen = ++this.generation;
    const local = await startLocalApi({ getSecret: () => this.secret, handlers: this.deps.handlers });
    if (gen !== this.generation) {
      local.dispose();
      return;
    }
    this.local = local;
    await this.elect(gen);
    if (gen !== this.generation) {
      return;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.heartbeat = setInterval(() => void this.tick(this.generation), HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    this.generation++;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.hub?.dispose();
    this.hub = undefined;
    this.local?.dispose();
    this.local = undefined;
    removeRegistry(this.deps.globalStorageDir, process.pid);
    this.role = 'off';
    this.sessionId = undefined;
    this.hubPort = undefined;
    this.message = undefined;
  }

  broadcast(event: ControlApiSseEvent | string, data: unknown): void {
    this.local?.broadcast(event, data);
  }

  /** Push the current solution list to the hub (host) or re-register (peer). */
  refreshSolutions(): void {
    if (this.hub) {
      this.hub.updateSelf(this.deps.getSolutions());
      return;
    }
    if (this.role === 'peer') {
      void this.registerWithHub(this.generation);
    }
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  private async elect(gen: number): Promise<void> {
    const registry = readRegistry(this.deps.globalStorageDir);
    if (registry && registry.pid !== process.pid) {
      if (await pingHub(registry.port)) {
        if (this.isCurrent(gen)) {
          await this.becomePeer(gen, registry.port, registry.secret);
        }
        return;
      }
      removeRegistry(this.deps.globalStorageDir, registry.pid);
    }

    const desired = this.deps.getPort() > 0 ? this.deps.getPort() : DEFAULT_PORT;
    if (await this.startHubAsHost(gen, desired) === 'host') {
      this.deps.onStateChange();
      return;
    }
    if (!this.isCurrent(gen)) {
      return;
    }
    // Binding the configured port failed. If another window just won the race,
    // join it; otherwise fall back to an OS-assigned port so a port reserved by
    // the environment (e.g. WSL2 mirrored-mode blocks) cannot wedge the API.
    const winner = await this.waitForRegistry(gen);
    if (!this.isCurrent(gen)) {
      return;
    }
    if (winner) {
      await this.becomePeer(gen, winner.port, winner.secret);
      return;
    }
    if (await this.startHubAsHost(gen, 0) === 'host') {
      log(`Control API: could not bind port ${desired}; serving the shared API on an OS-assigned port instead.`);
      this.deps.onStateChange();
      return;
    }
    if (!this.isCurrent(gen)) {
      return;
    }
    this.role = 'error';
    this.message = `Could not start the API hub on port ${desired}. ${this.hubError ?? ''}`.trim();
    log(this.message);
    this.deps.onStateChange();
  }

  private async startHubAsHost(gen: number, port: number): Promise<'host' | 'error' | 'stale'> {
    const secret = crypto.randomBytes(24).toString('hex');
    let hub: HubServer;
    try {
      hub = await startHub({
        port,
        token: this.deps.getToken(),
        secret,
        selfLocalPort: this.local?.port ?? 0,
        selfBaseId: this.deps.getSessionBase().baseId,
        selfLabel: this.deps.getSessionBase().label,
        onSelfSessionId: id => {
          if (this.isCurrent(gen)) {
            this.sessionId = id;
            this.hub?.updateSelf(this.deps.getSolutions());
          }
        }
      });
    } catch (err) {
      this.hubError = err instanceof Error ? err.message : String(err);
      return 'error';
    }
    if (!this.isCurrent(gen)) {
      hub.dispose();
      return 'stale';
    }
    this.secret = secret;
    this.hub = hub;
    this.hubPort = hub.port;
    this.role = 'host';
    this.message = undefined;
    this.hubError = undefined;
    writeRegistry(this.deps.globalStorageDir, { pid: process.pid, port: hub.port, secret });
    return 'host';
  }

  private async waitForRegistry(gen: number): Promise<{ port: number; secret: string } | undefined> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await delay(200);
      if (!this.isCurrent(gen)) {
        return undefined;
      }
      const registry = readRegistry(this.deps.globalStorageDir);
      if (registry && registry.pid !== process.pid && (await pingHub(registry.port))) {
        return registry;
      }
    }
    return undefined;
  }

  private async becomePeer(gen: number, port: number, secret: string): Promise<void> {
    this.secret = secret;
    this.hubPort = port;
    this.role = 'peer';
    this.message = undefined;
    const ok = await this.registerWithHub(gen);
    if (!this.isCurrent(gen)) {
      return;
    }
    if (!ok) {
      // Registry was live a moment ago but registration failed: fall back to electing.
      await this.elect(gen);
      return;
    }
    this.deps.onStateChange();
  }

  private async registerWithHub(gen: number): Promise<boolean> {
    if (this.hubPort === undefined || this.local === undefined) {
      return false;
    }
    const { baseId, label } = this.deps.getSessionBase();
    const body = JSON.stringify({ pid: process.pid, baseId, label, localPort: this.local.port, solutions: this.deps.getSolutions() });
    const response = await new Promise<{ sessionId?: string } | undefined>(resolve => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.hubPort,
          path: '/api/internal/register',
          method: 'POST',
          timeout: 2000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-internal-secret': this.secret }
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              resolve(undefined);
            }
          });
        }
      );
      req.on('error', () => resolve(undefined));
      req.on('timeout', () => {
        req.destroy();
        resolve(undefined);
      });
      req.end(body);
    });
    if (!response?.sessionId) {
      return false;
    }
    if (!this.isCurrent(gen)) {
      return true;
    }
    this.sessionId = response.sessionId;
    return true;
  }

  private async tick(gen: number): Promise<void> {
    if (gen !== this.generation || this.role !== 'peer' || this.hubPort === undefined) {
      return;
    }
    const ok = await this.registerWithHub(gen);
    if (gen !== this.generation) {
      return;
    }
    if (ok) {
      this.deps.onStateChange();
      return;
    }
    if (!(await pingHub(this.hubPort))) {
      if (gen !== this.generation) {
        return;
      }
      // Host is gone: drop into election so exactly one peer takes over.
      this.hubPort = undefined;
      this.sessionId = undefined;
      this.role = 'off';
      await this.elect(gen);
      if (gen === this.generation) {
        this.deps.onStateChange();
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
