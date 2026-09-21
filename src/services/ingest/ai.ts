import { FrameAnalysis, TranscriptSegment } from '../../types/ingest';
import { ProviderConfig, ProviderId } from '../../types/settings';

/**
 * The model layer. Two wire formats are supported: the OpenAI shape — which
 * Groq, Together, Ollama and most gateways also speak — and Anthropic's
 * Messages API. Everything else in the app talks to the functions below and
 * never to a provider directly.
 *
 * Defaults deliberately point at the cheapest capable models: entity extraction
 * and frame captioning are high-volume, low-difficulty jobs, and paying
 * frontier prices for them would make ingesting a single video cost more than
 * the video is worth.
 */

export interface ProviderDefaults {
  label: string;
  baseUrl: string;
  textModel: string;
  visionModel: string;
  transcriptionModel: string;
  /** Providers without a speech endpoint fall back to another one. */
  supportsTranscription: boolean;
  wire: 'openai' | 'anthropic';
  keyUrl: string;
}

export const PROVIDER_DEFAULTS: Record<ProviderId, ProviderDefaults> = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    textModel: 'llama-3.3-70b-versatile',
    visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    transcriptionModel: 'whisper-large-v3-turbo',
    supportsTranscription: true,
    wire: 'openai',
    keyUrl: 'https://console.groq.com/keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    textModel: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
    transcriptionModel: 'whisper-1',
    supportsTranscription: true,
    wire: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    textModel: 'claude-haiku-4-5-20251001',
    visionModel: 'claude-haiku-4-5-20251001',
    transcriptionModel: '',
    supportsTranscription: false,
    wire: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  custom: {
    label: 'Eigener Endpunkt',
    baseUrl: 'http://localhost:11434/v1',
    textModel: 'llama3.1',
    visionModel: 'llava',
    transcriptionModel: 'whisper-1',
    supportsTranscription: true,
    wire: 'openai',
    keyUrl: '',
  },
};

export interface ExtractedEntity {
  name: string;
  /** Node label: Person, Organization, Place, Product, Topic, Event, Work. */
  type: string;
  description?: string;
}

export interface ExtractedRelation {
  from: string;
  type: string;
  to: string;
  /** Where in the source this came from, e.g. a timestamp in a video. */
  evidence?: string;
}

export interface Extraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  summary: string;
  topics: string[];
}

export const ENTITY_LABELS = [
  'Person',
  'Organization',
  'Place',
  'Product',
  'Topic',
  'Event',
  'Work',
] as const;

const EXTRACTION_SYSTEM_PROMPT = [
  'Du extrahierst aus Texten einen Wissensgraphen.',
  '',
  'Regeln:',
  `- Erlaubte Entitätstypen: ${ENTITY_LABELS.join(', ')}.`,
  '- Nur Entitäten, die im Text tatsächlich vorkommen. Nichts erfinden, nichts aus Weltwissen ergänzen.',
  '- Beziehungstypen in GROSSBUCHSTABEN mit Unterstrichen, z. B. ARBEITET_BEI, GEGRUENDET, ERWAEHNT, TEIL_VON.',
  '- "from" und "to" jeder Beziehung müssen exakt einem Entitätsnamen aus "entities" entsprechen.',
  '- Höchstens 40 Entitäten und 60 Beziehungen. Lieber wenige präzise als viele vage.',
  '',
  'Antworte ausschließlich mit JSON in dieser Form:',
  '{"summary":"…","topics":["…"],"entities":[{"name":"…","type":"…","description":"…"}],',
  ' "relations":[{"from":"…","type":"…","to":"…","evidence":"…"}]}',
].join('\n');

/**
 * What a request actually cost, as the provider reported it. Never estimated:
 * if a response carries no usage block the counters simply stay at zero rather
 * than being filled with a guess.
 */
export interface RequestUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface Measured<T> {
  value: T;
  usage: RequestUsage;
}


export type ProviderFailure =
  | 'circuit'   // skipped: the endpoint failed a moment ago and is being rested
  | 'network'   // the request never reached the endpoint
  | 'auth'      // key rejected
  | 'quota'     // rate limited or out of credit
  | 'server'    // the provider is having a bad day
  | 'config'    // nothing was sent: no key, unusable settings
  | 'response'; // answered, but not with what was asked for

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly failure: ProviderFailure = 'response'
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /**
   * Whether a request was actually attempted. A connection that was refused
   * still counts — it was a try that failed. Only what the circuit breaker
   * stopped, or what was never sent for lack of configuration, does not.
   */
  get reachedNetwork(): boolean {
    return this.failure !== 'config' && this.failure !== 'circuit';
  }
}

