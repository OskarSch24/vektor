import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Binary, Clock, Hash, Key, Search } from 'lucide-react';
import type { Connection } from '../services/redis/connection';
import {
  formatBytes,
  formatTtl,
  readValue,
  scanPage,
  type KeyEntry,
  type KeyValue,
} from '../services/redis/keyspace';
import { ValueViewer } from './ValueViewer';

interface KeyBrowserProps {
  connection: Connection;
  /** Bumped by the title bar's refresh and after a database switch. */
  reloadToken: number;
  onError: (message: string) => void;
}

/** Types offered as filter chips; the server filters, so the list is exact. */
const TYPES = ['string', 'list', 'set', 'zset', 'hash', 'stream'];

const TYPE_COLOR: Record<string, string> = {
  string: 'text-apple-green',
  list: 'text-apple-blue',
  set: 'text-apple-purple',
  zset: 'text-apple-amber',
  hash: 'text-apple-cyan',
  stream: 'text-apple-pink',
  vectorset: 'text-apple-indigo',
  'ReJSON-RL': 'text-apple-indigo',
};

export const KeyBrowser: React.FC<KeyBrowserProps> = ({ connection, reloadToken, onError }) => {
  const [entries, setEntries] = useState<KeyEntry[]>([]);
  const [cursor, setCursor] = useState('0');
  const [pattern, setPattern] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<KeyEntry | null>(null);
  const [value, setValue] = useState<KeyValue | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loadingValue, setLoadingValue] = useState(false);

  // Guards against an older scan finishing after a newer one and overwriting it
  // — typing in the filter starts a new scan on every keystroke.
  const scanGeneration = useRef(0);

  const load = useCallback(
    async (nextCursor: string, append: boolean) => {
      const generation = ++scanGeneration.current;
      setScanning(true);
      try {
        const page = await scanPage(connection, {
          cursor: nextCursor,
          match: pattern.trim() ? pattern.trim() : undefined,
          type: typeFilter ?? undefined,
        });
        if (generation !== scanGeneration.current) return;
        setEntries((current) => (append ? [...current, ...page.entries] : page.entries));
        setCursor(page.cursor);
      } catch (err: any) {
        if (generation === scanGeneration.current) onError(err?.message || String(err));
      } finally {
        if (generation === scanGeneration.current) setScanning(false);
      }
    },
    [connection, pattern, typeFilter, onError]
  );

  // A filter change restarts the scan from the beginning; SCAN cursors are not
  // valid across different MATCH or TYPE arguments.
  useEffect(() => {
    const timer = window.setTimeout(() => void load('0', false), 220);
    return () => window.clearTimeout(timer);
  }, [load, reloadToken]);

  const open = useCallback(
    async (entry: KeyEntry, request: { offset?: number; cursor?: string } = {}) => {
      setSelected(entry);
      setLoadingValue(true);
      try {
        setValue(await readValue(connection, entry.key, entry.type, request));
      } catch (err: any) {
        setValue(null);
        onError(err?.message || String(err));
      } finally {
        setLoadingValue(false);
      }
    },
    [connection, onError]
  );

  // The open key must follow a refresh: its TTL ran down, and its value may
  // have changed under it.
  useEffect(() => {
    if (selected) void open(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-[360px] shrink-0 border-r border-apple-border flex flex-col min-h-0">
        <div className="p-2.5 space-y-2 border-b border-apple-border">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-apple-text-tertiary" />
            <input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="Muster, z. B. px:*:node:*"
              className="w-full bg-black/30 border border-apple-border rounded-lg pl-8 pr-2.5 py-1.5 text-[12.5px] font-mono placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus"
            />
          </div>

          <div className="flex flex-wrap gap-1">
            <Chip active={typeFilter === null} onClick={() => setTypeFilter(null)}>
              alle
            </Chip>
            {TYPES.map((type) => (
              <Chip key={type} active={typeFilter === type} onClick={() => setTypeFilter(type)}>
                {type}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {entries.length === 0 && !scanning ? (
            <p className="p-4 text-[12.5px] text-apple-text-tertiary leading-relaxed">
              {pattern || typeFilter
                ? 'Keine Schlüssel in diesem Durchlauf. SCAN geht die Datenbank stückweise durch — mit „Weiter suchen“ läuft die Suche weiter.'
                : 'Diese Datenbank ist leer.'}
            </p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li key={`${entry.key}-${entry.type}`}>
                  <button
                    onClick={() => void open(entry)}
                    className={`w-full text-left px-2.5 py-1.5 flex items-start gap-2 transition-colors ${
                      selected?.key === entry.key ? 'bg-apple-hover' : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    {entry.binaryKey ? (
                      <Binary className="w-3.5 h-3.5 shrink-0 mt-0.5 text-apple-purple" />
                    ) : (
                      <Key className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${TYPE_COLOR[entry.type] ?? 'text-apple-text-tertiary'}`} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-[12px] truncate">{entry.key}</span>
                      <span className="block text-[10.5px] text-apple-text-tertiary">
                        {entry.type}
                        {entry.size !== null &&
                          ` · ${entry.type === 'string' ? formatBytes(entry.size) : `${entry.size} Einträge`}`}
                        {entry.ttl >= 0 && ` · ${formatTtl(entry.ttl)}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-2 border-t border-apple-border flex items-center gap-2">
          <span className="text-[11px] text-apple-text-tertiary flex-1 truncate">
            {entries.length} geladen
            {summary.length > 1 && ` · ${summary.map(([type, count]) => `${count}× ${type}`).join(', ')}`}
          </span>
          <button
            onClick={() => void load(cursor, true)}
            disabled={scanning || cursor === '0'}
            className="px-2 py-1 rounded-md text-[11.5px] border border-apple-border text-apple-text-secondary hover:text-white hover:bg-white/[0.06] disabled:opacity-30 transition-colors"
          >
            {scanning ? 'Suche…' : cursor === '0' ? 'vollständig' : 'Weiter suchen'}
          </button>
        </div>
      </aside>

      <section className="flex-1 min-w-0 overflow-y-auto">
        {!selected || !value ? (
          <div className="h-full flex items-center justify-center text-[13px] text-apple-text-tertiary">
            {loadingValue ? 'Wird gelesen…' : 'Links einen Schlüssel wählen.'}
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div>
              <h2 className="font-mono text-[14px] break-all">{selected.key}</h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11.5px] text-apple-text-tertiary">
                <span className={TYPE_COLOR[selected.type] ?? ''}>{selected.type}</span>
                {selected.encoding && (
                  <span className="flex items-center gap-1">
                    <Hash className="w-3 h-3" />
                    {selected.encoding}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatTtl(selected.ttl)}
                </span>
              </div>
            </div>

            <ValueViewer
              value={value}
              busy={loadingValue}
              onPage={(request) => void open(selected, request)}
            />
          </div>
        )}
      </section>
    </div>
  );
};

const Chip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    onClick={onClick}
    className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
      active
        ? 'bg-apple-blue/20 text-apple-blue border border-apple-blue/40'
        : 'border border-apple-border text-apple-text-tertiary hover:text-white hover:bg-white/[0.05]'
    }`}
  >
    {children}
  </button>
);
