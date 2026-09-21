/**
 * Contract between the React app and the native macOS host (src/native/main.swift).
 * All members are absent when the app runs in a plain browser during development.
 */
interface SQLiteStudioBridge {
  /**
   * Called by the Swift host after it has staged a file opened via Finder or the
   * native open panel. The app fetches the bytes from `app://localhost/<url>`
   * instead of receiving them as a base64 string, which would otherwise have to
   * pass through `evaluateJavaScript` in one piece.
   */
  openFile?: (url: string, filename: string) => void;

  /**
   * Called by the host when it changed the project list outside of an RPC call,
   * for example through the "Projektordner hinzufügen…" menu item.
   */
  projectsChanged?: () => void;

  /**
   * Resolves a pending RPC call. `encodedPayload` is the base64 of a UTF-8 JSON
   * document `{ ok, data?, error? }`.
   */
  __resolve?: (requestId: number, encodedPayload: string) => void;

  /**
   * Hands the renderer one HTTP request that arrived on the local API port.
   * `encodedCall` is the base64 of `{ method, path, query, body }`; the answer
   * goes back through the `apiControl` handler's `reply` action.
   */
  __apiRequest?: (requestId: number, encodedCall: string) => void;
}

interface WebKitMessageHandler {
  postMessage: (message: unknown) => void;
}

interface Window {
  sqliteStudio?: SQLiteStudioBridge;
}
