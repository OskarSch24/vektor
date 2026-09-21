import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock,
  Eraser,
  Link as LinkIcon,
  Loader2,
  Network,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { IngestJob, IngestPayload, JobStage } from '../types/ingest';
import { GraphTarget } from '../types/targets';
import { formatCount, formatRelativeTime, hostOf } from '../lib/graph';
import { MappedUrl, SiteMapResult, isNativeHost, siteMap } from '../services/nativeHost';
import { socialPlatform } from '../lib/socialSites';

interface IngestPanelProps {
  jobs: IngestJob[];
  targets: GraphTarget[];
  defaultTargetId: string | null;
  onEnqueue: (payload: IngestPayload) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onClearFinished: () => void;
  serverRunning: boolean;
  serverPort: number;
  onError: (message: string) => void;
  /** Informational message — a map that started, not a problem. */
  onNotice: (message: string) => void;
  onCancelAll: () => void;
  /** A whole-site request from the extension, with its chosen destination. */
  pendingMap: { url: string; targetId?: string; targetPath?: string } | null;
  onMapConsumed: () => void;
}

const STAGE_LABEL: Record<JobStage, string> = {
  queued: 'Wartet',
  fetching: 'Wird aufbereitet',
  downloading: 'Video wird geladen',
  transcribing: 'Wird transkribiert',
  analysing: 'Bilder werden ausgewertet',
  extracting: 'Entitäten werden erkannt',
  writing: 'Wird geschrieben',
  done: 'Fertig',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
};

const RUNNING_STAGES: JobStage[] = [
  'fetching',
  'downloading',
  'transcribing',
  'analysing',
  'extracting',
  'writing',
];

/**
 * The import tab: everything the extension sent over, plus a field for pasting
 * a URL directly — the app has to be usable without the extension installed.
 */