/**
 * Remembers an endpoint that has just proved unreachable.
 *
 * Without this, a whole-site run asks a dead endpoint once per text chunk of
 * every page — several hundred pointless requests, each waiting out its own
 * timeout, for one problem the user was told about at the very first page.
 */
const openCircuits = new Map<string, { until: number; reason: string; strikes: number }>();
/** First rest is a minute; each further failure doubles it, up to 15 minutes. */
const CIRCUIT_MIN_SECONDS = 60;
const CIRCUIT_MAX_SECONDS = 15 * 60;

function circuitKey(provider: ProviderDefaults & { apiKey: string }): string {
  return provider.baseUrl;
}

function guardCircuit(provider: ProviderDefaults & { apiKey: string }): void {
  const open = openCircuits.get(circuitKey(provider));
  if (!open) return;

  if (Date.now() > open.until) {
    // Time to probe again — but remember how often this has failed, so the
    // next rest is longer. The entry stays until a success clears it.
    return;
  }
  throw new ProviderError(open.reason, undefined, 'circuit');
}

function openCircuit(provider: ProviderDefaults & { apiKey: string }, reason: string): void {
  const previous = openCircuits.get(circuitKey(provider));
  const strikes = (previous?.strikes ?? 0) + 1;
  const seconds = Math.min(CIRCUIT_MAX_SECONDS, CIRCUIT_MIN_SECONDS * 2 ** (strikes - 1));
  openCircuits.set(circuitKey(provider), {
    until: Date.now() + seconds * 1000,
    reason,
    strikes,
  });
}

function closeCircuit(provider: ProviderDefaults & { apiKey: string }): void {
  openCircuits.delete(circuitKey(provider));
}

/** Clears the memo, so pressing "Testen" in the settings really tries again. */
export function forgetProviderFailures(): void {
  openCircuits.clear();
}

/**
 * Issues the request and turns every failure into something the user can act
 * on. A bare `fetch` rejection says "Load failed" and nothing else — not which
 * endpoint, not why.
 */
