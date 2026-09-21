import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Eye,
  EyeOff,
  Play,
  Plug,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  apiServer,
  clearLog,
  subscribeToLog,
  subscribeToStatus,
  type ApiLogEntry,
  type ApiServerStatus,
} from '../services/api/host';

/**
 * The API tab: the switch that opens the port, the credentials another tool
 * needs, and the live log of what those tools are doing.
 *
 * The log is the reason this is a tab rather than a settings sheet. When an
 * agent is working on the open graph, the interesting thing is watching the
 * calls arrive — which query, how many nodes, how long — while the canvas next
 * to it shows the same graph.
 */

interface ApiPanelProps {
  /** Shown in the examples, so a copied curl line targets a real label. */
  sampleLabel?: string | null;
}

const StatusDot: React.FC<{ running: boolean }> = ({ running }) => (
  <span className="relative flex h-2 w-2">
    {running && (
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-apple-green opacity-60" />
    )}
    <span
      className={`relative inline-flex h-2 w-2 rounded-full ${
        running ? 'bg-apple-green' : 'bg-apple-text-muted'
      }`}
    />
  </span>
);

const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={label ?? 'Kopieren'}
      className="flex items-center space-x-1 text-[11px] font-medium text-apple-text-secondary hover:text-white bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] px-2 py-1 rounded-md transition-colors shrink-0"
    >
      {copied ? <Check className="w-3 h-3 text-apple-green" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? 'Kopiert' : label ?? 'Kopieren'}</span>
    </button>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3 py-1.5">
    <span className="text-[11px] uppercase tracking-wider text-apple-text-tertiary shrink-0">
      {label}
    </span>
    <div className="flex items-center gap-2 min-w-0">{children}</div>
  </div>
);

