/**
 * Contract between the React app and the native macOS host (src/native/main.swift).
 * Every member is absent when the app runs in a plain browser during development,
 * so `services/nativeHost.ts` degrades each call to a browser equivalent.
 */
interface DatabaseStudioBridge {
  /**
   * Resolves a pending RPC call. `encodedPayload` is the base64 of a UTF-8 JSON
   * document `{ ok, data?, error? }` — base64 because passing large payloads
   * (a frame batch, a whole graph) through `evaluateJavaScript` as a quoted
   * string is both slower and easy to break on escaping.
   */
  __resolve?: (requestId: number, encodedPayload: string) => void;

  /** Called by the host after staging a `.graph` file opened from Finder. */
  openFile?: (url: string, filename: string, path: string, pendingWal?: boolean) => void;

  /** Called by the host when the ingest server accepted a payload. */
  onIngest?: (encodedPayload: string) => void;

  /** Called when a long-running native job reports progress. */
  onJobProgress?: (jobId: string, stage: string, progress: number, message: string) => void;

  /**
   * Hands the renderer one HTTP request that arrived on the local API port.
   * `encodedCall` is the base64 of `{ method, path, query, body }`; the answer
   * goes back through the `api` handler's `reply` method.
   */
  __apiRequest?: (requestId: number, encodedCall: string) => void;
}

interface WebKitMessageHandler {
  postMessage: (message: unknown) => void;
}

interface Window {
  databaseStudio?: DatabaseStudioBridge;
  /** Transitional alias used by the unchanged Graph workspace. */
  graphStudio?: DatabaseStudioBridge;
  webkit?: {
    messageHandlers?: {
      appReady?: WebKitMessageHandler;
      /** Single entry point for every request/response call into the host. */
      rpc?: WebKitMessageHandler;
      /** Local HTTP API: status / start / stop / rotateToken / reply / health. */
      api?: WebKitMessageHandler;
      /** Compatibility channels used by ported SQLite and Redis workspaces. */
      apiControl?: WebKitMessageHandler;
      openNativeFileDialog?: WebKitMessageHandler;
      projects?: WebKitMessageHandler;
      redis?: WebKitMessageHandler;
      /** Title bar geometry, so the host knows where dragging is allowed. */
      windowDrag?: WebKitMessageHandler;
    };
  };
}
