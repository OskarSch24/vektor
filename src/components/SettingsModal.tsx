import React, { useCallback, useEffect, useState } from 'react';
import {
  Blocks,
  Check,
  Gauge,
  Copy,
  Database,
  ExternalLink,
  FolderOpen,
  Eye,
  EyeOff,
  Film,
  Loader2,
  Plus,
  Radio,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Modal } from './Modal';
import { ProviderId, Settings } from '../types/settings';
import { emptyUsage } from '../services/settings';
import { GraphTarget, TargetKind } from '../types/targets';
import { PROVIDER_DEFAULTS, checkProvider } from '../services/ingest/ai';
import { checkTarget, describeTarget } from '../services/targets';
import {
  ToolStatus,
  files,
  ingestServer,
  isNativeHost,
  media,
  type BrowserExtensionBundleInfo,
} from '../services/nativeHost';
import { formatCount, formatRelativeTime } from '../lib/graph';
import { useBrowserExtensionStatus } from '../hooks/useBrowserExtensionStatus';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  serverRunning: boolean;
  serverPort: number;
  onServerChanged: (running: boolean, port: number) => void;
  onError: (message: string) => void;
}

type Section = 'provider' | 'targets' | 'video' | 'extension' | 'usage';

const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: 'provider', label: 'KI-Anbieter', icon: <Sparkles className="w-3.5 h-3.5" /> },
  { id: 'targets', label: 'Ziel-Datenbanken', icon: <Database className="w-3.5 h-3.5" /> },
  { id: 'video', label: 'Video', icon: <Film className="w-3.5 h-3.5" /> },
  { id: 'extension', label: 'Erweiterung', icon: <Blocks className="w-3.5 h-3.5" /> },
  { id: 'usage', label: 'Verbrauch', icon: <Gauge className="w-3.5 h-3.5" /> },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onChange,
  serverRunning,
  serverPort,
  onServerChanged,
  onError,
}) => {
  const [section, setSection] = useState<Section>('provider');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      className="max-w-3xl h-[min(680px,88vh)]"
      labelledBy="settings-title"
      header={
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <SettingsIcon className="w-4 h-4 text-apple-text-secondary shrink-0" />
          <h2 id="settings-title" className="text-sm font-semibold text-apple-text-primary">
            Einstellungen
          </h2>
        </div>
      }
    >
      <div className="flex gap-5 h-full -m-5 p-0">
        <nav className="w-44 shrink-0 border-r border-white/[0.06] p-3 space-y-0.5 select-none">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSection(entry.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                section === entry.id
                  ? 'bg-white/[0.08] text-white'
                  : 'text-apple-text-secondary hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 overflow-y-auto p-4 pr-5">
          {section === 'provider' && (
            <ProviderSection settings={settings} onChange={onChange} onError={onError} />
          )}
          {section === 'targets' && (
            <TargetsSection settings={settings} onChange={onChange} onError={onError} />
          )}
          {section === 'video' && <VideoSection settings={settings} onChange={onChange} />}
          {section === 'extension' && (
            <ExtensionSection
              settings={settings}
              onChange={onChange}
              serverRunning={serverRunning}
              serverPort={serverPort}
              onServerChanged={onServerChanged}
              onError={onError}
            />
          )}
          {section === 'usage' && <UsageSection settings={settings} onChange={onChange} />}
        </div>
      </div>
    </Modal>
  );
};

// MARK: - Provider