export const IngestPanel: React.FC<IngestPanelProps> = ({
  jobs,
  targets,
  defaultTargetId,
  onEnqueue,
  onCancel,
  onRetry,
  onClearFinished,
  serverRunning,
  serverPort,
  onError,
  onNotice,
  onCancelAll,
  pendingMap,
  onMapConsumed,
}) => {
  const [url, setUrl] = useState('');
  const [targetId, setTargetId] = useState(defaultTargetId ?? '');
  const [isMapping, setIsMapping] = useState(false);
  const [map, setMap] = useState<SiteMapResult | null>(null);
  const [mapFilter, setMapFilter] = useState('');

  /**
   * Lists the addresses a site publishes, so a whole section can be taken in
   * one go. The sitemap is preferred over crawling: it is the list the site
   * operator maintains, so it is both more complete and less intrusive.
   */
  const runMap = useCallback(
    async (target: string, destination?: { targetId?: string; targetPath?: string }) => {
      const trimmed = target.trim();
      if (trimmed === '') return;
      if (!isNativeHost()) {
        onError('Website abbilden gibt es nur in der App, nicht im Browser-Entwicklungsmodus.');
        return;
      }

      // The authoritative check. The extension disables its toggle for these
      // too, but a request that arrives anyway is refused here.
      const platform = socialPlatform(trimmed);
      if (platform) {
        onError(
          `Für ${platform} ist „Ganze Website“ abgeschaltet: Die Plattform hat keine ` +
            'abzählbare Menge an Seiten, und das meiste davon steht hinter einer Anmeldung. ' +
            'Einzelne Beiträge lassen sich weiterhin ganz normal konvertieren.'
        );
        return;
      }

      setIsMapping(true);
      setMap(null);
      try {
        const result = await siteMap.discover(
          trimmed.startsWith('http') ? trimmed : `https://${trimmed}`,
          500
        );
        setMap(result);

        if (result.urls.length === 0) {
          onError(`Unter "${trimmed}" wurden keine weiteren Seiten gefunden.`);
          return;
        }

        // Whole-site means the whole site: everything found goes into the queue
        // straight away. The list below stays on screen so the run is visible
        // and can be stopped.
        for (const entry of result.urls) {
          onEnqueue({
            kind: 'website',
            url: entry.url,
            title: entry.url,
            // The extension's choice wins; the panel's own picker is the
            // fallback for a map started from inside the app.
            targetId: destination?.targetId ?? (targetId || undefined),
            targetPath: destination?.targetPath,
            capturedAt: new Date().toISOString(),
          });
        }

        onNotice(
          `${result.urls.length} Seiten von ${hostOf(result.urls[0].url)} gefunden — ` +
            'sie werden nacheinander verarbeitet. „Alle abbrechen“ stoppt den Lauf.'
        );
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsMapping(false);
      }
    },
    [onEnqueue, onError, onNotice, targetId]
  );

  // The extension can ask for a map instead of a single conversion.
  useEffect(() => {
    if (!pendingMap) return;
    setUrl(pendingMap.url);
    void runMap(pendingMap.url, { targetId: pendingMap.targetId, targetPath: pendingMap.targetPath });
    onMapConsumed();
  }, [pendingMap, runMap, onMapConsumed]);

  const visibleUrls = useMemo(() => {
    if (!map) return [];
    const needle = mapFilter.trim().toLowerCase();
    return needle === ''
      ? map.urls
      : map.urls.filter((entry) => entry.url.toLowerCase().includes(needle));
  }, [map, mapFilter]);


  const submit = () => {
    const trimmed = url.trim();
    if (trimmed === '') return;

    let parsed: URL;
    try {
      parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    } catch {
      return;
    }

    onEnqueue({
      kind: isVideoUrl(parsed) ? 'video' : 'website',
      url: parsed.toString(),
      title: parsed.hostname + parsed.pathname,
      targetId: targetId || undefined,
      capturedAt: new Date().toISOString(),
      video: isVideoUrl(parsed)
        ? { platform: hostOf(parsed.toString()), pageUrl: parsed.toString() }
        : undefined,
    });
    setUrl('');
  };

  const finishedCount = jobs.filter((job) =>
    ['done', 'failed', 'cancelled'].includes(job.stage)
  ).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="px-5 py-4 border-b border-apple-border-subtle shrink-0 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-apple-text-tertiary pointer-events-none" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="URL einfügen — Website, Video oder Social-Media-Post"
              className="w-full bg-black/30 border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs text-apple-text-primary placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus focus:ring-1 focus:ring-apple-blue/30 transition-colors"
            />
          </div>

          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-apple-text-primary focus:outline-none focus:border-apple-border-focus max-w-[200px]"
          >
            <option value="">Offener Graph</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => void runMap(url)}
            disabled={url.trim() === '' || isMapping}
            title="Alle Adressen dieser Website auflisten, dann auswählen"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] disabled:opacity-40 transition-colors"
          >
            {isMapping ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Network className="w-3.5 h-3.5 text-apple-purple" />
            )}
            Abbilden
          </button>

          <button
            onClick={submit}
            disabled={url.trim() === ''}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white bg-apple-blue hover:bg-apple-blue-hover disabled:opacity-40 disabled:hover:bg-apple-blue transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Konvertieren
          </button>
        </div>

        <p className="text-[11px] text-apple-text-tertiary">
          {serverRunning ? (
            <>
              Die Chrome-Erweiterung sendet an{' '}
              <span className="font-mono text-apple-green">http://127.0.0.1:{serverPort}</span>.
            </>
          ) : (
            <>
              Der Import-Server läuft nicht — die Erweiterung erreicht die App gerade nicht.
              Einstellungen → Erweiterung.
            </>
          )}
        </p>
      </div>

      {map && (
        <section className="shrink-0 border-b border-apple-border-subtle max-h-[46%] flex flex-col">
          <header className="flex items-center gap-2 px-5 py-2 shrink-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
              Gefundene Seiten
              <span className="ml-1.5 font-mono text-apple-text-muted">
                {formatCount(map.urls.length)}
              </span>
            </h2>

            <span className="text-[10px] text-apple-text-muted">
              {map.via === 'sitemap'
                ? `aus ${map.sitemaps.length} Sitemap${map.sitemaps.length === 1 ? '' : 's'}`
                : map.via === 'crawl'
                  ? 'aus den Links der Startseite — die Website hat keine Sitemap'
                  : 'nichts gefunden'}
              {map.truncated && ' · Liste gekürzt'}
            </span>

            <div className="flex-1" />

            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-apple-text-tertiary pointer-events-none" />
              <input
                value={mapFilter}
                onChange={(e) => setMapFilter(e.target.value)}
                placeholder="filtern…"
                className="w-40 bg-black/30 border border-white/[0.08] rounded-md pl-6 pr-2 py-1 text-[11px] text-apple-text-primary placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus"
              />
            </div>

            <button
              onClick={() => setMap(null)}
              title="Liste schließen"
              className="p-1 rounded-md text-apple-text-tertiary hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto min-h-0 px-3 pb-2">
            {visibleUrls.map((entry) => (
              <MapRow key={entry.url} entry={entry} />
            ))}
            {visibleUrls.length === 0 && (
              <p className="px-2 py-3 text-[11px] text-apple-text-muted">Kein Treffer.</p>
            )}
          </div>

          <footer className="flex items-center gap-2 px-5 py-2 border-t border-apple-border-subtle shrink-0">
            <span className="text-[11px] text-apple-text-secondary">
              Alle {formatCount(map.urls.length)} Seiten sind in der Warteschlange.
            </span>
            <div className="flex-1" />
            <button
              onClick={onCancelAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-apple-red/15 hover:text-apple-red border border-white/[0.08] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Alle abbrechen
            </button>
          </footer>
        </section>
      )}

      <div className="flex items-center justify-between px-5 py-2 border-b border-apple-border-subtle shrink-0 select-none">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
          Aufträge
          <span className="ml-1.5 font-mono text-apple-text-muted">{jobs.length}</span>
        </h2>
        {finishedCount > 0 && (
          <button
            onClick={onClearFinished}
            className="flex items-center gap-1.5 text-[11px] text-apple-text-secondary hover:text-white transition-colors"
          >
            <Eraser className="w-3 h-3" />
            Abgeschlossene entfernen
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
        {jobs.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center px-8">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-3">
              <Clock className="w-5 h-5 text-apple-text-tertiary" />
            </div>
            <p className="text-xs text-apple-text-secondary">Noch keine Importe.</p>
            <p className="mt-1 text-[11px] text-apple-text-muted max-w-sm">
              Öffne eine Seite in Chrome, klicke auf das Vektor-Symbol und wähle
              „Konvertieren“ — oder füge oben direkt eine URL ein.
            </p>
          </div>
        )}

        {jobs.map((job) => (
          <JobRow key={job.id} job={job} onCancel={onCancel} onRetry={onRetry} />
        ))}
      </div>
    </div>
  );
};

