import { IngestPayload } from '../types/ingest';
import { Project } from '../types/projects';

/**
 * Thin wrapper around the WKWebView bridge exposed by src/native/main.swift.
 *
 * Every call has a browser fallback, so `npm run dev` runs the whole UI without
 * the app bundle — only the genuinely native capabilities (yt-dlp, ffmpeg, the
 * ingest server, writing to arbitrary paths) report themselves as unavailable.
 */

export function isNativeHost(): boolean {
  return Boolean(window.webkit?.messageHandlers?.rpc);
}

let nextRequestId = 1;
const pending = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}>();

function bridge(): DatabaseStudioBridge {
  const existing = window.databaseStudio ?? window.graphStudio ?? {};
  window.databaseStudio = existing;
  window.graphStudio = existing;
  return existing;
}

// The host resolves calls by id; registering the callback once here keeps every
// caller below free of bookkeeping.
bridge().__resolve = (requestId, encodedPayload) => {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  window.clearTimeout(entry.timeout);

  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(encodedPayload), (char) => char.charCodeAt(0))
    );
    const payload = JSON.parse(json) as { ok: boolean; data?: unknown; error?: string };
    if (payload.ok) entry.resolve(payload.data);
    else entry.reject(new Error(payload.error || 'Unbekannter Fehler im nativen Host'));
  } catch (err) {
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  }
};

export class NoHostError extends Error {
  constructor(capability: string) {
    super(`${capability} ist nur in Vektor verfügbar, nicht im Browser.`);
    this.name = 'NoHostError';
  }
}

/** Issues one RPC call into the Swift host. */
export function callNative<T>(
  channel: string,
  method: string,
  params: unknown = {},
  timeoutMs = 120_000
): Promise<T> {
  const handler = window.webkit?.messageHandlers?.rpc;
  if (!handler) return Promise.reject(new NoHostError(`${channel}.${method}`));

  const requestId = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Zeitüberschreitung bei "${channel}.${method}".`));
    }, timeoutMs);
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
    handler.postMessage({ id: requestId, channel, method, params });
  });
}

const call = callNative;

export function hasApiChannel(): boolean {
  return Boolean(window.webkit?.messageHandlers?.api);
}

/**
 * The local API's control channel.
 *
 * It has its own message handler rather than riding on `rpc` because the host
 * answers these on the main thread — they touch the listener and the table of
 * in-flight HTTP requests, neither of which survives being handled on a
 * background queue like the rest of the bridge.
 */
export function apiControl<T>(method: string, params: unknown = {}): Promise<T> {
  const handler = window.webkit?.messageHandlers?.api;
  if (!handler) return Promise.reject(new NoHostError(`api.${method}`));

  const requestId = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Zeitüberschreitung bei "api.${method}".`));
    }, 15_000);
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
    handler.postMessage({ id: requestId, method, params });
  });
}

/** Tells the host the UI is mounted and ready to receive queued work. */
export function announceReady(): void {
  window.webkit?.messageHandlers?.appReady?.postMessage({ status: 'ready' });
}

// MARK: - Files

export interface OpenedFile {
  path: string;
  name: string;
  contents: string;
}

export interface StagedFile {
  path: string;
  name: string;
  url: string;
  pendingWal?: boolean;
}

export const files = {
  /** Native picker that stages text or binary data without decoding it. */
  pick: () => call<StagedFile | null>('files', 'pick'),
  /** Native open panel; resolves to null when the user cancels. */
  open: () => call<OpenedFile | null>('files', 'open'),
  /** Native save panel followed by a write; resolves to the chosen path. */
  saveAs: (suggestedName: string, contents: string) =>
    call<{ path: string } | null>('files', 'saveAs', { suggestedName, contents }),
  /** Writes to a known path without a dialog — used by autosave. */
  write: (path: string, contents: string) => call<{ path: string }>('files', 'write', { path, contents }),
  read: (path: string) => call<OpenedFile>('files', 'read', { path }),
  /** Stages arbitrary binary data behind the app:// scheme for table imports. */
  stage: (path: string) =>
    call<StagedFile>('files', 'stage', { path }),
  /** Reveals a path in Finder. */
  reveal: (path: string) => call<void>('files', 'reveal', { path }),
  /** Native folder picker; resolves to null when the user cancels. */
  chooseFolder: (message: string) =>
    call<{ path: string; name: string } | null>('files', 'chooseFolder', { message }),
  /**
   * Reads one flat directory of text files. Not recursive, and capped by the
   * host — see `AppConfig.maxFolderFiles`. `skipped` counts what the caps left
   * out, so a truncated read can say so instead of looking complete.
   */
  readFolder: (path: string, extension?: string) =>
    call<FolderContents>('files', 'readFolder', { path, extension: extension ?? '' }),
};

export interface FolderContents {
  path: string;
  files: Array<{ name: string; path: string; contents: string }>;
  skipped: number;
}

/**
 * Registers the callback the host invokes when a `.graph` file is opened from
 * Finder. The bytes are fetched over the `app://` scheme rather than marshalled
 * through a JavaScript string.
 */
export function onNativeFileOpened(
  handler: (file: { contents: string; filename: string; path: string }) => void,
  onError: (message: string) => void
): () => void {
  const target = bridge();

  target.openFile = (url, filename, path) => {
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((contents) => handler({ contents, filename, path }))
      .catch((err) => onError(`"${filename}" konnte nicht gelesen werden: ${err?.message || err}`));
  };

  return () => {
    delete target.openFile;
  };
}

