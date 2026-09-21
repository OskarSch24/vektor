import React, { useMemo, useState } from 'react';
import { ArrowRight, ExternalLink, ListTree, LockKeyhole, Trash2, X } from 'lucide-react';
import { GraphEdge, GraphNode } from '../types/graph';
import { formatPropertyValue, labelColor, nodeTitle } from '../lib/graph';

interface NodeInspectorProps {
  node: GraphNode;
  incident: GraphEdge[];
  resolveNode: (id: string) => GraphNode | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
  onShowHierarchy?: () => void;
}

/**
 * The right rail. Shows one node in full: its labels, every property, and its
 * neighbourhood split by direction — which is how you actually read a graph,
 * one hop at a time.
 */
export const NodeInspector: React.FC<NodeInspectorProps> = ({
  node,
  incident,
  resolveNode,
  onSelect,
  onClose,
  onDelete,
  readOnly = false,
  onShowHierarchy,
}) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { outgoing, incoming } = useMemo(() => {
    const out: GraphEdge[] = [];
    const into: GraphEdge[] = [];
    for (const edge of incident) {
      if (edge.from === node.id) out.push(edge);
      else into.push(edge);
    }
    const byType = (a: GraphEdge, b: GraphEdge) => a.type.localeCompare(b.type);
    return { outgoing: out.sort(byType), incoming: into.sort(byType) };
  }, [incident, node.id]);

  const properties = useMemo(
    () =>
      Object.entries(node.properties)
        .filter(([, value]) => value !== null && value !== '' && value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    [node.properties]
  );

  const url = typeof node.properties.url === 'string' ? node.properties.url : null;

  return (
    <aside className="w-80 shrink-0 h-full flex flex-col bg-apple-panel border-l border-apple-border">
      <header className="px-3.5 py-3 border-b border-apple-border-subtle shrink-0 select-none">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1 mb-1.5">
              {node.labels.map((label) => (
                <span
                  key={label}
                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide"
                  style={{
                    backgroundColor: `${labelColor(label)}22`,
                    color: labelColor(label),
                    border: `1px solid ${labelColor(label)}44`,
                  }}
                >
                  {label}
                </span>
              ))}
            </div>
            <h2 className="text-sm font-semibold text-apple-text-primary leading-snug break-words select-text">
              {nodeTitle(node)}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Inspektor schließen"
            className="p-1 rounded-md text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-apple-blue hover:underline break-all"
          >
            <ExternalLink className="w-3 h-3 shrink-0" />
            <span className="truncate">{url}</span>
          </a>
        )}
      </header>

      <div className="flex-1 overflow-y-auto min-h-0">
        <Group title="Eigenschaften" count={properties.length}>
          <dl className="space-y-2">
            {properties.map(([key, value]) => (
              <div key={key}>
                <dt className="text-[10px] uppercase tracking-wider text-apple-text-tertiary font-semibold">
                  {key}
                </dt>
                <dd className="text-xs text-apple-text-primary select-text break-words whitespace-pre-wrap leading-relaxed">
                  {formatPropertyValue(value)}
                </dd>
              </div>
            ))}
            {properties.length === 0 && (
              <p className="text-[11px] text-apple-text-muted">Keine Eigenschaften.</p>
            )}
          </dl>
          <p className="mt-3 pt-2 border-t border-apple-border-subtle text-[10px] font-mono text-apple-text-muted select-text break-all">
            {node.id}
          </p>
        </Group>

        {outgoing.length > 0 && (
          <Group title="Ausgehend" count={outgoing.length}>
            <div className="space-y-px">
              {outgoing.map((edge) => (
                <NeighbourRow
                  key={edge.id}
                  type={edge.type}
                  direction="out"
                  neighbour={resolveNode(edge.to)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </Group>
        )}

        {incoming.length > 0 && (
          <Group title="Eingehend" count={incoming.length}>
            <div className="space-y-px">
              {incoming.map((edge) => (
                <NeighbourRow
                  key={edge.id}
                  type={edge.type}
                  direction="in"
                  neighbour={resolveNode(edge.from)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </Group>
        )}
      </div>

      <footer className="p-2.5 border-t border-apple-border-subtle shrink-0">
        {readOnly ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1 text-[10px] text-apple-text-muted">
              <LockKeyhole className="w-3 h-3" />
              Abgeleitete Ansicht · Original bleibt unverändert
            </div>
            {onShowHierarchy && (
              <button
                onClick={onShowHierarchy}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium text-apple-blue bg-apple-blue/10 hover:bg-apple-blue/20 border border-apple-blue/25 transition-colors"
              >
                <ListTree className="w-3 h-3" />
                In Hierarchie zeigen
              </button>
            )}
          </div>
        ) : confirmingDelete ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] text-apple-text-secondary">
              Knoten und seine {incident.length} Kanten löschen?
            </span>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="px-2 py-1 rounded-md text-[11px] text-apple-text-secondary hover:bg-white/[0.08] transition-colors"
            >
              Abbrechen
            </button>
            <button
              onClick={() => {
                onDelete(node.id);
                setConfirmingDelete(false);
              }}
              className="px-2 py-1 rounded-md text-[11px] font-medium text-white bg-apple-red hover:bg-apple-red/85 transition-colors"
            >
              Löschen
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium text-apple-text-secondary hover:text-apple-red hover:bg-apple-red/10 border border-white/[0.08] hover:border-apple-red/30 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Knoten löschen
          </button>
        )}
      </footer>
    </aside>
  );
};

const Group: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({
  title,
  count,
  children,
}) => (
  <section className="px-3.5 py-3 border-b border-apple-border-subtle last:border-b-0">
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary select-none">
      {title}
      <span className="ml-1.5 font-mono text-apple-text-muted">{count}</span>
    </h3>
    {children}
  </section>
);

const NeighbourRow: React.FC<{
  type: string;
  direction: 'in' | 'out';
  neighbour: GraphNode | undefined;
  onSelect: (id: string) => void;
}> = ({ type, direction, neighbour, onSelect }) => {
  if (!neighbour) return null;
  const colour = labelColor(neighbour.labels[0] ?? 'Node');

  return (
    <button
      onClick={() => onSelect(neighbour.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-white/[0.05] transition-colors group"
    >
      <ArrowRight
        className={`w-3 h-3 shrink-0 text-apple-text-muted ${direction === 'in' ? 'rotate-180' : ''}`}
      />
      <span className="text-[10px] font-mono text-apple-text-tertiary shrink-0 max-w-[92px] truncate">
        {type}
      </span>
      <span
        className="w-2 h-2 rounded-full shrink-0 ring-1 ring-inset ring-black/40"
        style={{ backgroundColor: colour }}
      />
      <span className="flex-1 text-xs text-apple-text-primary truncate group-hover:text-white">
        {nodeTitle(neighbour)}
      </span>
    </button>
  );
};
