import { GraphEdge, GraphNode, GraphSource } from '../../types/graph';
import { FrameAnalysis, IngestPayload, JobStage, TranscriptSegment } from '../../types/ingest';
import { Settings, Usage } from '../../types/settings';
import { GraphTarget } from '../../types/targets';
import { edgeId, entityId, formatDuration } from '../../lib/graph';
import { isNativeHost, media, siteMap } from '../nativeHost';
import { writeToTarget } from '../targets';
import { Extraction, extractGraph, analyseFrames, isProviderConfigured, transcribe } from './ai';
import { buildStructuralGraph } from './heuristics';
import { extractFromHtml } from './htmlExtract';

/**
 * One ingest run, end to end: raw payload in, subgraph written to a target out.
 *
 * The pipeline is written so every stage can fail without taking the run with
 * it. A video whose audio track cannot be transcribed still contributes its
 * frames; a page the model refuses to read still contributes its structure.
 * Only a failure to write to the target is fatal, because then nothing was
 * accomplished at all.
 */

export interface PipelineContext {
  settings: Settings;
  target: GraphTarget;
  jobId: string;
  onProgress: (stage: JobStage, progress: number | null, message: string) => void;
  /** Reports what a request actually consumed, as the provider measured it. */
  recordUsage: (delta: Partial<Usage>) => void;
  signal: AbortSignal;
}

export interface PipelineResult {
  nodesCreated: number;
  edgesCreated: number;
  /** What this run actually consumed — measured, not estimated. */
  usage: Partial<Usage>;
  source: GraphSource;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
}

/** Characters per chunk for the extraction pass; roughly 1500 tokens. */
const CHUNK_SIZE = 6000;

