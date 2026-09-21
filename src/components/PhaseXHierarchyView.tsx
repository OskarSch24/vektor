import React, { useEffect, useMemo, useState } from 'react';
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson2,
  FolderTree,
  Network,
} from 'lucide-react';
import { nodeTitle } from '../lib/graph';
import { valueAtJsonPointer } from '../services/phaseX/adapter';
import { GraphNode } from '../types/graph';
import { AdaptedPhaseXRun, JsonValue } from '../types/phaseX';

interface PhaseXHierarchyViewProps {
  run: AdaptedPhaseXRun;
  selectedPointer: string;
  onSelect: (pointer: string, nodeId: string) => void;
  onShowGraph: (nodeId: string) => void;
}

/** A Finder-like hierarchy derived only from roots and ordered CONTAINS edges. */
export const PhaseXHierarchyView: React.FC<PhaseXHierarchyViewProps> = ({
  run,
  selectedPointer,
  onSelect,
  onShowGraph,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(run.hierarchyRootIds));
  const [copied, setCopied] = useState<'path' | 'value' | null>(null);
  const root = run.document as unknown as JsonValue;
  const selectedValue = valueAtJsonPointer(root, selectedPointer);
  const selectedNodeId = run.nodeIdByPointer.get(selectedPointer) ?? run.hierarchyRootIds[0];
  const nodeById = useMemo(
    () => new Map(run.graph.nodes.map((node) => [node.id, node])),
    [run.graph.nodes]
  );
  const parentByChild = useMemo(() => {
    const result = new Map<string, string>();
    for (const [parent, children] of run.hierarchyChildren) {
      for (const child of children) result.set(child, parent);
    }
    return result;
  }, [run.hierarchyChildren]);

  useEffect(() => {
    if (!selectedNodeId) return;
    setExpanded((current) => {
      const next = new Set(current);
      let cursor: string | undefined = selectedNodeId;
      while (cursor) {
        next.add(cursor);
        cursor = parentByChild.get(cursor);
      }
      return next;
    });
  }, [parentByChild, selectedNodeId]);

  const preview = useMemo(() => {
    if (selectedValue === undefined) return 'Wert nicht gefunden';
    const json = JSON.stringify(selectedValue, null, 2);
    return json.length > 12_000
      ? `${json.slice(0, 12_000)}\n\n… Vorschau gekürzt. Die Laufdatei bleibt vollständig erhalten.`
      : json;
  }, [selectedValue]);

  const copy = async (kind: 'path' | 'value', text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1200);
  };

  return (
    <section className="flex-1 min-w-0 h-full flex flex-col bg-apple-bg">
      <header className="shrink-0 px-5 py-4 border-b border-apple-border bg-gradient-to-r from-apple-purple/[0.08] via-transparent to-apple-blue/[0.06]">
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-apple-purple">
              <FileJson2 className="w-3.5 h-3.5" />
              Phase-X-Lauf · Originaldaten
            </div>
            <h1 className="mt-1.5 text-base font-semibold tracking-tight text-apple-text-primary truncate">
              {run.summary.workflowName}
            </h1>
            <p className="mt-1 text-[11px] text-apple-text-secondary">
              {run.summary.workflowId}
              <span className="mx-2 text-apple-text-muted">·</span>
              Lauf <span className="font-mono text-apple-text-primary">{run.summary.runId}</span>
              <span className="mx-2 text-apple-text-muted">·</span>
              <span>{statusLabel(run.summary.status)}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Metric value={run.stats.graphNodes} label="Knoten" />
            <Metric value={run.stats.scalarValues} label="Werte" />
            <Metric value={run.stats.graphEdges} label="Kanten" />
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[44%] min-w-[330px] max-w-[620px] flex flex-col border-r border-apple-border bg-apple-panel/45">
          <div className="h-10 px-4 flex items-center justify-between border-b border-apple-border-subtle shrink-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
              Inhalt des Laufs
            </span>
            <span className="text-[10px] text-apple-text-muted">Gespeicherte Reihenfolge</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto py-2 px-2">
            {run.hierarchyRootIds.map((rootId) => (
              <HierarchyRow
                key={rootId}
                nodeId={rootId}
                depth={0}
                nodeById={nodeById}
                childrenById={run.hierarchyChildren}
                pointerByNodeId={run.pointerByNodeId}
                expanded={expanded}
                selectedNodeId={selectedNodeId}
                onToggle={(id) => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>

        <article className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 px-5 py-4 border-b border-apple-border-subtle">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
                  Ausgewählter Knoten
                </span>
                <h2 className="mt-1 text-sm font-semibold text-apple-text-primary truncate">
                  {selectedNodeId ? nodeTitle(nodeById.get(selectedNodeId)!) : 'Kein Knoten'}
                </h2>
                <p className="mt-1 font-mono text-[10px] text-apple-text-tertiary break-all">
                  JSON-Pfad {selectedPointer || '/'}
                </p>
              </div>
              {selectedNodeId && (
                <button
                  onClick={() => onShowGraph(selectedNodeId)}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-apple-blue/30 bg-apple-blue/10 px-3 py-1.5 text-[11px] font-medium text-apple-blue hover:bg-apple-blue/20 transition-colors"
                >
                  <Network className="w-3.5 h-3.5" />
                  Im Graph zeigen
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto p-5">
            <div className="max-w-3xl">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-apple-text-secondary">Vollständige JSON-Daten</span>
                <div className="flex items-center gap-1">
                  <CopyButton label="Pfad" copied={copied === 'path'} onClick={() => void copy('path', selectedPointer || '/')} />
                  <CopyButton label="Inhalt" copied={copied === 'value'} onClick={() => void copy('value', preview)} />
                </div>
              </div>
              <pre className="min-h-[180px] rounded-xl border border-white/[0.08] bg-[#0c0e13] p-4 text-[11px] leading-relaxed text-[#c7cad4] whitespace-pre-wrap break-words select-text shadow-inner">
                {preview}
              </pre>
              <p className="mt-3 text-[10px] leading-relaxed text-apple-text-muted">
                Die Hierarchie folgt ausschließlich den geordneten CONTAINS-Verbindungen. Der Graph
                ist schreibgeschützt und verändert die vollständige Laufdatei nicht.
              </p>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
};

interface HierarchyRowProps {
  nodeId: string;
  depth: number;
  nodeById: Map<string, GraphNode>;
  childrenById: Map<string, string[]>;
  pointerByNodeId: Map<string, string>;
  expanded: Set<string>;
  selectedNodeId: string | undefined;
  onToggle: (id: string) => void;
  onSelect: (pointer: string, nodeId: string) => void;
}

const HierarchyRow: React.FC<HierarchyRowProps> = (props) => {
  const node = props.nodeById.get(props.nodeId);
  if (!node) return null;
  const children = props.childrenById.get(props.nodeId) ?? [];
  const open = props.expanded.has(props.nodeId);
  const pointer = props.pointerByNodeId.get(props.nodeId) ?? '';
  const selected = props.selectedNodeId === props.nodeId;

  return (
    <div>
      <div
        className={`group flex items-center min-w-max rounded-md pr-2 transition-colors ${
          selected
            ? 'bg-apple-blue/15 text-white ring-1 ring-inset ring-apple-blue/25'
            : 'text-apple-text-secondary hover:bg-white/[0.045] hover:text-apple-text-primary'
        }`}
        style={{ paddingLeft: `${props.depth * 16 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => children.length > 0 && props.onToggle(props.nodeId)}
          aria-label={open ? 'Zuklappen' : 'Aufklappen'}
          className={`w-6 h-8 flex items-center justify-center shrink-0 ${children.length === 0 ? 'invisible' : ''}`}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => props.onSelect(pointer, props.nodeId)}
          className="h-8 flex-1 min-w-0 flex items-center gap-2 text-left"
        >
          {children.length > 0
            ? <FolderTree className="w-3.5 h-3.5 text-apple-purple shrink-0" />
            : <Braces className="w-3.5 h-3.5 text-apple-blue shrink-0" />}
          <span className="text-xs font-medium truncate max-w-[250px]">{nodeTitle(node)}</span>
          <span className="text-[9px] uppercase tracking-wide text-apple-text-muted">{node.labels[0]}</span>
        </button>
      </div>
      {open && children.map((childId) => (
        <HierarchyRow key={childId} {...props} nodeId={childId} depth={props.depth + 1} />
      ))}
    </div>
  );
};

const Metric: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="min-w-[72px] rounded-lg border border-white/[0.07] bg-black/20 px-2.5 py-1.5 text-right">
    <div className="font-mono text-xs font-semibold text-apple-text-primary tabular-nums">{value.toLocaleString('de-DE')}</div>
    <div className="text-[9px] uppercase tracking-wide text-apple-text-muted">{label}</div>
  </div>
);

const CopyButton: React.FC<{ label: string; copied: boolean; onClick: () => void }> = ({ label, copied, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-apple-text-tertiary hover:bg-white/[0.06] hover:text-apple-text-primary transition-colors"
  >
    {copied ? <Check className="w-3 h-3 text-apple-green" /> : <Copy className="w-3 h-3" />}
    {copied ? 'Kopiert' : label}
  </button>
);

function statusLabel(status: string): string {
  if (status === 'succeeded') return 'Abgeschlossen';
  if (status === 'failed') return 'Fehlgeschlagen';
  if (status === 'partial') return 'Teilweise abgeschlossen';
  if (status === 'loaded') return 'Geladen';
  return status;
}