async function send(
  provider: ProviderDefaults & { apiKey: string },
  path: string,
  init: RequestInit
): Promise<Response> {
  guardCircuit(provider);

  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}${path}`, init);
  } catch (err) {
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(provider.baseUrl);
    const reason = isLocal
      ? `${provider.baseUrl} ist nicht erreichbar — läuft dort ein Dienst? ` +
        'Einstellungen → KI-Anbieter, Basis-URL prüfen oder einen anderen Anbieter wählen.'
      : `${provider.baseUrl} ist nicht erreichbar (${err instanceof Error ? err.message : err}). ` +
        'Netzwerk oder Basis-URL prüfen.';
    openCircuit(provider, reason);
    throw new ProviderError(reason, undefined, 'network');
  }

  if (response.ok) closeCircuit(provider);

  if (!response.ok) {
    const text = await errorText(response);
    const failure: ProviderFailure =
      response.status === 401 || response.status === 403
        ? 'auth'
        : response.status === 429
          ? 'quota'
          : response.status >= 500
            ? 'server'
            : 'response';

    // A rejected key or an exhausted quota will not fix itself mid-run.
    if (failure !== 'response') {
      openCircuit(provider, `${provider.label}: ${text}`);
    }
    throw new ProviderError(`${provider.label}: ${text}`, response.status, failure);
  }

  return response;
}

/** Merges a stored config with its provider defaults. */
export function resolveProvider(config: ProviderConfig): ProviderDefaults & { apiKey: string } {
  const defaults = PROVIDER_DEFAULTS[config.id] ?? PROVIDER_DEFAULTS.custom;
  return {
    ...defaults,
    baseUrl: (config.baseUrl || defaults.baseUrl).replace(/\/$/, ''),
    textModel: config.textModel || defaults.textModel,
    visionModel: config.visionModel || defaults.visionModel,
    transcriptionModel: config.transcriptionModel || defaults.transcriptionModel,
    apiKey: config.apiKey ?? '',
  };
}

// MARK: - Text extraction

/** Runs the entity and relation pass over a chunk of text. */
export async function extractGraph(
  config: ProviderConfig,
  text: string,
  context: { title: string; url: string; kind: string }
): Promise<Measured<Extraction>> {
  const provider = resolveProvider(config);
  const prompt = [
    `Quelle: ${context.title}`,
    `URL: ${context.url}`,
    `Art: ${context.kind}`,
    '',
    'Text:',
    text,
  ].join('\n');

  const reply =
    provider.wire === 'anthropic'
      ? await anthropicMessage(provider, EXTRACTION_SYSTEM_PROMPT, [
          { type: 'text', text: prompt },
        ])
      : await openAiChat(provider, provider.textModel, EXTRACTION_SYSTEM_PROMPT, [
          { type: 'text', text: prompt },
        ], true);

  return { value: normaliseExtraction(parseJsonObject(reply.value)), usage: reply.usage };
}

// MARK: - Vision

/**
 * Describes sampled video frames. Frames are sent in small batches: one request
 * per frame is needlessly slow, and a single request with fifty images blows
 * past every provider's payload limit.
 */
export async function analyseFrames(
  config: ProviderConfig,
  frames: Array<{ timestamp: number; dataUrl: string }>,
  onProgress?: (done: number, total: number) => void
): Promise<Measured<FrameAnalysis[]>> {
  const provider = resolveProvider(config);
  const results: FrameAnalysis[] = [];
  const usage: RequestUsage = { inputTokens: 0, outputTokens: 0 };
  const batchSize = 4;

  const system = [
    'Du beschreibst Einzelbilder aus einem Video für einen Wissensgraphen.',
    'Pro Bild: was ist zu sehen, welcher Text steht im Bild, welche benannten Dinge kommen vor.',
    'Antworte ausschließlich mit JSON:',
    '{"frames":[{"index":0,"description":"…","onScreenText":"…","entities":["…"]}]}',
  ].join('\n');

  for (let start = 0; start < frames.length; start += batchSize) {
    const batch = frames.slice(start, start + batchSize);
    const content: ContentPart[] = [
      {
        type: 'text',
        text: `${batch.length} Bilder, Zeitmarken: ${batch
          .map((frame) => `${frame.timestamp}s`)
          .join(', ')}. Nutze index 0…${batch.length - 1} in dieser Reihenfolge.`,
      },
      ...batch.map((frame): ContentPart => ({ type: 'image', dataUrl: frame.dataUrl })),
    ];

    const reply =
      provider.wire === 'anthropic'
        ? await anthropicMessage(provider, system, content)
        : await openAiChat(provider, provider.visionModel, system, content, true);

    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;

    const parsed = parseJsonObject(reply.value) as { frames?: unknown };
    const entries = Array.isArray(parsed.frames) ? parsed.frames : [];

    for (let i = 0; i < batch.length; i += 1) {
      const entry = (entries[i] ?? {}) as Record<string, unknown>;
      results.push({
        timestamp: batch[i].timestamp,
        description: typeof entry.description === 'string' ? entry.description : '',
        onScreenText: typeof entry.onScreenText === 'string' ? entry.onScreenText : undefined,
        entities: Array.isArray(entry.entities)
          ? entry.entities.filter((value): value is string => typeof value === 'string')
          : [],
      });
    }

    onProgress?.(Math.min(start + batchSize, frames.length), frames.length);
  }

  return { value: results, usage };
}

// MARK: - Transcription

/**
 * Sends audio to a Whisper-compatible endpoint. `provider` may differ from the
 * active one: Anthropic has no speech API, so the caller passes the fallback.
 */
export async function transcribe(
  config: ProviderConfig,
  audio: Blob,
  filename: string
): Promise<{ segments: TranscriptSegment[]; seconds: number }> {
  const provider = resolveProvider(config);
  if (!provider.supportsTranscription) {
    throw new ProviderError(
      `${provider.label} bietet keine Transkription. Hinterlege in den Einstellungen einen Groq- oder OpenAI-Schlüssel dafür.`,
      undefined,
      'config'
    );
  }
  requireKey(provider);

  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', provider.transcriptionModel);
  form.append('response_format', 'verbose_json');

  const response = await send(provider, '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form,
  });

  const payload = (await response.json()) as {
    text?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };

  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    const segments = payload.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text.trim(),
    }));
    // The endpoint reports the audio duration it actually processed; that is
    // the honest figure for how much was consumed, not the file's length.
    const seconds = payload.duration ?? segments[segments.length - 1]?.end ?? 0;
    return { segments, seconds };
  }

  // Endpoints that ignore `verbose_json` still return the plain text, which is
  // worth keeping even without timings.
  return {
    segments: payload.text ? [{ start: 0, end: 0, text: payload.text.trim() }] : [],
    seconds: payload.duration ?? 0,
  };
}

/** Cheap reachability check for the settings dialog. */
export async function checkProvider(config: ProviderConfig): Promise<string> {
  // An explicit test is the user saying "try again"; a remembered failure must
  // not answer for the endpoint.
  forgetProviderFailures();

  const provider = resolveProvider(config);
  requireKey(provider);

  const reply =
    provider.wire === 'anthropic'
      ? await anthropicMessage(provider, 'Antworte mit dem Wort OK.', [{ type: 'text', text: 'Test' }], 16)
      : await openAiChat(provider, provider.textModel, 'Antworte mit dem Wort OK.', [
          { type: 'text', text: 'Test' },
        ], false, 16);

  return reply.value.trim().slice(0, 40) || 'OK';
}

// MARK: - Wire formats

type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };

async function openAiChat(
  provider: ProviderDefaults & { apiKey: string },
  model: string,
  system: string,
  content: ContentPart[],
  jsonMode = false,
  maxTokens = 4096
): Promise<Measured<string>> {
  requireKey(provider);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: content.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image_url', image_url: { url: part.dataUrl } }
        ),
      },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await send(provider, '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  return {
    value: payload.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    },
  };
}

async function anthropicMessage(
  provider: ProviderDefaults & { apiKey: string },
  system: string,
  content: ContentPart[],
  maxTokens = 4096
): Promise<Measured<string>> {
  requireKey(provider);

  const response = await send(provider, '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      // Without this the browser's preflight is rejected by the API.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: provider.textModel,
      max_tokens: maxTokens,
      system,
      messages: [
        {
          role: 'user',
          content: content.map((part) => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            const [header, data] = part.dataUrl.split(',');
            const mediaType = header.slice(header.indexOf(':') + 1, header.indexOf(';'));
            return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
          }),
        },
      ],
    }),
  });

  const payload = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    value:
      payload.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? '',
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    },
  };
}

/**
 * Whether this provider could serve a request at all. Checked before the
 * pipeline starts the AI pass, so a missing key skips the pass instead of
 * failing once per chunk.
 */
export function isProviderConfigured(config: ProviderConfig): boolean {
  const provider = resolveProvider(config);
  // A local gateway usually needs no key, so only remote endpoints need one.
  return provider.apiKey !== '' || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(provider.baseUrl);
}

function requireKey(provider: ProviderDefaults & { apiKey: string }): void {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(provider.baseUrl);
  if (!provider.apiKey && !isLocal) {
    throw new ProviderError(
      `Für ${provider.label} ist kein API-Schlüssel hinterlegt. Einstellungen → KI-Anbieter.`,
      undefined,
      'config'
    );
  }
}

async function errorText(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (message) return `${response.status}: ${message}`;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return `${response.status}: ${body.slice(0, 200) || response.statusText}`;
}

/**
 * Models wrap JSON in prose or fences often enough that a bare `JSON.parse`
 * fails on otherwise good answers. This recovers the outermost object.
 */
function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // Fall through to the error below.
      }
    }
    throw new ProviderError('Die Antwort des Modells war kein gültiges JSON.', undefined, 'response');
  }
}

/** Drops anything malformed instead of letting it reach the graph. */
function normaliseExtraction(parsed: Record<string, unknown>): Extraction {
  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const entities: ExtractedEntity[] = [];
  const names = new Set<string>();

  for (const value of rawEntities) {
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '' || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());

    const type = typeof entry.type === 'string' ? entry.type.trim() : 'Topic';
    entities.push({
      name,
      // An unknown type would create a label nobody can style or query, so
      // anything off-list becomes a Topic.
      type: (ENTITY_LABELS as readonly string[]).includes(type) ? type : 'Topic',
      description: typeof entry.description === 'string' ? entry.description : undefined,
    });
  }

  const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];
  const relations: ExtractedRelation[] = [];

  for (const value of rawRelations) {
    const entry = value as Record<string, unknown>;
    const from = typeof entry.from === 'string' ? entry.from.trim() : '';
    const to = typeof entry.to === 'string' ? entry.to.trim() : '';
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    // A relation naming an entity that was not extracted has nothing to attach
    // to; keeping it would create ghost nodes with no properties.
    if (!from || !to || !type) continue;
    if (!names.has(from.toLowerCase()) || !names.has(to.toLowerCase())) continue;

    relations.push({
      from,
      to,
      type: type.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_|_$/g, '') || 'BEZIEHUNG',
      evidence: typeof entry.evidence === 'string' ? entry.evidence : undefined,
    });
  }

  return {
    entities,
    relations,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((value): value is string => typeof value === 'string')
      : [],
  };
}