export const ApiPanel: React.FC<ApiPanelProps> = ({ sampleLabel }) => {
  const [status, setStatus] = useState<ApiServerStatus>(() => ({
    available: false,
    running: false,
    port: 0,
    token: '',
    descriptorPath: '',
    allowWrites: false,
  }));
  const [log, setLog] = useState<ApiLogEntry[]>([]);
  const [portDraft, setPortDraft] = useState('');
  const [portDirty, setPortDirty] = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => subscribeToStatus(setStatus), []);
  useEffect(() => subscribeToLog(setLog), []);

  // The field follows the host until the user types in it, so a port changed
  // elsewhere still shows up.
  useEffect(() => {
    if (status.port > 0 && !portDirty) setPortDraft(String(status.port));
  }, [portDirty, status.port]);

  const baseUrl = `http://127.0.0.1:${status.port || 8793}`;
  const token = status.token || '<token>';

  const examples = useMemo(
    () => [
      {
        title: 'Ontologie lesen',
        command: `curl -s ${baseUrl}/api/v1/graph/schema -H "Authorization: Bearer ${token}"`,
      },
      {
        title: 'Abfrage ausführen',
        command:
          `curl -s ${baseUrl}/api/v1/graph/query -H "Authorization: Bearer ${token}" \\\n` +
          `  -H "Content-Type: application/json" \\\n` +
          `  -d '{"query":"MATCH (a:${sampleLabel ?? 'Person'})-[r]->(b) RETURN a, r, b LIMIT 25"}'`,
      },
      {
        title: 'Knoten eines Labels',
        command:
          `curl -s "${baseUrl}/api/v1/graph/nodes?label=${sampleLabel ?? 'Person'}&limit=20" \\\n` +
          `  -H "Authorization: Bearer ${token}"`,
      },
    ],
    [baseUrl, token, sampleLabel]
  );

  const endpoints: Array<[string, string]> = [
    ['GET    /api/v1/graph/health', 'Läuft die App, welcher Graph ist offen'],
    ['GET    /api/v1/graph/schema', 'Labels, Beziehungstypen, Eigenschaftsschlüssel'],
    ['GET    /api/v1/graph/graph', 'Der ganze Graph als .graph-Dokument'],
    ['GET    /api/v1/graph/sources', 'Woher der Inhalt stammt, pro Ingest-Lauf'],
    ['GET    /api/v1/graph/nodes', 'Knoten, mit label, search, limit, offset'],
    ['GET    /api/v1/graph/nodes/:id', 'Ein Knoten samt anliegender Kanten'],
    ['GET    /api/v1/graph/nodes/:id/neighbours', 'Nachbarn eines Knotens'],
    ['GET    /api/v1/graph/edges', 'Kanten, mit type, from, to, limit, offset'],
    ['POST   /api/v1/graph/query', '{ query } — die Cypher-Teilmenge der App'],
    ['POST   /api/v1/graph/nodes', '{ id?, labels, properties } — anlegen/ergänzen'],
    ['PATCH  /api/v1/graph/nodes/:id', '{ properties } — Werte überschreiben'],
    ['DELETE /api/v1/graph/nodes/:id', 'Knoten samt Kanten entfernen'],
    ['POST   /api/v1/graph/edges', '{ type, from, to, properties? }'],
    ['DELETE /api/v1/graph/edges/:id', 'Kante entfernen'],
    ['POST   /api/v1/graph/open', '{ path } — .graph-Datei in die Sitzung laden'],
  ];

  if (!status.available) {
    return (
      <div className="flex-1 h-full overflow-y-auto p-6 bg-[#0A0C11] text-xs select-text">
        <div className="max-w-2xl mx-auto mt-16 p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] text-center space-y-2">
          <Plug className="w-6 h-6 text-apple-text-muted mx-auto" />
          <h2 className="text-sm font-semibold text-white">API nur in der App</h2>
          <p className="text-apple-text-secondary leading-relaxed">
            Der lokale Server gehört zum nativen macOS-Host. Im Browser über{' '}
            <code className="font-mono text-apple-text-primary">npm run dev</code> gibt es keinen
            Port, den die Seite öffnen könnte — starte <strong>Vektor.app</strong>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#0A0C11] text-xs select-text">
      <div className="max-w-4xl mx-auto space-y-5">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Lokale API</h2>
          <p className="text-apple-text-secondary text-xs mt-0.5">
            Ein HTTP-Zugang auf 127.0.0.1 zum Graphen, der gerade offen ist — für andere
            Werkzeuge, für Skripte und für den MCP-Server.
          </p>
        </div>

        {status.error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-apple-red/10 border border-apple-red/30 text-apple-red">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
            <span className="leading-relaxed">{status.error}</span>
          </div>
        )}

        {/* Server */}
        <div className="p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm space-y-1">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-2">
              <StatusDot running={status.running} />
              <h3 className="text-sm font-semibold text-white">
                {status.running ? `Läuft auf ${baseUrl}` : 'Server ist aus'}
              </h3>
            </div>

            <div className="flex items-center gap-2">
              <input
                value={portDraft}
                onChange={(event) => {
                  setPortDirty(true);
                  setPortDraft(event.target.value.replace(/\D/g, ''));
                }}
                placeholder="8793"
                inputMode="numeric"
                className="w-20 bg-[#0A0C11] border border-white/[0.08] rounded-md px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-apple-blue/60"
              />
              {status.running ? (
                <button
                  onClick={() => void apiServer.stop()}
                  className="flex items-center space-x-1.5 text-xs font-medium text-apple-red bg-apple-red/10 hover:bg-apple-red/20 border border-apple-red/30 px-2.5 py-1 rounded-md transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Stoppen</span>
                </button>
              ) : (
                <button
                  onClick={() => {
                    setPortDirty(false);
                    void apiServer.start(Number(portDraft) || undefined);
                  }}
                  className="flex items-center space-x-1.5 text-xs font-medium text-apple-green bg-apple-green/10 hover:bg-apple-green/20 border border-apple-green/30 px-2.5 py-1 rounded-md transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Starten</span>
                </button>
              )}
            </div>
          </div>

          <Row label="Token">
            <code className="font-mono text-apple-text-primary truncate">
              {status.token
                ? showToken
                  ? status.token
                  : `${status.token.slice(0, 6)}${'•'.repeat(20)}`
                : '— (Server aus)'}
            </code>
            <button
              onClick={() => setShowToken((value) => !value)}
              title={showToken ? 'Verbergen' : 'Anzeigen'}
              className="text-apple-text-secondary hover:text-white p-1 rounded-md hover:bg-white/[0.06] transition-colors"
            >
              {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            <CopyButton value={status.token} />
            <button
              onClick={() => void apiServer.rotateToken()}
              title="Neues Token erzeugen — bestehende Clients verlieren den Zugang"
              className="text-apple-text-secondary hover:text-white p-1 rounded-md hover:bg-white/[0.06] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </Row>

          <Row label="Zugangsdatei">
            <code className="font-mono text-apple-text-secondary truncate">
              {status.descriptorPath}
            </code>
            <CopyButton value={status.descriptorPath} label="Pfad" />
          </Row>

          <Row label="Schreibzugriff">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={status.allowWrites}
                onChange={(event) => void apiServer.setAllowWrites(event.target.checked)}
                className="accent-apple-blue"
              />
              <span className="text-apple-text-secondary">
                Knoten und Kanten über die API anlegen, ändern und löschen
              </span>
            </label>
          </Row>

          <p className="text-[11px] text-apple-text-muted leading-relaxed pt-2 border-t border-white/[0.06] mt-2">
            Der Server lauscht ausschließlich auf 127.0.0.1 und verlangt bei jedem Aufruf das
            Token. Er ist getrennt vom Ingest-Port der Chrome-Erweiterung. Schreibende Aufrufe
            landen im offenen Graphen — und werden, wie jede andere Änderung auch, automatisch in
            die geöffnete Datei gesichert.
          </p>
        </div>

        {/* Live log */}
        <div className="rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <div className="flex items-center space-x-2">
              <Activity className="w-4 h-4 text-apple-blue" />
              <h3 className="text-sm font-semibold text-white">Live-Zugriffe</h3>
              <span className="text-[11px] text-apple-text-tertiary">
                {log.length === 0 ? 'noch nichts' : `${log.length} zuletzt`}
              </span>
            </div>
            <button
              onClick={clearLog}
              className="flex items-center space-x-1 text-[11px] text-apple-text-secondary hover:text-white px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              <span>Leeren</span>
            </button>
          </div>

          {log.length === 0 ? (
            <p className="px-5 py-6 text-apple-text-muted text-center">
              Sobald ein Werkzeug etwas abfragt, erscheint der Aufruf hier — mit Abfrage, Status,
              Treffern und Dauer.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-white/[0.04]">
              {log.map((entry) => (
                <div key={entry.id} className="px-5 py-2 flex items-start gap-3 hover:bg-white/[0.02]">
                  <span className="font-mono text-[11px] text-apple-text-muted w-16 shrink-0 tabular-nums">
                    {new Date(entry.at).toLocaleTimeString('de-DE')}
                  </span>
                  <span
                    className={`font-mono text-[11px] w-9 shrink-0 ${
                      entry.status < 400 ? 'text-apple-green' : 'text-apple-red'
                    }`}
                  >
                    {entry.status}
                  </span>
                  <span className="font-mono text-[11px] text-apple-text-secondary w-12 shrink-0">
                    {entry.method}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-apple-text-primary truncate">
                      {entry.path}
                    </div>
                    {(entry.summary || entry.error) && (
                      <div
                        className={`font-mono text-[10px] truncate mt-0.5 ${
                          entry.error ? 'text-apple-red' : 'text-apple-text-muted'
                        }`}
                      >
                        {entry.error ?? entry.summary}
                      </div>
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-apple-text-tertiary shrink-0 tabular-nums">
                    {entry.rowCount === null ? '—' : `${entry.rowCount}×`}
                  </span>
                  <span className="font-mono text-[11px] text-apple-text-muted shrink-0 tabular-nums w-16 text-right">
                    {entry.durationMs} ms
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Endpoints */}
        <div className="p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm">
          <h3 className="text-sm font-semibold text-white mb-3">Endpunkte</h3>
          <div className="space-y-1.5">
            {endpoints.map(([route, description]) => (
              <div key={route} className="flex items-baseline gap-3">
                <code className="font-mono text-[11px] text-apple-cyan whitespace-pre shrink-0 w-64">
                  {route}
                </code>
                <span className="text-apple-text-secondary">{description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Examples */}
        <div className="p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm space-y-4">
          <h3 className="text-sm font-semibold text-white">Zum Ausprobieren</h3>
          {examples.map((example) => (
            <div key={example.title} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-apple-text-tertiary">
                  {example.title}
                </span>
                <CopyButton value={example.command} />
              </div>
              <pre className="font-mono text-[11px] text-apple-text-primary bg-[#0A0C11] border border-white/[0.06] rounded-lg p-3 overflow-x-auto whitespace-pre">
                {example.command}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
