import React from 'react';
import { AlertTriangle, Check, Cpu, HardDrive, Minus } from 'lucide-react';
import type { Connection } from '../services/redis/connection';
import { formatBytes } from '../services/redis/keyspace';

/**
 * What this particular server can do — which is not a constant.
 *
 * A Homebrew `redis-server` and a Redis Stack container answer to the same
 * protocol and differ in half the data structures. The Phase-X design leans on
 * JSON documents and field search; whether they exist here is a fact about the
 * build, and the app says so rather than failing at the first `JSON.GET`.
 */
export const ServerView: React.FC<{ connection: Connection }> = ({ connection }) => {
  const { facts } = connection;
  const missing = facts.capabilities.filter((capability) => !capability.available);

  const uptime = (() => {
    const days = Math.floor(facts.uptimeSeconds / 86_400);
    const hours = Math.floor((facts.uptimeSeconds % 86_400) / 3600);
    return days > 0 ? `${days} d ${hours} h` : `${hours} h`;
  })();

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="max-w-3xl space-y-5">
        <section>
          <SectionTitle icon={<Cpu className="w-3.5 h-3.5" />}>Server</SectionTitle>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <Row label="Adresse">{connection.host}:{connection.port}</Row>
            <Row label="Version">Redis {facts.version}</Row>
            <Row label="Betriebsart">{facts.mode} · {facts.role}</Row>
            <Row label="Laufzeit">{uptime}</Row>
            <Row label="Speicher">{facts.memoryHuman} ({formatBytes(facts.memoryUsed)})</Row>
            <Row label="Datenbanken">{facts.databaseCount}</Row>
            <Row label="Verbindung">
              {connection.transport.kind === 'native' ? 'nativer Host' : 'Entwicklungs-Brücke'}
            </Row>
            <Row label="Befehle">
              {connection.catalogue.loaded ? `${connection.catalogue.size} gemeldet` : 'nicht gemeldet'}
            </Row>
          </dl>
        </section>

        <section>
          <SectionTitle icon={<Check className="w-3.5 h-3.5" />}>Datenstrukturen</SectionTitle>
          <ul className="space-y-1">
            {facts.capabilities.map((capability) => (
              <li key={capability.id} className="flex items-center gap-2 text-[13px]">
                {capability.available ? (
                  <Check className="w-3.5 h-3.5 text-apple-green shrink-0" />
                ) : (
                  <Minus className="w-3.5 h-3.5 text-apple-text-muted shrink-0" />
                )}
                <span className={capability.available ? '' : 'text-apple-text-tertiary'}>
                  {capability.label}
                </span>
                <code className="ml-auto font-mono text-[11px] text-apple-text-muted">
                  {capability.probe.toUpperCase()}
                </code>
              </li>
            ))}
          </ul>

          {facts.modules.length > 0 && (
            <p className="mt-2 text-[12px] text-apple-text-tertiary">
              Geladene Module: {facts.modules.map((module) => `${module.name} ${module.version}`).join(', ')}
            </p>
          )}

          {missing.length > 0 && (
            <div className="mt-3 rounded-lg border border-apple-border bg-white/[0.02] p-3 text-[12.5px] text-apple-text-secondary leading-relaxed">
              <p>
                Diese Instanz kennt {listOf(missing.map((capability) => capability.label))} nicht.
                Der Phase-X-Entwurf setzt auf JSON-Dokumente und Feldsuche — mit diesem Build müssen
                Knoten als Hash und Indizes als Sorted Set geschrieben werden.
              </p>
              <p className="mt-1.5 text-apple-text-tertiary">
                Vektor liest beide Formen; die Phase-X-Ansicht erkennt Hash, JSON-Dokument und
                JSON als Zeichenkette gleichermaßen.
              </p>
            </div>
          )}
        </section>

        <section>
          <SectionTitle icon={<HardDrive className="w-3.5 h-3.5" />}>Dauerhaftigkeit</SectionTitle>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <Row label="AOF">{facts.persistence.aofEnabled ? 'eingeschaltet' : 'aus'}</Row>
            <Row label="Letzter RDB-Schnappschuss">
              {facts.persistence.rdbLastSave
                ? new Date(facts.persistence.rdbLastSave * 1000).toLocaleString('de-DE')
                : 'keiner'}
            </Row>
            <Row label="Änderungen seit dem Schnappschuss">
              {facts.persistence.rdbChangesSinceSave}
            </Row>
          </dl>

          {!facts.persistence.aofEnabled && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-apple-amber/30 bg-apple-amber/10 p-3 text-[12.5px] text-apple-amber leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <div>
                Ohne AOF liegt zwischen zwei RDB-Schnappschüssen alles nur im Arbeitsspeicher —
                {facts.persistence.rdbChangesSinceSave > 0 &&
                  ` derzeit ${facts.persistence.rdbChangesSinceSave} Änderungen`}
                . Für einen Index, der jederzeit neu aufgebaut werden kann, ist das in Ordnung.
                Für Daten, die es nur hier gibt, nicht.
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

/** "A, B und C" — the enumeration reads as a sentence, not as a CSV row. */
function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} und ${labels[labels.length - 1]}`;
}

const SectionTitle: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <h2 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-apple-text-tertiary mb-2">
    {icon}
    {children}
  </h2>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <>
    <dt className="text-[13px] text-apple-text-secondary">{label}</dt>
    <dd className="text-[13px] font-mono">{children}</dd>
  </>
);
