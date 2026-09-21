import { Limits, ProviderId, Settings, Usage } from '../types/settings';
import { GraphTarget } from '../types/targets';
import { isNativeHost, settingsStore } from './nativeHost';

/**
 * Settings live in one JSON document. The native host writes it to
 * `~/Library/Application Support/Database Studio/settings.json`; in the browser it
 * falls back to `localStorage` so development works without the app bundle.
 *
 * API keys are part of that document. They stay on the machine — nothing in the
 * app ever sends them anywhere except to the provider they belong to.
 */

// Keep the legacy key so existing local development settings migrate without a
// second copy. The native app stores the canonical Database Studio file.
const STORAGE_KEY = 'graph-studio.settings';

export const DEFAULT_INGEST_PORT = 8787;

export function defaultSettings(): Settings {
  return {
    providers: {
      groq: { id: 'groq' },
      openai: { id: 'openai' },
      anthropic: { id: 'anthropic' },
      custom: { id: 'custom' },
    },
    activeProvider: 'groq',
    targets: [],
    defaultTargetId: null,
    usage: emptyUsage(),
    limits: {
      // Roughly a 60-page article's worth of text before a single job stops
      // asking for more. Generous for a page, a real ceiling for a long video.
      maxTokensPerJob: 200_000,
      maxTranscriptionMinutes: 90,
      maxFramesPerVideo: 40,
    },
    frameIntervalSeconds: 15,
    offlineExtractionOnly: false,
    ingestPort: DEFAULT_INGEST_PORT,
  };
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    transcribedSeconds: 0,
    framesAnalysed: 0,
    requests: 0,
    failedRequests: 0,
    since: new Date().toISOString(),
  };
}

/** Adds one request's measured consumption to the running totals. */
export function addUsage(total: Usage, delta: Partial<Usage>): Usage {
  return {
    inputTokens: total.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: total.outputTokens + (delta.outputTokens ?? 0),
    transcribedSeconds: total.transcribedSeconds + (delta.transcribedSeconds ?? 0),
    framesAnalysed: total.framesAnalysed + (delta.framesAnalysed ?? 0),
    requests: total.requests + (delta.requests ?? 0),
    failedRequests: total.failedRequests + (delta.failedRequests ?? 0),
    since: total.since,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = isNativeHost()
      ? await settingsStore.load()
      : JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    return merge(raw as Partial<Settings> | null);
  } catch {
    // A corrupt or unreadable settings file must not block the app from
    // starting — the user can always re-enter their keys.
    return defaultSettings();
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (isNativeHost()) {
    await settingsStore.save(settings);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Fills in anything a stored document is missing, e.g. after an update. */
function merge(stored: Partial<Settings> | null): Settings {
  const defaults = defaultSettings();
  if (!stored) return defaults;

  const providers = { ...defaults.providers };
  for (const id of Object.keys(providers) as ProviderId[]) {
    providers[id] = { ...providers[id], ...(stored.providers?.[id] ?? {}), id };
  }

  const targets = Array.isArray(stored.targets) ? (stored.targets as GraphTarget[]) : [];

  return {
    providers,
    activeProvider: stored.activeProvider ?? defaults.activeProvider,
    targets,
    defaultTargetId:
      stored.defaultTargetId && targets.some((target) => target.id === stored.defaultTargetId)
        ? stored.defaultTargetId
        : targets[0]?.id ?? null,
    usage: { ...defaults.usage, ...(stored.usage ?? {}) },
    limits: mergeLimits(stored.limits, defaults.limits),
    frameIntervalSeconds: clamp(stored.frameIntervalSeconds, 2, 120, defaults.frameIntervalSeconds),
    offlineExtractionOnly: stored.offlineExtractionOnly ?? defaults.offlineExtractionOnly,
    ingestPort: clamp(stored.ingestPort, 1024, 65_535, defaults.ingestPort),
  };
}

function mergeLimits(stored: Partial<Limits> | undefined, defaults: Limits): Limits {
  return {
    // 0 means "no limit" everywhere, so it has to survive the clamp.
    maxTokensPerJob: clampAllowingZero(stored?.maxTokensPerJob, 1_000, 5_000_000, defaults.maxTokensPerJob),
    maxTranscriptionMinutes: clampAllowingZero(stored?.maxTranscriptionMinutes, 1, 600, defaults.maxTranscriptionMinutes),
    maxFramesPerVideo: clampAllowingZero(stored?.maxFramesPerVideo, 1, 400, defaults.maxFramesPerVideo),
  };
}

function clampAllowingZero(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  if (value === 0) return 0;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
