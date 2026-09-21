import {
  announceReady as announceDatabaseStudioReady,
  files,
  isNativeHost as isDatabaseStudioHost,
  onNativeFileStaged,
} from '../../services/nativeHost';

/**
 * Thin wrapper around the WKWebView bridge exposed by src/native/main.swift.
 * Every function degrades to a no-op / `false` in a normal browser, so the same
 * build runs both as the packaged macOS app and via `npm run dev`.
 */

export function isNativeHost(): boolean {
  return isDatabaseStudioHost();
}

/** Opens the native macOS file panel. Returns false if there is no host. */
export function requestNativeOpenDialog(): boolean {
  // The shared host lets WebKit's ordinary file input own this picker. It can
  // return binary SQLite/Excel bytes without attempting to decode them first.
  return false;
}

/** Tells the host the UI is mounted and ready to receive queued files. */
export function announceReady(): void {
  announceDatabaseStudioReady();
}

/**
 * Registers the callback the host invokes when the user opens a database from
 * Finder. The bytes are fetched from the host's custom URL scheme rather than
 * being marshalled through a JavaScript string.
 */
export function onNativeFileOpened(
  handler: (file: { buffer: ArrayBuffer; filename: string }) => void,
  onError: (message: string) => void
): () => void {
  return onNativeFileStaged(({ url, filename }) => {
    fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => handler({ buffer, filename }))
      .catch((err) => onError(`"${filename}" konnte nicht gelesen werden: ${err?.message || err}`));
  });
}

/**
 * Reads a file from disk through the host.
 *
 * The bytes come back over the `app://` scheme rather than as a string: a
 * hundred-megabyte database marshalled through `evaluateJavaScript` would cost
 * several times its size in JavaScript string memory. Used by the local API's
 * `POST /open`, which lets another tool decide what this window should show.
 */
export async function readFileAtPath(path: string): Promise<ArrayBuffer> {
  const { url } = await files.stage(path);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`"${path}" konnte nicht gelesen werden (HTTP ${response.status}).`);
  }
  return response.arrayBuffer();
}
