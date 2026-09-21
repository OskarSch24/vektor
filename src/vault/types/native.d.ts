/**
 * Contract between the React app and the native macOS host (src/native/main.swift).
 * All members are absent when the app runs in a plain browser during development,
 * where `src/services/redis/transport.ts` falls back to the Vite bridge instead.
 */
interface VaultStudioBridge {
  /** Resolves a pending RPC call with base64 of `{ ok, data?, error? }`. */
  __resolve?: (requestId: number, encodedPayload: string) => void;

  /**
   * Hands the renderer one HTTP request that arrived on the local API port.
   * `encodedCall` is the base64 of `{ method, path, query, body }`; the answer
   * goes back through the `apiControl` handler's `reply` action.
   */
  __apiRequest?: (requestId: number, encodedCall: string) => void;

  /** Called by the "Neue Verbindung…" menu item. */
  openConnectionDialog?: () => void;

  /** Called after the native folder picker adds a persistent project. */
  projectsChanged?: () => void;

  /** Called by the "Neu laden" menu item. */
  reloadKeyspace?: () => void;
}

interface WebKitMessageHandler {
  postMessage: (message: unknown) => void;
}

interface Window {
  vaultStudio?: VaultStudioBridge;
}
