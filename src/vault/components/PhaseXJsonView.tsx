import React, { useMemo, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, Code2, Search, X } from 'lucide-react';
import {
  breadcrumbIds,
  friendlyTitle,
  friendlyType,
  jsonDocumentFor,
  shortTitle,
  type PhaseXExplorerSnapshot,
} from './PhaseXPresentation';

interface PhaseXJsonViewProps {
  snapshot: PhaseXExplorerSnapshot;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  loadingIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

const MAX_SEARCH_RESULTS = 60;
const MAX_OBJECT_ENTRIES = 80;
const RAW_PREVIEW_CHARS = 48 * 1024;

export const PhaseXJsonView: React.FC<PhaseXJsonViewProps> = ({
  snapshot,
  selectedId,
  expanded,
  loadingIds,
  onSelect,
  onToggle,
}) => {
  const [search, setSearch] = useState('');
  const [raw, setRaw] = useState(false);
  const selected = selectedId ? snapshot.nodes.get(selectedId) : undefined;
  const query = search.trim().toLocaleLowerCase('de-DE');

  const matches = useMemo(() => {
    if (!query) return [];
    const found: string[] = [];
    for (const [id, node] of snapshot.nodes) {
      const values = [id, node.nodeType, node.title, ...node.fields.flat()];
      if (values.some((value) => value.toLocaleLowerCase('de-DE').includes(query))) found.push(id);
      if (found.length >= MAX_SEARCH_RESULTS) break;
    }
    return found;
  }, [query, snapshot]);

  const breadcrumb = selectedId ? breadcrumbIds(selectedId, snapshot.parents) : [];
  const document = selected ? jsonDocumentFor(selected, snapshot) : null;
  const rawText = document ? JSON.stringify(document, null, 2) : '';
  const rawTruncated = rawText.length > RAW_PREVIEW_CHARS;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[350px] shrink-0 flex-col border-r border-apple-border bg-black/[0.08]">
        <div className="border-b border-apple-border p-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-apple-text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="In geladenen Daten suchen"
              className="h-9 w-full rounded-lg border border-apple-border bg-black/25 pl-8 pr-8 text-[11.5px] text-apple-text-primary placeholder:text-apple-text-muted focus:border-apple-border-focus focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                title="Suche leeren"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-apple-text-tertiary hover:bg-white/[0.07] hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </label>
          <p className="mt-2 text-[10px] leading-relaxed text-apple-text-muted">
            Durchsucht {snapshot.nodes.size.toLocaleString('de-DE')} bereits geladene Einträge. Weitere erscheinen, wenn du Zweige öffnest.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {query ? (
            matches.length > 0 ? (
              <div>
                <p className="px-3 pb-1.5 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-apple-text-muted">
                  {matches.length === MAX_SEARCH_RESULTS ? 'Erste 60 Treffer' : `${matches.length} Treffer`}
                </p>
                {matches.map((id) => {
                  const node = snapshot.nodes.get(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onSelect(id)}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${selectedId === id ? 'bg-apple-blue/15' : 'hover:bg-white/[0.04]'}`}
                    >
                      <Braces className="mt-0.5 h-3.5 w-3.5 shrink-0 text-apple-cyan" />
                      <span className="min-w-0">
                        <span className="block truncate text-[11.5px] font-medium text-apple-text-primary">{shortTitle(node)}</span>
                        <span className="mt-0.5 block text-[9.5px] uppercase tracking-[0.08em] text-apple-text-muted">{friendlyType(node)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="px-4 py-6 text-center text-[11.5px] text-apple-text-tertiary">Keine Treffer in den bereits geladenen Daten.</p>
            )
          ) : snapshot.roots.length > 0 ? (
            <div>
              <p className="px-3 pb-1.5 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-apple-text-muted">JSON-Hierarchie</p>
              <JsonHierarchy
                ids={snapshot.roots}
                depth={0}
                snapshot={snapshot}
                expanded={expanded}
                loadingIds={loadingIds}
                selectedId={selectedId}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            </div>
          ) : (
            <p className="px-4 py-6 text-center text-[11.5px] text-apple-text-tertiary">Kein Einstiegspunkt vorhanden.</p>
          )}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        {!selected || !document ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[12.5px] text-apple-text-tertiary">
            Links einen Eintrag auswählen.
          </div>
        ) : (
          <div className="mx-auto max-w-[980px] p-5">
            <div className="mb-4 flex flex-wrap items-start gap-3 border-b border-white/[0.07] pb-4">
              <div className="min-w-0 flex-1">
                <nav aria-label="Pfad" className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-apple-text-tertiary">
                  {breadcrumb.map((id, index) => (
                    <React.Fragment key={id}>
                      {index > 0 && <ChevronRight className="h-3 w-3 text-apple-text-muted" />}
                      <button type="button" onClick={() => onSelect(id)} className="max-w-44 truncate hover:text-apple-cyan">
                        {shortTitle(snapshot.nodes.get(id), 34)}
                      </button>
                    </React.Fragment>
                  ))}
                </nav>
                <h2 className="truncate text-[17px] font-semibold tracking-[-0.015em] text-white">{friendlyTitle(selected)}</h2>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-apple-cyan">{friendlyType(selected)}</p>
              </div>

              <button
                type="button"
                onClick={() => setRaw((current) => !current)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[10.5px] font-medium transition-colors ${
                  raw
                    ? 'border-apple-blue/35 bg-apple-blue/15 text-apple-cyan'
                    : 'border-white/[0.08] bg-white/[0.025] text-apple-text-secondary hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                <Code2 className="h-3.5 w-3.5" />
                Rohdaten {raw ? 'ausblenden' : 'anzeigen'}
              </button>
            </div>

            {raw ? (
              <div>
                <pre className="max-h-[66vh] overflow-auto rounded-xl border border-white/[0.08] bg-[#080a0f] p-4 font-mono text-[11.5px] leading-relaxed text-[#c6d4e1]">
                  {rawTruncated ? `${rawText.slice(0, RAW_PREVIEW_CHARS)}\n…` : rawText}
                </pre>
                {rawTruncated && (
                  <p className="mt-2 text-[10.5px] leading-relaxed text-apple-amber">
                    Die Rohansicht wurde bei 48 kB gekürzt, damit das Fenster flüssig bleibt. Die gespeicherten Daten sind vollständig.
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/[0.075] bg-[#12161e]/75 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
                <JsonValueTree name="Eintrag" value={document} depth={0} initiallyOpen />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

const JsonHierarchy: React.FC<{
  ids: string[];
  depth: number;
  snapshot: PhaseXExplorerSnapshot;
  expanded: ReadonlySet<string>;
  loadingIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}> = ({ ids, depth, snapshot, expanded, loadingIds, selectedId, onSelect, onToggle }) => (
  <ul>
    {ids.map((id) => {
      const node = snapshot.nodes.get(id);
      const open = expanded.has(id);
      const children = snapshot.children.get(id);
      const canExpand = (node?.childCount ?? 0) > 0 || children === undefined;
      const busy = loadingIds.has(id);
      return (
        <li key={id}>
          <div
            className={`group flex items-center gap-1.5 border-l border-transparent py-1 pr-2 transition-colors ${
              selectedId === id ? 'border-apple-blue bg-apple-blue/12' : 'hover:bg-white/[0.035]'
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <button
              type="button"
              onClick={() => canExpand && onToggle(id)}
              disabled={!canExpand || busy}
              aria-label={open ? 'Zweig schließen' : 'Zweig öffnen'}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-apple-text-muted hover:bg-white/[0.07] hover:text-white disabled:opacity-30"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
            <button type="button" onClick={() => onSelect(id)} className="min-w-0 flex-1 truncate text-left font-mono text-[10.5px]">
              <span className="text-apple-purple">&quot;{shortTitle(node, 46)}&quot;</span>
              <span className="ml-1 text-apple-text-muted">: {'{'}</span>
            </button>
          </div>
          {open && children && children.length > 0 && (
            <JsonHierarchy
              ids={children.map((child) => child.id)}
              depth={depth + 1}
              snapshot={snapshot}
              expanded={expanded}
              loadingIds={loadingIds}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          )}
          {open && children && children.length === 0 && (
            <div className="py-1 font-mono text-[10px] text-apple-text-muted" style={{ paddingLeft: 42 + depth * 14 }}>
              {'{ }'}
            </div>
          )}
        </li>
      );
    })}
  </ul>
);

const JsonValueTree: React.FC<{
  name: string;
  value: unknown;
  depth: number;
  initiallyOpen?: boolean;
}> = ({ name, value, depth, initiallyOpen = depth < 1 }) => {
  const [open, setOpen] = useState(initiallyOpen);
  const collection = value !== null && typeof value === 'object';

  if (!collection) {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1 font-mono text-[11px] hover:bg-white/[0.025]" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="shrink-0 text-apple-cyan">{name}</span>
        <span className="text-apple-text-muted">:</span>
        <JsonScalar value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);
  const visible = entries.slice(0, MAX_OBJECT_ENTRIES);
  const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-mono text-[11px] hover:bg-white/[0.035]"
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-apple-text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-apple-text-muted" />}
        <span className="text-apple-cyan">{name}</span>
        <span className="text-apple-text-muted">: {bracket[0]}</span>
        {!open && <span className="text-[9.5px] text-apple-text-muted">{entries.length} {Array.isArray(value) ? 'Elemente' : 'Felder'} {bracket[1]}</span>}
      </button>
      {open && (
        <div>
          {visible.length === 0 ? (
            <div className="py-1 font-mono text-[10.5px] text-apple-text-muted" style={{ paddingLeft: 30 + depth * 14 }}>{bracket[1]}</div>
          ) : (
            <>
              {visible.map(([key, item]) => (
                <JsonValueTree key={key} name={key} value={item} depth={depth + 1} />
              ))}
              {entries.length > visible.length && (
                <p className="py-1 text-[10px] text-apple-amber" style={{ paddingLeft: 28 + depth * 14 }}>
                  {entries.length - visible.length} weitere Felder werden zum Schutz der Ansicht nicht gleichzeitig geöffnet.
                </p>
              )}
              <div className="py-0.5 font-mono text-[10.5px] text-apple-text-muted" style={{ paddingLeft: 20 + depth * 14 }}>{bracket[1]}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const JsonScalar: React.FC<{ value: unknown }> = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  if (value === null) return <span className="text-apple-pink">null</span>;
  if (typeof value === 'boolean') return <span className="text-apple-amber">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-apple-purple">{value}</span>;

  const text = String(value);
  const long = text.length > 480;
  const shown = long && !expanded ? `${text.slice(0, 480)}…` : text;
  return (
    <span className="min-w-0 break-words text-[#b7dba8]">
      &quot;{shown}&quot;
      {long && (
        <button type="button" onClick={() => setExpanded((current) => !current)} className="ml-2 text-[10px] font-sans text-apple-blue hover:underline">
          {expanded ? 'kürzen' : 'vollständig zeigen'}
        </button>
      )}
    </span>
  );
};