export async function runIngest(
  payload: IngestPayload,
  context: PipelineContext
): Promise<PipelineResult> {
  const { settings, target, onProgress, signal } = context;
  const warnings: string[] = [];

  // Everything this run consumed, accumulated from what the providers reported.
  const jobUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    transcribedSeconds: 0,
    framesAnalysed: 0,
    requests: 0,
    failedRequests: 0,
    since: new Date().toISOString(),
  };

  const record = (delta: Partial<Usage>) => {
    jobUsage.inputTokens += delta.inputTokens ?? 0;
    jobUsage.outputTokens += delta.outputTokens ?? 0;
    jobUsage.transcribedSeconds += delta.transcribedSeconds ?? 0;
    jobUsage.framesAnalysed += delta.framesAnalysed ?? 0;
    jobUsage.requests += delta.requests ?? 0;
    jobUsage.failedRequests += delta.failedRequests ?? 0;
    context.recordUsage(delta);
  };

  /**
   * A run has at most a handful of distinct problems, but each can occur once
   * per chunk or per frame batch. Collapsing duplicates keeps the banner
   * readable instead of repeating the same sentence five times.
   */
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  /** True while this job is still under its own token ceiling. */
  const withinTokenLimit = (): boolean => {
    const limit = settings.limits.maxTokensPerJob;
    if (limit === 0) return true;
    if (jobUsage.inputTokens + jobUsage.outputTokens < limit) return true;
    warn(
      `Die Token-Grenze für einen Auftrag (${limit.toLocaleString('de-DE')}) ist erreicht — ` +
        'der Rest lief ohne KI. Anpassbar unter Einstellungen → Verbrauch.'
    );
    return false;
  };

  // A payload from the extension already carries the page. One that came from
  // a pasted URL or from the site map carries only the address, so the page has
  // to be fetched before there is anything to extract.
  let material = payload;
  if (payload.kind !== 'video' && !payload.text && isNativeHost()) {
    onProgress('fetching', 0.05, 'Seite wird geladen');
    try {
      const page = await siteMap.fetchPage(payload.url);
      const parsed = extractFromHtml(page.html, page.url);

      // A page that ships a large document with almost no text in it builds its
      // content in the browser. Fetching the address can never see that, so say
      // so instead of writing a node with nothing in it and calling it done.
      // The host already renders a page whose server HTML is an empty shell.
      // Only when even that yields nothing is there something to say.
      const textLength = (parsed.text ?? '').length;
      if (textLength < 200 && page.bytes > 10_000) {
        warn(
          `"${parsed.title}" lieferte auch nach dem Rendern nur ${textLength} Zeichen Text — ` +
            'vermutlich eine Anmeldung, eine Zustimmungsabfrage oder eine Seite, die erst auf ' +
            'Eingaben reagiert. Öffne sie in Chrome und nutze die Erweiterung.'
        );
      }

      material = {
        ...parsed,
        kind: payload.kind,
        targetId: payload.targetId,
        // A title the caller supplied is the one the user saw; keep it.
        title: payload.title && payload.title !== payload.url ? payload.title : parsed.title,
      };
    } catch (err) {
      warn(`Seite konnte nicht geladen werden: ${messageOf(err)}`);
    }
  }

  onProgress('fetching', 0.1, 'Inhalt wird aufbereitet');
  const structural = buildStructuralGraph(material);
  const nodes = new Map(structural.nodes.map((node) => [node.id, node]));
  const edges = new Map(structural.edges.map((edge) => [edge.id, edge]));
  const rootId = structural.rootId;

  const addNode = (node: GraphNode) => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return;
    }
    for (const label of node.labels) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    for (const [key, value] of Object.entries(node.properties)) {
      if (existing.properties[key] === undefined) existing.properties[key] = value;
    }
  };

  const addEdge = (from: string, type: string, to: string, properties: GraphEdge['properties'] = {}) => {
    if (from === to) return;
    const id = edgeId(from, type, to);
    if (!edges.has(id)) edges.set(id, { id, type, from, to, properties });
  };

  let text = structural.text;
  let mediaPath: string | null = null;

  // MARK: - Video

  if (payload.kind === 'video' && payload.video) {
    try {
      const videoResult = await ingestVideo(payload, context, record, warn);
      mediaPath = videoResult.mediaPath;

      if (videoResult.transcript.length > 0) {
        const root = nodes.get(rootId);
        if (root) {
          root.properties.transcript = videoResult.transcript.map((s) => s.text).join(' ').slice(0, 20_000);
          root.properties.durationSeconds = videoResult.durationSeconds;
        }
        text = [text, '', 'Transkript:', formatTranscript(videoResult.transcript)].join('\n');
      }

      // Frames become their own nodes so a scene stays addressable — "zeig mir
      // die Stelle, an der X vorkommt" is the whole point of analysing them.
      for (const frame of videoResult.frames) {
        const sceneId = `${rootId}#t${Math.round(frame.timestamp)}`;
        addNode({
          id: sceneId,
          labels: ['Scene'],
          properties: {
            name: `${formatDuration(frame.timestamp)} — ${frame.description.slice(0, 60)}`,
            timestamp: frame.timestamp,
            description: frame.description,
            onScreenText: frame.onScreenText ?? '',
            url: `${payload.url}${payload.url.includes('?') ? '&' : '?'}t=${Math.round(frame.timestamp)}`,
          },
        });
        addEdge(rootId, 'ZEIGT_SZENE', sceneId, { timestamp: frame.timestamp });

        for (const entityName of frame.entities) {
          const clean = entityName.trim();
          if (clean.length < 2) continue;
          const topicId = entityId('Topic', clean);
          addNode({
            id: topicId,
            labels: ['Topic'],
            properties: { name: clean, source: 'frame' },
          });
          addEdge(sceneId, 'ZEIGT', topicId);
        }
      }

      if (videoResult.frames.length > 0) {
        text = [
          text,
          '',
          'Bildbeschreibungen:',
          videoResult.frames
            .map((frame) => `[${formatDuration(frame.timestamp)}] ${frame.description}`)
            .join('\n'),
        ].join('\n');
      }
    } catch (err) {
      warn(`Videoverarbeitung fehlgeschlagen: ${messageOf(err)}`);
    }
  }

  throwIfAborted(signal);

  // MARK: - Entity extraction

  const provider = settings.providers[settings.activeProvider];
  // Without a key there is nothing to ask, so the pass is skipped rather than
  // attempted and failed once per chunk. The structural graph above is already
  // complete at this point — for a page with JSON-LD it is most of the result.
  const canUseAi = !settings.offlineExtractionOnly && isProviderConfigured(provider);

  if (canUseAi && text.trim().length > 120) {
    onProgress('extracting', 0.6, 'Entitäten werden erkannt');
    const chunks = chunkText(text, CHUNK_SIZE);

    for (let i = 0; i < chunks.length; i += 1) {
      throwIfAborted(signal);
      if (!withinTokenLimit()) break;

      onProgress(
        'extracting',
        0.6 + (0.25 * i) / chunks.length,
        `Entitäten werden erkannt (${i + 1}/${chunks.length})`
      );

      try {
        const measured = await extractGraph(provider, chunks[i], {
          title: material.title,
          url: material.url,
          kind: material.kind,
        });
        record({ ...measured.usage, requests: 1 });
        applyExtraction(measured.value, rootId, addNode, addEdge, i === 0 ? nodes.get(rootId) : undefined);
      } catch (err) {
        // A call the circuit breaker stopped never reached the network: it is
        // not a request, and it is not news either — the failure it rests on
        // was reported when it happened. Only a fresh failure gets a warning.
        if (reachedNetwork(err)) {
          record({ requests: 1, failedRequests: 1 });
          warn(`Textanalyse: ${messageOf(err)}`);
        }
        // A provider that is down, misconfigured or out of quota will fail
        // every remaining chunk the same way; stopping saves a wall of
        // identical warnings and, on metered plans, a series of failed calls.
        if (isFatalProviderError(err)) break;
      }
    }
  } else if (!settings.offlineExtractionOnly && !isProviderConfigured(provider)) {
    warn(
      'Ohne API-Schlüssel lief nur die strukturelle Extraktion: Metadaten, JSON-LD, Autor, ' +
        'Links und Schlagwörter. Personen, Organisationen und Beziehungen aus dem Fließtext ' +
        'brauchen einen Schlüssel (Einstellungen → KI-Anbieter).'
    );
  }

  // MARK: - Write

  throwIfAborted(signal);
  onProgress('writing', 0.92, `Wird nach "${target.name}" geschrieben`);

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];

  const source: GraphSource = {
    id: rootId,
    kind: material.kind,
    url: material.url,
    title: material.title,
    ingestedAt: new Date().toISOString(),
    nodeIds: nodeList.map((node) => node.id),
  };

  const written = await writeToTarget(target, nodeList, edgeList, source);

  if (mediaPath) {
    // The downloaded file is only needed while the job runs; leaving gigabytes
    // of video in the cache directory would be a rude thing to do.
    await media.cleanup(mediaPath).catch(() => undefined);
  }

  onProgress('done', 1, `${written.nodesWritten} Knoten, ${written.edgesWritten} Kanten`);

  return {
    nodesCreated: written.nodesWritten,
    edgesCreated: written.edgesWritten,
    usage: jobUsage,
    warnings,
    source,
  };
}

