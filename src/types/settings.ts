/**
 * Persisted configuration. Written through the native host into
 * `~/Library/Application Support/Database Studio/settings.json`, and into
 * `localStorage` when the app runs in a plain browser during development.
 */

import { GraphTarget } from './targets';

/** Providers speaking the OpenAI chat-completions / audio-transcriptions shape. */
export type ProviderId = 'groq' | 'openai' | 'anthropic' | 'custom';

export interface ProviderConfig {
  id: ProviderId;
  /** Overrides the built-in default, e.g. for a self-hosted gateway. */
  baseUrl?: string;
  apiKey?: string;
  /** Text model used for entity and relation extraction. */
  textModel?: string;
  /** Multimodal model used for the frame-by-frame pass. */
  visionModel?: string;
  /** Whisper-compatible speech-to-text model. */
  transcriptionModel?: string;
}

/**
 * What the providers actually reported, summed up. Every number here is read
 * off an API response or measured from a file — none of it is estimated, and
 * nothing is granted or deducted.
 */
export interface Usage {
  /** Tokens billed by the text and vision models, as they reported them. */
  inputTokens: number;
  outputTokens: number;
  /** Seconds of audio actually sent to a transcription endpoint. */
  transcribedSeconds: number;
  /** Frames actually sent to a vision model. */
  framesAnalysed: number;
  /** Requests issued, and how many of them came back as errors. */
  requests: number;
  failedRequests: number;
  /** When counting started — reset writes today's date here. */
  since: string;
}

/**
 * Ceilings on real quantities, so one oversized job cannot run up a bill. `0`
 * means no limit.
 */
export interface Limits {
  /** Stops the text pass once a single job has used this many tokens. */
  maxTokensPerJob: number;
  /** Skips transcription for videos longer than this. */
  maxTranscriptionMinutes: number;
  /** Hard cap on sampled frames per video. */
  maxFramesPerVideo: number;
}

export interface Settings {
  providers: Record<ProviderId, ProviderConfig>;
  activeProvider: ProviderId;
  targets: GraphTarget[];
  defaultTargetId: string | null;
  /** Measured consumption. Read-only except for an explicit reset. */
  usage: Usage;
  limits: Limits;
  /** Frame sampling interval for the video pass, in seconds. */
  frameIntervalSeconds: number;
  /** Skip the AI pass entirely and use the heuristic extractor only. */
  offlineExtractionOnly: boolean;
  /** Port the ingest server listens on; the extension must use the same one. */
  ingestPort: number;
}