const MapRow: React.FC<{ entry: MappedUrl }> = ({ entry }) => {
  let path = entry.url;
  try {
    const parsed = new URL(entry.url);
    path = parsed.pathname === '/' ? '/' : parsed.pathname + parsed.search;
  } catch {
    // Keep the raw string if it will not parse.
  }

  return (
    <div
      title={entry.url}
      className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left"
    >
      <span className="flex-1 text-[11px] font-mono truncate text-apple-text-secondary">
        {path}
      </span>
      {entry.lastModified && (
        <span className="text-[10px] text-apple-text-muted shrink-0 tabular-nums">
          {entry.lastModified.slice(0, 10)}
        </span>
      )}
    </div>
  );
};

const JobRow: React.FC<{
  job: IngestJob;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}> = ({ job, onCancel, onRetry }) => {
  const running = RUNNING_STAGES.includes(job.stage) || job.stage === 'queued';

  return (
    <article className="glass-card rounded-xl px-3.5 py-3">
      <div className="flex items-start gap-3">
        <StageIcon stage={job.stage} />

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="text-xs font-medium text-apple-text-primary truncate">
              {job.payload.title || job.payload.url}
            </h3>
            <span className="text-[10px] uppercase tracking-wider text-apple-text-muted shrink-0">
              {job.payload.kind}
            </span>
          </div>

          <p className="mt-0.5 text-[11px] text-apple-text-tertiary truncate" title={job.payload.url}>
            {hostOf(job.payload.url)} · {formatRelativeTime(job.createdAt)}
            {job.tokensUsed ? ` · ${formatCount(job.tokensUsed)} Token` : ''}
          </p>

          {running && (
            <div className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden relative">
              {job.progress === null ? (
                <div className="progress-sweep absolute inset-0" />
              ) : (
                <div
                  className="h-full bg-apple-blue rounded-full transition-[width] duration-300"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              )}
            </div>
          )}

          <p
            className={`mt-1.5 text-[11px] ${
              job.stage === 'failed'
                ? 'text-apple-red select-text'
                : job.stage === 'done'
                  ? 'text-apple-green'
                  : 'text-apple-text-secondary'
            }`}
          >
            {job.error ?? `${STAGE_LABEL[job.stage]}${job.message ? ` — ${job.message}` : ''}`}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-1">
          {running && (
            <button
              onClick={() => onCancel(job.id)}
              title="Auftrag abbrechen"
              className="p-1.5 rounded-md text-apple-text-secondary hover:text-apple-red hover:bg-apple-red/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {(job.stage === 'failed' || job.stage === 'cancelled') && (
            <button
              onClick={() => onRetry(job.id)}
              title="Erneut versuchen"
              className="p-1.5 rounded-md text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
};

const StageIcon: React.FC<{ stage: JobStage }> = ({ stage }) => {
  const base = 'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border';

  if (stage === 'done') {
    return (
      <div className={`${base} bg-apple-green/12 border-apple-green/30 text-apple-green`}>
        <Check className="w-3.5 h-3.5" />
      </div>
    );
  }
  if (stage === 'failed') {
    return (
      <div className={`${base} bg-apple-red/12 border-apple-red/30 text-apple-red`}>
        <AlertCircle className="w-3.5 h-3.5" />
      </div>
    );
  }
  if (stage === 'cancelled') {
    return (
      <div className={`${base} bg-white/[0.04] border-white/[0.08] text-apple-text-tertiary`}>
        <X className="w-3.5 h-3.5" />
      </div>
    );
  }
  if (stage === 'queued') {
    return (
      <div className={`${base} bg-white/[0.04] border-white/[0.08] text-apple-text-tertiary`}>
        <Clock className="w-3.5 h-3.5" />
      </div>
    );
  }
  return (
    <div className={`${base} bg-apple-blue/12 border-apple-blue/30 text-apple-blue`}>
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
    </div>
  );
};

/** Hosts whose pages are treated as video by default. */
function isVideoUrl(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, '');
  const videoHosts = [
    'youtube.com',
    'youtu.be',
    'tiktok.com',
    'vimeo.com',
    'twitch.tv',
    'dailymotion.com',
  ];
  if (videoHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
    return true;
  }
  // Instagram and X host both posts and videos; the path says which.
  return /\/(reel|reels|video|shorts|status)\//.test(url.pathname);
}