// MARK: - Video stages

interface VideoOutcome {
  mediaPath: string | null;
  transcript: TranscriptSegment[];
  frames: FrameAnalysis[];
  durationSeconds: number;
}

async function ingestVideo(
  payload: IngestPayload,
  context: PipelineContext,
  record: (delta: Partial<Usage>) => void,
  warn: (message: string) => void
): Promise<VideoOutcome> {
  const { settings, onProgress, signal, jobId } = context;

  const tools = await media.tools();
  if (!tools.ytdlp) {
    throw new Error('yt-dlp wurde nicht gefunden. Installieren mit: brew install yt-dlp');
  }
  if (!tools.ffmpeg) {
    throw new Error('ffmpeg wurde nicht gefunden. Installieren mit: brew install ffmpeg');
  }

  onProgress('downloading', null, 'Video wird geladen');
  const download = await media.download(jobId, payload.video?.pageUrl ?? payload.url);
  throwIfAborted(signal);

  const outcome: VideoOutcome = {
    mediaPath: download.path,
    transcript: [],
    frames: [],
    durationSeconds: download.durationSeconds,
  };

  if (settings.offlineExtractionOnly) return outcome;

  // MARK: Transcription

  const minutes = Math.ceil(download.durationSeconds / 60);
  const minuteLimit = settings.limits.maxTranscriptionMinutes;

  if (minuteLimit > 0 && minutes > minuteLimit) {
    warn(
      `Das Video ist ${minutes} Minuten lang und überschreitet die Grenze von ${minuteLimit} ` +
        'Minuten für die Transkription. Anpassbar unter Einstellungen → Verbrauch.'
    );
  } else {
    onProgress('transcribing', null, `Tonspur wird transkribiert (${formatDuration(download.durationSeconds)})`);
    try {
      const audio = await media.extractAudio(download.path);
      throwIfAborted(signal);

      const response = await fetch(audio.url);
      if (!response.ok) throw new Error(`Tonspur nicht lesbar (HTTP ${response.status})`);
      const blob = await response.blob();

      // Anthropic has no speech endpoint, so transcription falls back to the
      // first configured provider that does.
      const provider = transcriptionProvider(settings);
      const result = await transcribe(provider, blob, audio.filename);
      outcome.transcript = result.segments;
      // The endpoint reports the seconds it processed; that is what to count.
      record({ transcribedSeconds: result.seconds, requests: 1 });
    } catch (err) {
      if (reachedNetwork(err)) {
        record({ requests: 1, failedRequests: 1 });
        warn(`Transkription fehlgeschlagen: ${messageOf(err)}`);
      }
    }
  }

  throwIfAborted(signal);

  // MARK: Frames

  onProgress('analysing', null, 'Einzelbilder werden ausgewertet');
  try {
    const sampled = await media.extractFrames(
      download.path,
      settings.frameIntervalSeconds,
      settings.limits.maxFramesPerVideo || 400
    );
    throwIfAborted(signal);

    if (sampled.frames.length > 0) {
      const measured = await analyseFrames(
        settings.providers[settings.activeProvider],
        sampled.frames,
        (done, total) =>
          onProgress('analysing', done / total, `Einzelbilder werden ausgewertet (${done}/${total})`)
      );
      outcome.frames = measured.value;
      record({
        ...measured.usage,
        framesAnalysed: sampled.frames.length,
        requests: Math.ceil(sampled.frames.length / 4),
      });
    }
  } catch (err) {
    if (reachedNetwork(err)) {
      record({ requests: 1, failedRequests: 1 });
      warn(`Bildanalyse fehlgeschlagen: ${messageOf(err)}`);
    }
  }

  return outcome;
}