const ProviderSection: React.FC<{
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onError: (message: string) => void;
}> = ({ settings, onChange, onError }) => {
  const [showKey, setShowKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const activeId = settings.activeProvider;
  const config = settings.providers[activeId];
  const defaults = PROVIDER_DEFAULTS[activeId];

  const patchProvider = (patch: Partial<typeof config>) =>
    onChange({
      providers: { ...settings.providers, [activeId]: { ...config, ...patch, id: activeId } },
    });

  const runCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      setCheckResult(await checkProvider(config));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setCheckResult(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <Field
        label="Anbieter"
        hint="Für Entitätserkennung, Bildanalyse und Transkription. Die Vorgaben sind bewusst die günstigen Modelle."
      >
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(PROVIDER_DEFAULTS) as ProviderId[]).map((id) => (
            <button
              key={id}
              onClick={() => onChange({ activeProvider: id })}
              className={`flex items-center justify-between px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                activeId === id
                  ? 'bg-apple-blue/12 border-apple-blue/40 text-white'
                  : 'bg-white/[0.03] border-white/[0.08] text-apple-text-secondary hover:bg-white/[0.06]'
              }`}
            >
              <span>{PROVIDER_DEFAULTS[id].label}</span>
              {settings.providers[id].apiKey && <Check className="w-3 h-3 text-apple-green" />}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="API-Schlüssel"
        hint={
          defaults.keyUrl ? (
            <a
              href={defaults.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-apple-blue hover:underline"
            >
              Schlüssel bei {defaults.label} erzeugen
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          ) : (
            'Lokale Endpunkte brauchen meist keinen Schlüssel.'
          )
        }
      >
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={config.apiKey ?? ''}
              onChange={(e) => patchProvider({ apiKey: e.target.value })}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-black/30 border border-white/[0.08] rounded-lg pl-3 pr-9 py-1.5 text-xs font-mono text-apple-text-primary placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus"
            />
            <button
              onClick={() => setShowKey((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-apple-text-tertiary hover:text-white transition-colors"
              aria-label={showKey ? 'Schlüssel verbergen' : 'Schlüssel anzeigen'}
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button
            onClick={runCheck}
            disabled={checking}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors disabled:opacity-50"
          >
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Testen'}
          </button>
        </div>
        {checkResult && (
          <p className="mt-1.5 text-[11px] text-apple-green">Verbindung steht — Antwort: {checkResult}</p>
        )}
        <p className="mt-1.5 text-[11px] text-apple-text-muted">
          Der Schlüssel bleibt auf diesem Rechner und geht nur an {defaults.label} selbst.
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Textmodell">
          <TextInput
            value={config.textModel ?? ''}
            placeholder={defaults.textModel}
            onChange={(value) => patchProvider({ textModel: value })}
          />
        </Field>
        <Field label="Bildmodell">
          <TextInput
            value={config.visionModel ?? ''}
            placeholder={defaults.visionModel}
            onChange={(value) => patchProvider({ visionModel: value })}
          />
        </Field>
        <Field label="Transkriptionsmodell">
          <TextInput
            value={config.transcriptionModel ?? ''}
            placeholder={defaults.transcriptionModel || 'nicht unterstützt'}
            onChange={(value) => patchProvider({ transcriptionModel: value })}
            disabled={!defaults.supportsTranscription}
          />
        </Field>
        <Field label="Basis-URL">
          <TextInput
            value={config.baseUrl ?? ''}
            placeholder={defaults.baseUrl}
            onChange={(value) => patchProvider({ baseUrl: value })}
          />
        </Field>
      </div>

      {!defaults.supportsTranscription && (
        <p className="text-[11px] text-apple-amber">
          {defaults.label} hat keine Sprach-API. Für Videos wird auf den ersten anderen Anbieter mit
          hinterlegtem Schlüssel ausgewichen.
        </p>
      )}

      <label className="flex items-start gap-2.5 pt-1 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.offlineExtractionOnly}
          onChange={(e) => onChange({ offlineExtractionOnly: e.target.checked })}
          className="mt-0.5 accent-apple-blue"
        />
        <span>
          <span className="block text-xs text-apple-text-primary">Nur strukturelle Extraktion</span>
          <span className="block text-[11px] text-apple-text-muted">
            Keine KI-Aufrufe, keine Kosten. Es entstehen nur Knoten aus Metadaten, JSON-LD, Links,
            Hashtags und Schlüsselwörtern.
          </span>
        </span>
      </label>
    </div>
  );
};

// MARK: - Targets

const TargetsSection: React.FC<{
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onError: (message: string) => void;
}> = ({ settings, onChange, onError }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const addTarget = (kind: TargetKind) => {
    const target: GraphTarget = {
      id: `target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: kind === 'neo4j' ? 'Neo4j' : kind === 'file' ? 'Datei-Export' : 'Neuer Graph',
      kind,
      endpoint: kind === 'neo4j' ? 'http://localhost:7474' : undefined,
      database: kind === 'neo4j' ? 'neo4j' : undefined,
      username: kind === 'neo4j' ? 'neo4j' : undefined,
      createdAt: new Date().toISOString(),
      status: 'unknown',
    };
    onChange({
      targets: [...settings.targets, target],
      defaultTargetId: settings.defaultTargetId ?? target.id,
    });
    setEditingId(target.id);
  };

  const patchTarget = (id: string, patch: Partial<GraphTarget>) =>
    onChange({
      targets: settings.targets.map((target) =>
        target.id === id ? { ...target, ...patch } : target
      ),
    });

  const removeTarget = (id: string) =>
    onChange({
      targets: settings.targets.filter((target) => target.id !== id),
      defaultTargetId: settings.defaultTargetId === id ? null : settings.defaultTargetId,
    });

  const runCheck = async (target: GraphTarget) => {
    setCheckingId(target.id);
    try {
      const message = await checkTarget(target);
      patchTarget(target.id, { status: 'ok', statusMessage: message });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchTarget(target.id, { status: 'error', statusMessage: message });
      onError(`"${target.name}": ${message}`);
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-apple-text-muted leading-relaxed">
        Wohin ein Import geschrieben wird. Ohne konfiguriertes Ziel landet alles im Graphen, der
        gerade offen ist. Datenbanken, die nur Bolt sprechen — etwa Memgraph — werden über den
        Cypher-Export bedient.
      </p>

      <div className="flex gap-1.5">
        <AddButton onClick={() => addTarget('local')} label="Offener Graph" />
        <AddButton onClick={() => addTarget('neo4j')} label="Neo4j" />
        <AddButton onClick={() => addTarget('file')} label="Datei" />
      </div>

      <div className="space-y-2">
        {settings.targets.map((target) => (
          <div key={target.id} className="glass-card rounded-xl p-3">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  target.status === 'ok'
                    ? 'bg-apple-green'
                    : target.status === 'error'
                      ? 'bg-apple-red'
                      : 'bg-apple-text-muted'
                }`}
              />
              <input
                value={target.name}
                onChange={(e) => patchTarget(target.id, { name: e.target.value })}
                className="flex-1 bg-transparent text-xs font-medium text-apple-text-primary focus:outline-none min-w-0"
              />
              <span className="text-[10px] uppercase tracking-wider text-apple-text-muted shrink-0">
                {target.kind}
              </span>

              <button
                onClick={() => onChange({ defaultTargetId: target.id })}
                title="Als Standardziel verwenden"
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors shrink-0 ${
                  settings.defaultTargetId === target.id
                    ? 'text-apple-blue bg-apple-blue/12 border-apple-blue/30'
                    : 'text-apple-text-tertiary border-white/[0.08] hover:bg-white/[0.06]'
                }`}
              >
                Standard
              </button>

              <button
                onClick={() => setEditingId(editingId === target.id ? null : target.id)}
                className="p-1 rounded-md text-apple-text-tertiary hover:text-white hover:bg-white/[0.08] transition-colors shrink-0"
                aria-label="Ziel bearbeiten"
              >
                <SettingsIcon className="w-3 h-3" />
              </button>
              <button
                onClick={() => removeTarget(target.id)}
                className="p-1 rounded-md text-apple-text-tertiary hover:text-apple-red hover:bg-apple-red/10 transition-colors shrink-0"
                aria-label="Ziel entfernen"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>

            <p className="mt-1 pl-4 text-[11px] text-apple-text-tertiary truncate">
              {target.statusMessage ?? describeTarget(target)}
            </p>

            {editingId === target.id && target.kind !== 'local' && (
              <div className="mt-3 pl-4 space-y-2">
                {target.kind === 'neo4j' && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <TextInput
                        value={target.endpoint ?? ''}
                        placeholder="http://localhost:7474"
                        onChange={(value) => patchTarget(target.id, { endpoint: value })}
                      />
                      <TextInput
                        value={target.database ?? ''}
                        placeholder="neo4j"
                        onChange={(value) => patchTarget(target.id, { database: value })}
                      />
                      <TextInput
                        value={target.username ?? ''}
                        placeholder="Benutzer"
                        onChange={(value) => patchTarget(target.id, { username: value })}
                      />
                      <input
                        type="password"
                        value={target.password ?? ''}
                        onChange={(e) => patchTarget(target.id, { password: e.target.value })}
                        placeholder="Passwort"
                        autoComplete="off"
                        className="bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs font-mono text-apple-text-primary placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus"
                      />
                    </div>
                    <button
                      onClick={() => void runCheck(target)}
                      disabled={checkingId === target.id}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors disabled:opacity-50"
                    >
                      {checkingId === target.id ? 'Prüfe…' : 'Verbindung testen'}
                    </button>
                  </>
                )}

                {target.kind === 'file' && (
                  <TextInput
                    value={target.path ?? ''}
                    placeholder="/Pfad/zur/datei.graph — oder .cypher"
                    onChange={(value) => patchTarget(target.id, { path: value })}
                  />
                )}
              </div>
            )}
          </div>
        ))}

        {settings.targets.length === 0 && (
          <p className="py-6 text-center text-[11px] text-apple-text-muted">
            Kein Ziel konfiguriert — Importe gehen in den offenen Graphen.
          </p>
        )}
      </div>
    </div>
  );
};

// MARK: - Video

const VideoSection: React.FC<{
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}> = ({ settings, onChange }) => {
  const [tools, setTools] = useState<ToolStatus | null>(null);

  useEffect(() => {
    if (!isNativeHost()) return;
    void media.tools().then(setTools).catch(() => setTools(null));
  }, []);

  const estimatedFrames = Math.min(
    settings.limits.maxFramesPerVideo || 400,
    Math.floor(600 / settings.frameIntervalSeconds)
  );

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl p-3 space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
          Externe Werkzeuge
        </h3>
        {isNativeHost() ? (
          <>
            <ToolRow name="yt-dlp" path={tools?.ytdlp ?? null} />
            <ToolRow name="ffmpeg" path={tools?.ffmpeg ?? null} />
            <ToolRow name="ffprobe" path={tools?.ffprobe ?? null} />
            {tools && (!tools.ytdlp || !tools.ffmpeg) && (
              <p className="pt-1.5 text-[11px] text-apple-amber">
                Fehlt etwas? <span className="font-mono">brew install yt-dlp ffmpeg</span>
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-apple-text-muted">
            Videoverarbeitung gibt es nur in der App, nicht im Browser-Entwicklungsmodus.
          </p>
        )}
      </div>

      <Field
        label={`Bildabstand — alle ${settings.frameIntervalSeconds} s`}
        hint="Wie dicht das Video abgetastet wird. Kleiner heißt genauer und teurer."
      >
        <input
          type="range"
          min={2}
          max={60}
          step={1}
          value={settings.frameIntervalSeconds}
          onChange={(e) => onChange({ frameIntervalSeconds: Number(e.target.value) })}
          className="w-full accent-apple-blue"
        />
      </Field>

      <Field
        label={`Höchstens ${settings.limits.maxFramesPerVideo} Bilder pro Video`}
        hint={`Bei diesem Abstand sind das rund ${estimatedFrames} Bilder für ein 10-Minuten-Video.`}
      >
        <input
          type="range"
          min={4}
          max={200}
          step={4}
          value={settings.limits.maxFramesPerVideo}
          onChange={(e) =>
            onChange({ limits: { ...settings.limits, maxFramesPerVideo: Number(e.target.value) } })
          }
          className="w-full accent-apple-blue"
        />
      </Field>

      <p className="text-[11px] text-apple-text-muted leading-relaxed">
        Aus jedem ausgewerteten Bild wird ein <span className="font-mono">Scene</span>-Knoten mit
        Zeitstempel. Damit lässt sich später fragen, an welcher Stelle im Video etwas vorkommt.
      </p>
    </div>
  );
};

const ToolRow: React.FC<{ name: string; path: string | null }> = ({ name, path }) => (
  <div className="flex items-center gap-2 text-xs">
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${path ? 'bg-apple-green' : 'bg-apple-red'}`}
    />
    <span className="w-16 shrink-0 font-mono text-apple-text-secondary">{name}</span>
    <span className="flex-1 truncate font-mono text-[11px] text-apple-text-muted select-text">
      {path ?? 'nicht gefunden'}
    </span>
  </div>
);

// MARK: - Extension

const ExtensionSection: React.FC<{
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  serverRunning: boolean;
  serverPort: number;
  onServerChanged: (running: boolean, port: number) => void;
  onError: (message: string) => void;
}> = ({ settings, onChange, serverRunning, serverPort, onServerChanged, onError }) => {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [extension, setExtension] = useState<BrowserExtensionBundleInfo | null>(null);
  const connection = useBrowserExtensionStatus();

  const endpoint = `http://127.0.0.1:${serverPort}`;

  useEffect(() => {
    if (!isNativeHost()) return;
    void ingestServer.extensionInfo().then(setExtension).catch(() => undefined);
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      const status = serverRunning
        ? await ingestServer.stop()
        : await ingestServer.start(settings.ingestPort);
      onServerChanged(status.running, status.port);
      await connection.refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [connection.refresh, onError, onServerChanged, serverRunning, settings.ingestPort]);

  const connectionTitle =
    connection.state === 'connected'
      ? 'Browser-Erweiterung verbunden'
      : connection.state === 'listening'
        ? 'Bereit für Browser-Erweiterung'
        : connection.state === 'conflict'
          ? `Port durch ${connection.peer?.app || 'anderen Dienst'} belegt`
          : serverRunning
            ? 'Import-Server läuft'
            : 'Import-Server aus';

  const connectionDetail =
    connection.state === 'connected' && connection.lastSeenAt
      ? `Zuletzt gesehen ${formatRelativeTime(connection.lastSeenAt)}`
      : connection.state === 'listening'
        ? 'Der lokale Server lauscht; öffne die Erweiterung zum Verbinden.'
        : connection.error || endpoint;

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl p-3.5">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${
              serverRunning
                ? 'bg-apple-green/12 border-apple-green/30 text-apple-green'
                : 'bg-white/[0.04] border-white/[0.08] text-apple-text-tertiary'
            }`}
          >
            <Radio className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-apple-text-primary">
              {connectionTitle}
            </p>
            <p className="text-[11px] text-apple-text-tertiary truncate">{connectionDetail}</p>
          </div>
          <button
            onClick={() => void toggle()}
            disabled={busy || !isNativeHost()}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 ${
              serverRunning
                ? 'text-apple-red bg-apple-red/10 border-apple-red/30 hover:bg-apple-red/20'
                : 'text-apple-green bg-apple-green/10 border-apple-green/30 hover:bg-apple-green/20'
            }`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : serverRunning ? 'Stoppen' : 'Starten'}
          </button>
        </div>

        {!isNativeHost() && (
          <p className="mt-2 text-[11px] text-apple-amber">
            Im Browser-Entwicklungsmodus gibt es keinen Server — die Erweiterung braucht die App.
          </p>
        )}
      </div>

      <Field label="Port" hint="Muss mit dem Port in den Optionen der Erweiterung übereinstimmen.">
        <div className="flex gap-1.5">
          <input
            type="number"
            min={1024}
            max={65535}
            value={settings.ingestPort}
            onChange={(e) => onChange({ ingestPort: Number(e.target.value) })}
            className="w-28 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs font-mono text-apple-text-primary focus:outline-none focus:border-apple-border-focus"
          />
          <button
            onClick={() => {
              void navigator.clipboard.writeText(endpoint);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-apple-green" /> : <Copy className="w-3.5 h-3.5" />}
            Adresse kopieren
          </button>
        </div>
      </Field>

      <div className="glass-card rounded-xl p-3.5 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
              Erweiterung installieren
            </h3>
            {extension?.version && (
              <p className="mt-0.5 text-[10px] text-apple-text-muted">Version {extension.version}</p>
            )}
          </div>
          {extension?.available && (
            <button
              onClick={() => void files.reveal(extension.path).catch((error) => onError(String(error)))}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Im Finder zeigen
            </button>
          )}
        </div>
        <ol className="space-y-1.5 text-[11px] text-apple-text-secondary list-decimal list-inside leading-relaxed">
          <li>
            In Chrome <span className="font-mono text-apple-text-primary">chrome://extensions</span>{' '}
            öffnen
          </li>
          <li>Oben rechts den Entwicklermodus aktivieren</li>
          <li>
            „Entpackte Erweiterung laden“ und den eingeblendeten Ordner{' '}
            <span className="font-mono text-apple-text-primary">Browser Extension</span> wählen
          </li>
          <li>Auf einer beliebigen Seite auf das Symbol klicken und „Konvertieren“ wählen</li>
        </ol>
      </div>
    </div>
  );
};

// MARK: - Usage

/**
 * Measured consumption. Every figure here was reported by a provider or read
 * off a file — nothing is estimated, and there is no balance to top up. The
 * limits below are the actual guard against a runaway job.
 */
const UsageSection: React.FC<{
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}> = ({ settings, onChange }) => {
  const { usage, limits } = settings;
  const tokens = usage.inputTokens + usage.outputTokens;

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-apple-cyan/12 border border-apple-cyan/30 flex items-center justify-center text-apple-cyan shrink-0">
            <Gauge className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="text-2xl font-semibold text-apple-text-primary tabular-nums leading-none">
              {formatCount(tokens)}
            </p>
            <p className="mt-1 text-[11px] text-apple-text-tertiary">
              Token insgesamt — {formatCount(usage.inputTokens)} hinein,{' '}
              {formatCount(usage.outputTokens)} heraus
            </p>
          </div>
          <button
            onClick={() => onChange({ usage: emptyUsage() })}
            title="Setzt nur den Zähler zurück, nicht deinen Verbrauch beim Anbieter"
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors shrink-0"
          >
            Zähler zurücksetzen
          </button>
        </div>

        <dl className="mt-4 pt-3 border-t border-white/[0.06] grid grid-cols-2 gap-x-4 gap-y-2">
          <Measure label="Transkribiert" value={`${Math.round(usage.transcribedSeconds / 60)} Min.`} />
          <Measure label="Bilder ausgewertet" value={formatCount(usage.framesAnalysed)} />
          <Measure label="Anfragen" value={formatCount(usage.requests)} />
          <Measure
            label="davon fehlgeschlagen"
            value={formatCount(usage.failedRequests)}
            tone={usage.failedRequests > 0 ? 'warn' : undefined}
          />
        </dl>

        <p className="mt-3 text-[11px] text-apple-text-muted">
          Gezählt seit {formatRelativeTime(usage.since)}.
        </p>
      </div>

      <div className="glass-card rounded-xl p-3.5 space-y-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
          Grenzen — 0 heißt keine Grenze
        </h3>

        <Field
          label="Token je Auftrag"
          hint="Bricht die Textanalyse eines Auftrags ab, sobald so viele Token verbraucht sind. Der strukturelle Teil läuft weiter."
        >
          <input
            type="number"
            min={0}
            step={10000}
            value={limits.maxTokensPerJob}
            onChange={(e) =>
              onChange({ limits: { ...limits, maxTokensPerJob: Number(e.target.value) } })
            }
            className="w-40 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs font-mono text-apple-text-primary focus:outline-none focus:border-apple-border-focus"
          />
        </Field>

        <Field
          label="Längste Tonspur in Minuten"
          hint="Videos darüber werden nicht transkribiert. Bilder und Struktur trotzdem."
        >
          <input
            type="number"
            min={0}
            step={5}
            value={limits.maxTranscriptionMinutes}
            onChange={(e) =>
              onChange({ limits: { ...limits, maxTranscriptionMinutes: Number(e.target.value) } })
            }
            className="w-40 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs font-mono text-apple-text-primary focus:outline-none focus:border-apple-border-focus"
          />
        </Field>
      </div>

      <p className="text-[11px] text-apple-text-muted leading-relaxed">
        Was hier steht, ist eine Messung, keine Abrechnung: Die Zahlen kommen aus den Antworten
        deines Anbieters und laufen gegen deinen eigenen Schlüssel. Was das kostet, steht in deiner
        Abrechnung dort — diese App kennt keine Preise und erfindet auch keine.
      </p>
    </div>
  );
};

const Measure: React.FC<{ label: string; value: string; tone?: 'warn' }> = ({
  label,
  value,
  tone,
}) => (
  <div className="flex items-baseline justify-between gap-2">
    <dt className="text-[11px] text-apple-text-tertiary truncate">{label}</dt>
    <dd
      className={`text-xs font-mono tabular-nums shrink-0 ${
        tone === 'warn' ? 'text-apple-amber' : 'text-apple-text-primary'
      }`}
    >
      {value}
    </dd>
  </div>
);

// MARK: - Shared inputs

const Field: React.FC<{
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div>
    <label className="block mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
      {label}
    </label>
    {children}
    {hint && <p className="mt-1.5 text-[11px] text-apple-text-muted leading-relaxed">{hint}</p>}
  </div>
);

const TextInput: React.FC<{
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}> = ({ value, placeholder, disabled, onChange }) => (
  <input
    value={value}
    placeholder={placeholder}
    disabled={disabled}
    spellCheck={false}
    onChange={(e) => onChange(e.target.value)}
    className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs font-mono text-apple-text-primary placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus disabled:opacity-40"
  />
);

const AddButton: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors"
  >
    <Plus className="w-3.5 h-3.5 text-apple-blue" />
    {label}
  </button>
);
