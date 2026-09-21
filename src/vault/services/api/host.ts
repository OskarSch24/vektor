import { callHost, hasChannel } from '../rpc';
import { registerApiAdapter } from '../../../services/api/dispatcher';
import {
  publishSharedApiStatus,
  subscribeSharedApiStatus,
  type SharedApiHostStatus,
} from '../../../services/api/sharedStatus';
import { health, route, setConnection, type ApiCall, type RouterContext } from './routes';

/**
 * The renderer half of the local API.
 *
 * The Swift host owns the socket; this module owns the answers. Every request
 * arrives as `window.vaultStudio.__apiRequest(id, base64Json)`, is resolved
 * against the open connection, and goes back out through the `apiControl`
 * channel — the same round trip the Redis transport uses, so there is one
 * request/response mechanism in the app rather than two.
 *
 * It also keeps the log the API tab renders: a call from another tool shows up
 * in the window as it happens, with what it asked for and what it cost.
 */

export interface ApiLogEntry {
  id: number;
  at: number;
  method: string;
  path: string;
  query: Record<string, string>;
  /** The command, for a POST /command — so the log says what actually ran. */
  summary: string;
  status: number;
  durationMs: number;
  count: number | null;
  error?: string;
}

export interface ApiServerStatus {
  /** False in a plain browser — there is no socket to open without the host. */
  available: boolean;
  running: boolean;
  port: number;
  token: string;
  descriptorPath: string;
  allowWrites: boolean;
  error?: string;
}

const MAX_LOG_ENTRIES = 200;

let log: ApiLogEntry[] = [];
let nextLogId = 1;
const logListeners = new Set<(entries: ApiLogEntry[]) => void>();

let status: ApiServerStatus = {
  available: false,
  running: false,
  port: 0,
  token: '',
  descriptorPath: '',
  allowWrites: false,
};
const statusListeners = new Set<(next: ApiServerStatus) => void>();
let onDataChanged: RouterContext['onDataChanged'];

export function subscribeToLog(listener: (entries: ApiLogEntry[]) => void): () => void {
  logListeners.add(listener);
  listener(log);
  return () => logListeners.delete(listener);
}

export function subscribeToStatus(listener: (next: ApiServerStatus) => void): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

export function clearLog(): void {
  log = [];
  logListeners.forEach((listener) => listener(log));
}

function pushLog(entry: ApiLogEntry): void {
  log = [entry, ...log].slice(0, MAX_LOG_ENTRIES);
  logListeners.forEach((listener) => listener(log));
}

function setStatus(next: Partial<ApiServerStatus>): void {
  status = { ...status, ...next };
  statusListeners.forEach((listener) => listener(status));
}

export function getStatus(): ApiServerStatus {
  return status;
}

type HostStatus = SharedApiHostStatus;

async function control(action: string, payload: Record<string, unknown> = {}): Promise<void> {
  try {
    const next = await callHost<HostStatus>('apiControl', action, payload, 15_000);
    publishSharedApiStatus(next);
  } catch (err: any) {
    setStatus({ error: err?.message || String(err) });
  }
}

subscribeSharedApiStatus((next) => {
  setStatus({
    ...next,
    allowWrites: next.allowWritesByAdapter?.vault ?? next.allowWrites,
    available: true,
    error: undefined,
  });
  if (next.running) pushHealth();
});

export const apiServer = {
  refresh: () => control('status'),
  start: (port?: number) => control('start', port ? { port } : {}),
  stop: () => control('stop'),
  setPort: (port: number) => control('start', { port }),
  rotateToken: () => control('rotateToken'),
  setAllowWrites: (allowWrites: boolean) => control('setAllowWrites', { adapter: 'vault', allowWrites }),
};

/**
 * Hands the host a summary it can answer `/health` with directly. Without it a
 * health probe would have to wait behind whatever the renderer is doing, which
 * is exactly the situation a health probe exists to detect.
 */
function pushHealth(): void {
  if (!hasChannel('apiControl')) return;
  callHost('apiControl', 'health', { adapter: 'vault', health: health() }, 5_000).catch(() => {
    /* A stale snapshot is not worth surfacing to the user. */
  });
}

/** Called by App.tsx whenever the open connection changes. */
export { setConnection };

export function setDataChangedHandler(handler: RouterContext['onDataChanged']): void {
  onDataChanged = handler;
}

export function reportConnectionChanged(): void {
  pushHealth();
}

function decode(encoded: string): ApiCall {
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
  );
  const raw = JSON.parse(json) as {
    method: string;
    path: string;
    publicPath?: string;
    query?: Record<string, string>;
    body?: string;
  };

  let body: unknown = null;
  if (raw.body) {
    try {
      body = JSON.parse(raw.body);
    } catch {
      // Left as null on purpose: a route that needs a field will say which one
      // is missing, which is a better error than "invalid JSON" with no context.
      body = null;
    }
  }

  return { method: raw.method, path: raw.path, publicPath: raw.publicPath, query: raw.query ?? {}, body };
}

function summarise(call: ApiCall): string {
  const args = (call.body as { args?: string[] } | null)?.args;
  if (Array.isArray(args)) return args.join(' ').slice(0, 160);
  return call.query.match || call.query.space || '';
}

function countOf(payload: unknown): number | null {
  const record = payload as Record<string, unknown> | null;
  if (!record) return null;
  if (typeof record.count === 'number') return record.count;
  if (Array.isArray(record.keys)) return record.keys.length;
  if (Array.isArray(record.children)) return record.children.length;
  if (Array.isArray(record.edges)) return record.edges.length;
  return null;
}

/**
 * Installs the entry point the Swift host calls. Returns a teardown function so
 * a hot reload during development does not leave two handlers behind.
 */
export function installApiHandler(): () => void {
  const handler = (requestId: number, encodedCall: string) => {
    const startedAt = performance.now();
    let call: ApiCall;

    try {
      call = decode(encodedCall);
    } catch (err: any) {
      void callHost('apiControl', 'reply', {
        callId: requestId,
        status: 400,
        json: JSON.stringify({ error: `Anfrage nicht lesbar: ${err?.message || err}` }),
      }).catch(() => undefined);
      return;
    }

    void route(call, { allowWrites: status.allowWrites, onDataChanged })
      .catch((err) => ({ status: 500, payload: { error: err?.message || String(err) } }))
      .then((reply) => {
        const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
        const errorText = (reply.payload as { error?: string } | null)?.error;

        pushLog({
          id: nextLogId++,
          at: Date.now(),
          method: call.method,
          path: call.publicPath ?? call.path,
          query: call.query,
          summary: summarise(call),
          status: reply.status,
          durationMs,
          count: countOf(reply.payload),
          error: reply.status >= 400 ? errorText : undefined,
        });

        return callHost('apiControl', 'reply', {
          callId: requestId,
          status: reply.status,
          json: JSON.stringify(reply.payload),
        }).catch(() => undefined);
      });
  };

  const unregister = registerApiAdapter('vault', handler);

  setStatus({ available: hasChannel('apiControl') });
  if (status.available) void apiServer.refresh();

  return unregister;
}