function transcriptionProvider(settings: Settings) {
  const active = settings.providers[settings.activeProvider];
  if (settings.activeProvider !== 'anthropic') return active;

  for (const id of ['groq', 'openai', 'custom'] as const) {
    const candidate = settings.providers[id];
    if (candidate.apiKey) return candidate;
  }
  return active;
}

// MARK: - Helpers

function applyExtraction(
  extraction: Extraction,
  rootId: string,
  addNode: (node: GraphNode) => void,
  addEdge: (from: string, type: string, to: string, properties?: GraphEdge['properties']) => void,
  root?: GraphNode
): void {
  if (root && extraction.summary) root.properties.summary = extraction.summary;

  const idByName = new Map<string, string>();

  for (const entity of extraction.entities) {
    const id = entityId(entity.type, entity.name);
    idByName.set(entity.name.toLowerCase(), id);
    addNode({
      id,
      labels: [entity.type],
      properties: {
        name: entity.name,
        description: entity.description ?? '',
        source: 'ki',
      },
    });
    addEdge(rootId, 'NENNT', id);
  }

  for (const relation of extraction.relations) {
    const from = idByName.get(relation.from.toLowerCase());
    const to = idByName.get(relation.to.toLowerCase());
    if (!from || !to) continue;
    addEdge(from, relation.type, to, relation.evidence ? { evidence: relation.evidence } : {});
  }

  for (const topic of extraction.topics) {
    const id = entityId('Topic', topic);
    addNode({ id, labels: ['Topic'], properties: { name: topic, source: 'ki' } });
    addEdge(rootId, 'HANDELT_VON', id);
  }
}

/** Splits on paragraph boundaries so a sentence is never cut in half. */
function chunkText(text: string, size: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > size && current !== '') {
      chunks.push(current.trim());
      current = '';
    }
    // A single paragraph longer than the budget is split on its own; better a
    // hard cut than an oversized request the provider rejects.
    if (paragraph.length > size) {
      for (let i = 0; i < paragraph.length; i += size) {
        chunks.push(paragraph.slice(i, i + size));
      }
      continue;
    }
    current += `${paragraph}\n\n`;
  }

  if (current.trim() !== '') chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 40);
}

function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => (segment.end > 0 ? `[${formatDuration(segment.start)}] ${segment.text}` : segment.text))
    .join('\n');
}

/**
 * Whether a further chunk could plausibly succeed. Everything except a bad
 * answer to one particular request is decided for the whole run: a missing key,
 * an unreachable endpoint, a rejected key, an exhausted quota and a provider
 * outage all fail the next chunk exactly as they failed this one.
 */
function isFatalProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    // A bare network rejection — "Load failed" — arrives as a TypeError.
    return true;
  }
  const failure = (err as { failure?: string }).failure;
  if (failure) return failure !== 'response';
  return err.name === 'TypeError';
}

/** True when a request actually went out, so it belongs in the usage counters. */
function reachedNetwork(err: unknown): boolean {
  if (err instanceof Error && 'reachedNetwork' in err) {
    return (err as { reachedNetwork: boolean }).reachedNetwork;
  }
  return true;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
