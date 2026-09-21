import { ingestServer, isNativeHost, type ServerStatus } from './nativeHost';

export type BrowserExtensionConnectionState =
  | 'checking'
  | 'connected'
  | 'listening'
  | 'conflict'
  | 'offline'
  | 'browser';

export interface IngestPeer {
  reachable: boolean;
  app?: string;
  version?: string;
  compatible: boolean;
}

export interface BrowserExtensionConnection {
  state: BrowserExtensionConnectionState;
  running: boolean;
  port: number;
  endpoint: string;
  clients: string[];
  lastSeenAt: string | null;
  lastIngestAt: string | null;
  requestCount: number;
  peer: IngestPeer | null;
  error: string | null;
}

const DEFAULT_PORT = 8787;
const PROBE_TIMEOUT_MS = 900;
const EXTENSION_ACTIVITY_WINDOW_MS = 15_000;

export const initialBrowserExtensionConnection: BrowserExtensionConnection = {
  state: 'checking',
  running: false,
  port: DEFAULT_PORT,
  endpoint: `http://127.0.0.1:${DEFAULT_PORT}`,
  clients: [],
  lastSeenAt: null,
  lastIngestAt: null,
  requestCount: 0,
  peer: null,
  error: null,
};

/**
 * Reads listener state from the native host. If the desired port is occupied,
 * a read-only status probe identifies the owner; it never sends an ingest and
 * never mutates either app.
 */
export async function readBrowserExtensionConnection(): Promise<BrowserExtensionConnection> {
  if (!isNativeHost()) {
    return { ...initialBrowserExtensionConnection, state: 'browser' };
  }

  try {
    const status = await ingestServer.status();
    const port = validPort(status.port) ? status.port : DEFAULT_PORT;
    const base = fromNativeStatus(status, port);

    if (status.running) {
      return {
        ...base,
        state: extensionWasSeen(status) ? 'connected' : 'listening',
      };
    }

    const peer = await probePeer(port);
    return {
      ...base,
      state: peer?.reachable ? 'conflict' : 'offline',
      peer,
    };
  } catch (error) {
    return {
      ...initialBrowserExtensionConnection,
      state: 'offline',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function extensionWasSeen(status: Pick<ServerStatus, 'clients' | 'lastSeenAt'>): boolean {
  if (status.clients.length === 0 || !status.lastSeenAt) return false;
  const lastSeenAt = Date.parse(status.lastSeenAt);
  if (!Number.isFinite(lastSeenAt)) return false;
  const age = Date.now() - lastSeenAt;
  return age >= 0 && age <= EXTENSION_ACTIVITY_WINDOW_MS;
}

function fromNativeStatus(status: ServerStatus, port: number): BrowserExtensionConnection {
  return {
    state: 'checking',
    running: status.running,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    clients: Array.isArray(status.clients) ? status.clients : [],
    lastSeenAt: status.lastSeenAt ?? null,
    lastIngestAt: status.lastIngestAt ?? null,
    requestCount: status.requestCount ?? 0,
    peer: null,
    error: status.error ?? null,
  };
}

async function probePeer(port: number): Promise<IngestPeer | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { reachable: true, compatible: false };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      reachable: true,
      app: typeof payload.app === 'string' ? payload.app : undefined,
      version: typeof payload.version === 'string' ? payload.version : undefined,
      compatible: payload.ok === true && typeof payload.app === 'string',
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65_535;
}
