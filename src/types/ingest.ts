/**
 * What the Chrome extension sends over and what the app makes of it.
 *
 * The extension only ever ships *raw* material — text, metadata, media URLs. All
 * interpretation (entity extraction, transcription, frame analysis) happens in
 * the app, because that is where the API keys and the usage limits live.
 */

export type SourceKind = 'website' | 'video' | 'social' | 'manual' | 'import' | 'coordination';

/** The payload posted to `POST /ingest` by the extension. */
export interface IngestPayload {
  kind: SourceKind;
  url: string;
  title: string;
  /** Target graph chosen in the popup; empty means "the open graph". */
  targetId?: string;
  /**
   * Absolute path of a `.graph` file to write into — the database picked inside
   * a project. Takes precedence over `targetId`.
   */
  targetPath?: string;
  /**
   * Set when the caller wants every page of the site listed first, instead of
   * this one page converted straight away.
   */
  mapSite?: boolean;
  /** Readable page text, already stripped of navigation and boilerplate. */
  text?: string;
  /** `<meta>`, OpenGraph and JSON-LD data found in the document head. */
  meta?: Record<string, string>;
  jsonLd?: unknown[];
  links?: Array<{ href: string; text: string; rel?: string }>;
  images?: Array<{ src: string; alt: string }>;
  /** Set for social posts the content script could parse structurally. */
  post?: SocialPost;
  /** Set when the page holds a video the app should download and analyse. */
  video?: VideoRef;
  capturedAt: string;
}

export interface SocialPost {
  platform: string;
  author?: string;
  authorHandle?: string;
  authorUrl?: string;
  publishedAt?: string;
  body?: string;
  likes?: number;
  reposts?: number;
  replies?: number;
  hashtags?: string[];
  mentions?: string[];
  mediaUrls?: string[];
}

export interface VideoRef {
  platform: string;
  pageUrl: string;
  /** Direct media URL when the page exposed one; yt-dlp resolves the rest. */
  mediaUrl?: string;
  durationSeconds?: number;
  thumbnail?: string;
}

export type JobStage =
  | 'queued'
  | 'fetching'
  | 'downloading'
  | 'transcribing'
  | 'analysing'
  | 'extracting'
  | 'writing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface IngestJob {
  id: string;
  payload: IngestPayload;
  stage: JobStage;
  /** 0–1 where the stage can report it, otherwise null for indeterminate. */
  progress: number | null;
  message: string;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  /** Tokens the models reported for this job, once it finished. */
  tokensUsed?: number;
  result?: {
    nodesCreated: number;
    edgesCreated: number;
    targetId: string;
  };
}

/** A transcript segment as returned by a Whisper-compatible endpoint. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** What the vision pass makes of a single sampled frame. */
export interface FrameAnalysis {
  timestamp: number;
  description: string;
  /** On-screen text the model could read, if any. */
  onScreenText?: string;
  entities: string[];
}