/** Registers the canonical Finder/open-panel callback without reading bytes. */
export function onNativeFileStaged(
  handler: (file: { url: string; filename: string; path: string; pendingWal?: boolean }) => void
): () => void {
  const target = bridge();
  target.openFile = (url, filename, path, pendingWal) => handler({ url, filename, path, pendingWal });
  return () => {
    delete target.openFile;
  };
}

// MARK: - Site map

export interface MappedUrl {
  url: string;
  lastModified?: string;
}

export interface SiteMapResult {
  urls: MappedUrl[];
  /** `sitemap` when the site publishes one, `crawl` when links were read. */
  via: 'sitemap' | 'crawl' | 'none';
  sitemaps: string[];
  /** True when the limit cut the list short. */
  truncated: boolean;
}

export const siteMap = {
  discover: (url: string, limit: number) =>
    call<SiteMapResult>('map', 'discover', { url, limit }),
  /** Fetches one page's HTML; parsing happens in the renderer. */
  fetchPage: (url: string) =>
    call<{ html: string; url: string; bytes: number; rendered: boolean }>('map', 'fetchPage', { url }),
};

// MARK: - Projects

export const projectStore = {
  list: () => call<Project[]>('projects', 'list'),
  /** Opens a folder picker; resolves to null when the user cancels. */
  add: () => call<Project | null>('projects', 'add'),
  remove: (id: string) => call<void>('projects', 'remove', { id }),
  /** Re-scans a folder. Resolves to null once the project is gone. */
  refresh: (id: string) => call<Project | null>('projects', 'refresh', { id }),
};

// MARK: - Settings

export const settingsStore = {
  load: () => call<Record<string, unknown> | null>('settings', 'load'),
  save: (settings: unknown) => call<void>('settings', 'save', { settings }),
};

// MARK: - Ingest server

export interface ServerStatus {
  running: boolean;
  port: number;
  /** Extension origins that were allowed to POST since the app started. */
  clients: string[];
  /** Last request carrying a Chrome-extension origin or the explicit client marker. */
  lastSeenAt?: string | null;
  /** Last payload accepted by POST /ingest, regardless of processing duration. */
  lastIngestAt?: string | null;
  requestCount?: number;
  /** Most recent listener start failure, e.g. a port collision. */
  error?: string | null;
}

export interface BrowserExtensionBundleInfo {
  available: boolean;
  path: string;
  version: string;
}

export const ingestServer = {
  status: () => call<ServerStatus>('server', 'status'),
  start: (port: number) => call<ServerStatus>('server', 'start', { port }),
  stop: () => call<ServerStatus>('server', 'stop'),
  extensionInfo: () => call<BrowserExtensionBundleInfo>('server', 'extensionInfo'),
  /**
   * Pushes what `GET /status` should report. The HTTP handler answers from this
   * cached snapshot instead of calling into JavaScript, so a request from the
   * extension never has to wait on the render thread.
   */
  setState: (state: { graphName: string; graphPath: string; nodeCount: number; tokensUsed: number }) =>
    call<void>('server', 'setState', state),
};

/** Registers the callback for payloads the ingest server accepted. */
export function onIngestReceived(handler: (payload: IngestPayload) => void): () => void {
  const target = bridge();

  target.onIngest = (encodedPayload) => {
    try {
      const json = new TextDecoder().decode(
        Uint8Array.from(atob(encodedPayload), (char) => char.charCodeAt(0))
      );
      handler(JSON.parse(json) as IngestPayload);
    } catch {
      // A malformed payload is the extension's problem, not something the user
      // can act on; the server already logged it.
    }
  };

  return () => {
    delete target.onIngest;
  };
}

// MARK: - Media

export interface ToolStatus {
  ytdlp: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
}

export interface VideoInfo {
  title: string;
  durationSeconds: number;
  uploader: string;
  uploadDate: string;
  description: string;
  thumbnail: string;
  viewCount: number;
  webpageUrl: string;
}

export interface DownloadResult {
  /** Absolute path of the downloaded media file inside the app's cache. */
  path: string;
  title: string;
  durationSeconds: number;
}

export interface AudioResult {
  /** `app://` URL the renderer fetches to obtain the audio bytes. */
  url: string;
  filename: string;
  sizeBytes: number;
}

export interface FramesResult {
  frames: Array<{ timestamp: number; dataUrl: string }>;
}

export const media = {
  tools: () => call<ToolStatus>('media', 'tools'),
  /** Metadata only — no download, so it is cheap enough to run on hover. */
  probe: (url: string) => call<VideoInfo>('media', 'probe', { url }),
  download: (jobId: string, url: string) => call<DownloadResult>('media', 'download', { jobId, url }),
  /** Transcodes to 16 kHz mono Opus, which is what Whisper endpoints want. */
  extractAudio: (path: string) => call<AudioResult>('media', 'extractAudio', { path }),
  /** Samples JPEG frames every `intervalSeconds`, capped at `maxFrames`. */
  extractFrames: (path: string, intervalSeconds: number, maxFrames: number) =>
    call<FramesResult>('media', 'extractFrames', { path, intervalSeconds, maxFrames }),
  /** Removes the cached media file once a job is done with it. */
  cleanup: (path: string) => call<void>('media', 'cleanup', { path }),
};

/** Registers the progress callback for long-running native jobs. */
export function onJobProgress(
  handler: (jobId: string, stage: string, progress: number, message: string) => void
): () => void {
  const target = bridge();
  target.onJobProgress = handler;
  return () => {
    delete target.onJobProgress;
  };
}
