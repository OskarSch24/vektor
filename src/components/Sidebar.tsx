import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Globe,
  Link2,
  Search,
  Tag,
  Trash2,
} from 'lucide-react';
import { GraphSchema, GraphSource } from '../types/graph';
import { formatCount, formatRelativeTime, hostOf, labelColor } from '../lib/graph';

interface SidebarProps {
  schema: GraphSchema;
  sources: GraphSource[];
  hiddenLabels: Set<string>;
  onToggleLabel: (label: string) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onFocusSource: (source: GraphSource) => void;
}

/**
 * The left rail: what is in the graph and where it came from. Labels double as
 * a visibility filter, which is the fastest way to make a dense graph readable
 * without deleting anything.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  schema,
  sources,
  hiddenLabels,
  onToggleLabel,
  searchTerm,
  onSearchChange,
  onRemoveSource,
  onFocusSource,
}) => {
  const [openSections, setOpenSections] = useState({
    labels: true,
    relationships: true,
    sources: true,
  });

  const toggleSection = (key: keyof typeof openSections) =>
    setOpenSections((sections) => ({ ...sections, [key]: !sections[key] }));

  return (
    <aside className="w-64 shrink-0 h-full flex flex-col bg-apple-panel border-r border-apple-border select-none">
      <div className="p-2.5 border-b border-apple-border-subtle shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-apple-text-tertiary pointer-events-none" />
          <input
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Knoten suchen…"
            className="w-full bg-black/30 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-apple-text-primary placeholder:text-apple-text-muted focus:outline-none focus:border-apple-border-focus focus:ring-1 focus:ring-apple-blue/30 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <Section
          title="Labels"
          icon={<Tag className="w-3.5 h-3.5" />}
          count={schema.labels.length}
          isOpen={openSections.labels}
          onToggle={() => toggleSection('labels')}
        >
          {schema.labels.map((entry) => {
            const hidden = hiddenLabels.has(entry.label);
            return (
              <button
                key={entry.label}
                onClick={() => onToggleLabel(entry.label)}
                title={
                  entry.propertyKeys.length > 0
                    ? `Eigenschaften: ${entry.propertyKeys.slice(0, 8).join(', ')}`
                    : undefined
                }
                className={`w-full group flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                  hidden ? 'opacity-40 hover:opacity-70' : 'hover:bg-white/[0.05]'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-inset ring-black/40"
                  style={{ backgroundColor: labelColor(entry.label) }}
                />
                <span className="flex-1 text-xs text-apple-text-primary truncate">{entry.label}</span>
                <span className="text-[11px] font-mono text-apple-text-tertiary tabular-nums">
                  {formatCount(entry.count)}
                </span>
                {hidden ? (
                  <EyeOff className="w-3 h-3 text-apple-text-muted shrink-0" />
                ) : (
                  <Eye className="w-3 h-3 text-apple-text-muted opacity-0 group-hover:opacity-100 shrink-0" />
                )}
              </button>
            );
          })}
          {schema.labels.length === 0 && <EmptyHint>Noch keine Knoten.</EmptyHint>}
        </Section>

        <Section
          title="Beziehungen"
          icon={<Link2 className="w-3.5 h-3.5" />}
          count={schema.relationshipTypes.length}
          isOpen={openSections.relationships}
          onToggle={() => toggleSection('relationships')}
        >
          {schema.relationshipTypes.map((entry) => (
            <div
              key={entry.type}
              title={entry.pairs.map((pair) => `${pair.from} → ${pair.to} (${pair.count})`).join('\n')}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.05] transition-colors"
            >
              <span className="w-4 h-px bg-white/25 shrink-0" />
              <span className="flex-1 text-[11px] font-mono text-apple-text-secondary truncate">
                {entry.type}
              </span>
              <span className="text-[11px] font-mono text-apple-text-tertiary tabular-nums">
                {formatCount(entry.count)}
              </span>
            </div>
          ))}
          {schema.relationshipTypes.length === 0 && <EmptyHint>Noch keine Kanten.</EmptyHint>}
        </Section>

        <Section
          title="Quellen"
          icon={<Globe className="w-3.5 h-3.5" />}
          count={sources.length}
          isOpen={openSections.sources}
          onToggle={() => toggleSection('sources')}
        >
          {sources.map((source) => (
            <div
              key={source.id}
              className="group flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.05] transition-colors"
            >
              <button
                onClick={() => onFocusSource(source)}
                className="flex-1 min-w-0 text-left"
                title={source.url}
              >
                <p className="text-xs text-apple-text-primary truncate">{source.title || source.url}</p>
                <p className="text-[11px] text-apple-text-tertiary truncate">
                  {hostOf(source.url)} · {formatRelativeTime(source.ingestedAt)} ·{' '}
                  {formatCount(source.nodeIds.length)} Knoten
                </p>
              </button>
              <button
                onClick={() => onRemoveSource(source.id)}
                title="Quelle mit allen daraus erzeugten Knoten entfernen"
                className="p-1 rounded-md text-apple-text-muted opacity-0 group-hover:opacity-100 hover:text-apple-red hover:bg-apple-red/10 transition-all shrink-0"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {sources.length === 0 && <EmptyHint>Noch nichts importiert.</EmptyHint>}
        </Section>
      </div>
    </aside>
  );
};

const Section: React.FC<{
  title: string;
  icon: React.ReactNode;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, icon, count, isOpen, onToggle, children }) => (
  <div className="border-b border-apple-border-subtle last:border-b-0">
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 px-2.5 py-2 text-apple-text-secondary hover:text-apple-text-primary transition-colors"
    >
      {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      <span className="text-apple-text-tertiary">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-wider flex-1 text-left">
        {title}
      </span>
      <span className="text-[11px] font-mono text-apple-text-muted tabular-nums">{count}</span>
    </button>
    {isOpen && <div className="px-1.5 pb-2 space-y-px">{children}</div>}
  </div>
);

const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-2 py-1.5 text-[11px] text-apple-text-muted">{children}</p>
);
