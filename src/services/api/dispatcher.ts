import { apiControl } from '../nativeHost';

export type ApiAdapter = 'sqlite' | 'graph' | 'vault';
export type ApiRequestHandler = (requestId: number, encodedCall: string) => void;

const handlers = new Map<ApiAdapter, ApiRequestHandler>();
let activeAdapter: ApiAdapter = 'graph';

function decode(encoded: string): { path?: string; [key: string]: unknown } {
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  );
  return JSON.parse(json) as { path?: string; [key: string]: unknown };
}

function encode(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function resolvePath(path: string): { adapter: ApiAdapter; path: string } {
  const canonical = path.match(/^\/api\/v1\/(sqlite|graph|vault)(\/.*)?$/);
  if (canonical) {
    return {
      adapter: canonical[1] as ApiAdapter,
      path: `/api/v1${canonical[2] ?? ''}`,
    };
  }

  const legacy = path.match(/^\/compat\/(sqlite|graph|vault)\/api\/v1(\/.*)?$/);
  if (legacy) {
    return {
      adapter: legacy[1] as ApiAdapter,
      path: `/api/v1${legacy[2] ?? ''}`,
    };
  }

  return { adapter: activeAdapter, path };
}

function replyUnavailable(requestId: number, adapter: ApiAdapter, message: string): void {
  void apiControl('reply', {
    callId: requestId,
    status: 503,
    json: JSON.stringify({ error: message, adapter }),
  }).catch(() => undefined);
}

function dispatch(requestId: number, encodedCall: string): void {
  let raw: { path?: string; [key: string]: unknown };
  try {
    raw = decode(encodedCall);
  } catch (error) {
    replyUnavailable(
      requestId,
      activeAdapter,
      `Anfrage nicht lesbar: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const resolved = resolvePath(typeof raw.path === 'string' ? raw.path : '/');
  const handler = handlers.get(resolved.adapter);
  if (!handler) {
    replyUnavailable(requestId, resolved.adapter, `Der Adapter „${resolved.adapter}“ ist noch nicht bereit.`);
    return;
  }

  handler(requestId, encode({ ...raw, path: resolved.path, publicPath: raw.path }));
}

const bridge = (window.databaseStudio ??= window.graphStudio ?? {});
window.graphStudio = bridge;
bridge.__apiRequest = dispatch;

export function registerApiAdapter(adapter: ApiAdapter, handler: ApiRequestHandler): () => void {
  handlers.set(adapter, handler);
  return () => {
    if (handlers.get(adapter) === handler) handlers.delete(adapter);
  };
}

export function setActiveApiAdapter(adapter: ApiAdapter): void {
  activeAdapter = adapter;
}
