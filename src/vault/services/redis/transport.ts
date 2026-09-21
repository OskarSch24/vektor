import { callHost, hasChannel } from '../rpc';
import type { WireValue } from './wire';

/**
 * Where the socket lives.
 *
 * In the packaged app the Swift host owns the connection and this is a bridge
 * hop. Under `npm run dev` the browser cannot open a socket at all, so the Vite
 * plugin in dev/redisBridge.ts holds it and this is a fetch. Both answer the
 * same four operations with the same `WireValue`, so nothing above this file
 * knows which one it is talking to — the app in the browser is the app in the
 * window, against the same real server.
 */

export interface ConnectConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  timeoutMs?: number;
  /** Snapshot sessions are disposable working copies and can never be unlocked. */
  immutable?: boolean;
  /** Friendly name shown instead of a loopback address for project snapshots. */
  displayName?: string;
  /** Restricts the picker for restored snapshots to areas that actually contain keys. */
  availableDatabases?: number[];
}

export interface ConnectResult {
  connectionId: string;
  host: string;
  port: number;
  db: number;
}

export interface Transport {
  readonly kind: 'native' | 'dev';
  connect(config: ConnectConfig): Promise<ConnectResult>;
  command(connectionId: string, args: string[]): Promise<WireValue>;
  /** One round trip for many commands — the keyspace browser lives on this. */
  pipeline(connectionId: string, commands: string[][]): Promise<WireValue[]>;
  close(connectionId: string): Promise<void>;
}

const nativeTransport: Transport = {
  kind: 'native',
  async connect(config) {
    return callHost<ConnectResult>('redis', 'connect', { ...config }, 30_000);
  },
  async command(connectionId, args) {
    const { value } = await callHost<{ value: WireValue }>('redis', 'command', { connectionId, args });
    return value;
  },
  async pipeline(connectionId, commands) {
    const { values } = await callHost<{ values: WireValue[] }>('redis', 'pipeline', {
      connectionId,
      commands,
    });
    return values;
  },
  async close(connectionId) {
    await callHost('redis', 'close', { connectionId }, 5_000);
  },
};

async function post<T>(action: string, body: unknown): Promise<T> {
  const response = await fetch(`/__vault/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Die Entwicklungs-Brücke antwortete mit HTTP ${response.status}.`);
  }
  return payload as T;
}

const devTransport: Transport = {
  kind: 'dev',
  async connect(config) {
    const { connectionId } = await post<{ connectionId: string }>('connect', config);
    return { connectionId, host: config.host, port: config.port, db: config.db ?? 0 };
  },
  async command(connectionId, args) {
    const { value } = await post<{ value: WireValue }>('command', { connectionId, args });
    return value;
  },
  async pipeline(connectionId, commands) {
    // The bridge has no batch endpoint on purpose: it exists for development,
    // where the extra round trips are local and the simpler surface is worth
    // more than the microseconds. Ordering still holds — the bridge serialises
    // per connection, and these are awaited one after another.
    const values: WireValue[] = [];
    for (const args of commands) {
      values.push(await devTransport.command(connectionId, args));
    }
    return values;
  },
  async close(connectionId) {
    await post('close', { connectionId });
  },
};

export function activeTransport(): Transport {
  return hasChannel('redis') ? nativeTransport : devTransport;
}

/** True in the packaged app, false in a browser. Shown in the connection bar. */
export function isNativeHost(): boolean {
  return hasChannel('redis');
}

/** Starts Database Studio's loopback-only, durable Redis service when necessary. */
export const localStore = {
  available: () => hasChannel('redis'),
  ensure: () =>
    callHost<{ running: boolean; started: boolean; host: string; port: number }>(
      'redis',
      'ensureLocal',
      {},
      15_000
    ),
};

/** Saved connections live in the host's keychain; a browser has no such store. */
export const savedConnections = {
  available: () => hasChannel('redis'),
  list: () => callHost<SavedConnection[]>('redis', 'savedList', {}, 10_000),
  upsert: (entry: SavedConnectionInput) =>
    callHost<SavedConnection[]>('redis', 'savedUpsert', { ...entry }, 10_000),
  remove: (savedId: string) =>
    callHost<SavedConnection[]>('redis', 'savedRemove', { savedId }, 10_000),
  password: async (savedId: string) => {
    const { password } = await callHost<{ password: string }>('redis', 'savedPassword', { savedId }, 10_000);
    return password;
  },
};

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  db: number;
  username: string;
  hasPassword: boolean;
}

export interface SavedConnectionInput {
  savedId?: string;
  name: string;
  host: string;
  port: number;
  db: number;
  username: string;
  /** Omitted entirely when the stored password should stay as it is. */
  password?: string;
}
