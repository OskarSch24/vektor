import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Focus,
  GitBranch,
  Link2,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
} from 'lucide-react';
import {
  friendlyTitle,
  friendlyType,
  shortTitle,
  type PhaseXExplorerSnapshot,
  type PhaseXGraphMode,
} from './PhaseXPresentation';

interface PhaseXGraphViewProps {
  snapshot: PhaseXExplorerSnapshot;
  selectedId: string | null;
  mode: PhaseXGraphMode;
  loading: boolean;
  limited: boolean;
  totalNodeCount: number;
  onSelect: (id: string) => void;
  onModeChange: (mode: PhaseXGraphMode) => void;
  onLoadMore: () => void;
}

interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

interface DrawnEdge {
  id: string;
  from: string;
  to: string;
  semantic: boolean;
}

interface GraphLayout {
  nodes: PositionedNode[];
  positions: Map<string, PositionedNode>;
  edges: DrawnEdge[];
  width: number;
  height: number;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const NODE_WIDTH = 178;
const NODE_HEIGHT = 68;
const COLUMN_GAP = 42;
const ROW_GAP = 86;
const WORLD_PADDING = 52;
const MAX_DRAWN_NODES = 120;
const MAX_DRAWN_RELATIONS = 260;

export const PhaseXGraphView: React.FC<PhaseXGraphViewProps> = ({
  snapshot,
  selectedId,
  mode,
  loading,
  limited,
  totalNodeCount,
  onSelect,
  onModeChange,
  onLoadMore,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 24, y: 24, scale: 1 });
  const layout = useMemo(() => buildLayout(snapshot, mode), [snapshot, mode]);

  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!container || layout.nodes.length === 0) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scale = Math.min(1.15, Math.max(0.06, Math.min((width - 80) / layout.width, (height - 90) / layout.height)));
    setViewport({
      scale,
      x: (width - layout.width * scale) / 2,
      y: Math.max(28, (height - layout.height * scale) / 2),
    });
  }, [layout.height, layout.nodes.length, layout.width]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(fit);
    return () => window.cancelAnimationFrame(frame);
  }, [fit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(container);
    return () => observer.disconnect();
  }, [fit]);

  const zoomAround = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    const container = containerRef.current;
    if (!container) return;
    const point = anchor ?? { x: container.clientWidth / 2, y: container.clientHeight / 2 };
    setViewport((current) => {
      const scale = Math.min(2.5, Math.max(0.05, current.scale * factor));
      return {
        scale,
        x: point.x - ((point.x - current.x) / current.scale) * scale,
        y: point.y - ((point.y - current.y) / current.scale) * scale,
      };
    });
  }, []);

  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-phase-node]')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y };
  };

  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setViewport((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y,
    }));
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const displayedCount = layout.nodes.length;
  const hiddenLoaded = Math.max(0, snapshot.nodes.size - displayedCount);

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_15%,rgba(10,132,255,0.075),transparent_46%)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-apple-border bg-black/10 px-4 py-2.5">
        <div className="inline-flex rounded-lg border border-white/[0.07] bg-black/25 p-0.5" aria-label="Graph-Inhalt">
          <GraphModeButton
            active={mode === 'structure'}
            onClick={() => onModeChange('structure')}
            icon={<GitBranch className="h-3.5 w-3.5" />}
          >
            Nur Struktur
          </GraphModeButton>
          <GraphModeButton
            active={mode === 'all'}
            onClick={() => onModeChange('all')}
            icon={<Link2 className="h-3.5 w-3.5" />}
          >
            Alle Verbindungen
          </GraphModeButton>
        </div>

        <div className="min-w-0 flex-1 text-[11px] text-apple-text-tertiary">
          {displayedCount.toLocaleString('de-DE')} sichtbar
          {totalNodeCount > 0 && ` · ${totalNodeCount.toLocaleString('de-DE')} im Datenraum gefunden`}
        </div>

        {(limited || hiddenLoaded > 0) && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-apple-blue/25 bg-apple-blue/10 px-3 text-[11px] font-medium text-apple-cyan hover:bg-apple-blue/15 disabled:opacity-45"
          >
            {loading && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            Gewählten Zweig nachladen
          </button>
        )}
      </div>

      {(limited || hiddenLoaded > 0) && (
        <div className="border-b border-apple-amber/15 bg-apple-amber/[0.055] px-4 py-2 text-[11px] leading-relaxed text-[#d9b273]">
          Damit der Graph lesbar bleibt, werden höchstens {MAX_DRAWN_NODES} Einträge gleichzeitig gezeichnet.
          Wähle einen Eintrag aus und lade seinen Zweig nach, um dort weiterzugehen.
        </div>
      )}

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onWheel={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          zoomAround(Math.exp(-event.deltaY * 0.0013), {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          });
        }}
      >
        {layout.nodes.length === 0 && !loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.035] text-apple-cyan">
              <GitBranch className="h-5 w-5" />
            </span>
            <p className="text-[13px] font-medium">Für diesen Bereich wurde noch keine Struktur geladen.</p>
            <p className="mt-1 max-w-md text-[11.5px] leading-relaxed text-apple-text-tertiary">
              Lade einen begrenzten Ausschnitt. Der vollständige Datenbestand bleibt dabei unverändert.
            </p>
            <button
              type="button"
              onClick={onLoadMore}
              className="mt-4 rounded-lg bg-apple-blue px-3.5 py-2 text-[11.5px] font-medium text-white hover:bg-apple-blue-hover"
            >
              Struktur laden
            </button>
          </div>
        ) : (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            }}
          >
            <svg className="pointer-events-none absolute inset-0 overflow-visible" width={layout.width} height={layout.height}>
              <defs>
                <marker id="phase-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(100,210,255,0.55)" />
                </marker>
                <marker id="phase-link-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(191,90,242,0.58)" />
                </marker>
              </defs>
              {layout.edges.map((edge) => {
                const from = layout.positions.get(edge.from);
                const to = layout.positions.get(edge.to);
                if (!from || !to) return null;
                const startX = from.x + NODE_WIDTH / 2;
                const startY = from.y + NODE_HEIGHT;
                const endX = to.x + NODE_WIDTH / 2;
                const endY = edge.semantic ? to.y + NODE_HEIGHT / 2 : to.y;
                const controlY = startY + (endY - startY) * 0.52;
                const path = edge.semantic
                  ? `M ${startX} ${from.y + NODE_HEIGHT / 2} C ${startX + 45} ${controlY}, ${endX - 45} ${controlY}, ${endX} ${endY}`
                  : `M ${startX} ${startY} C ${startX} ${controlY}, ${endX} ${controlY}, ${endX} ${endY}`;
                return (
                  <path
                    key={edge.id}
                    d={path}
                    fill="none"
                    stroke={edge.semantic ? 'rgba(191,90,242,0.42)' : 'rgba(100,210,255,0.34)'}
                    strokeWidth={edge.semantic ? 1.25 : 1.4}
                    strokeDasharray={edge.semantic ? '5 5' : undefined}
                    markerEnd={edge.semantic ? 'url(#phase-link-arrow)' : 'url(#phase-arrow)'}
                  />
                );
              })}
            </svg>

            {layout.nodes.map((position) => {
              const node = snapshot.nodes.get(position.id);
              const selected = selectedId === position.id;
              return (
                <button
                  key={position.id}
                  type="button"
                  data-phase-node
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(position.id);
                  }}
                  title={friendlyTitle(node)}
                  className={`absolute flex flex-col justify-center overflow-hidden rounded-[14px] border px-3 text-left shadow-[0_12px_34px_rgba(0,0,0,0.32)] transition-colors ${
                    selected
                      ? 'border-apple-blue bg-[#1b3550] ring-2 ring-apple-blue/25'
                      : 'border-white/[0.1] bg-[#171b24]/95 hover:border-apple-cyan/45 hover:bg-[#1b202b]'
                  }`}
                  style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                >
                  <span className="line-clamp-2 text-[11.5px] font-semibold leading-snug text-white">
                    {shortTitle(node, 64)}
                  </span>
                  <span className={`mt-1 text-[9px] font-semibold uppercase tracking-[0.1em] ${selected ? 'text-[#8fd1ff]' : 'text-apple-text-tertiary'}`}>
                    {friendlyType(node)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {loading && (
          <div className="pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/[0.08] bg-[#12151d]/90 px-3 py-1.5 text-[10.5px] text-apple-text-secondary shadow-apple-md backdrop-blur-xl">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-apple-cyan" />
            Struktur wird behutsam nachgeladen …
          </div>
        )}

        <div className="absolute bottom-4 left-4 flex items-center gap-3 rounded-xl border border-white/[0.07] bg-[#11141b]/85 px-3 py-2 text-[9.5px] text-apple-text-tertiary shadow-apple-md backdrop-blur-xl">
          <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-apple-cyan/60" /> Struktur</span>
          {mode === 'all' && <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t border-dashed border-apple-purple/70" /> Weitere Verbindung</span>}
        </div>

        <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl border border-white/[0.08] bg-[#11141b]/88 p-1 shadow-apple-md backdrop-blur-xl">
          <CanvasButton title="Verkleinern" onClick={() => zoomAround(0.82)}><Minus className="h-3.5 w-3.5" /></CanvasButton>
          <span className="min-w-11 text-center text-[9.5px] tabular-nums text-apple-text-tertiary">{Math.round(viewport.scale * 100)} %</span>
          <CanvasButton title="Vergrößern" onClick={() => zoomAround(1.22)}><Plus className="h-3.5 w-3.5" /></CanvasButton>
          <span className="mx-0.5 h-4 w-px bg-white/[0.08]" />
          <CanvasButton title="Alles einpassen" onClick={fit}><Maximize2 className="h-3.5 w-3.5" /></CanvasButton>
          {selectedId && layout.positions.has(selectedId) && (
            <CanvasButton
              title="Auswahl zentrieren"
              onClick={() => {
                const container = containerRef.current;
                const selected = layout.positions.get(selectedId);
                if (!container || !selected) return;
                setViewport((current) => ({
                  ...current,
                  x: container.clientWidth / 2 - (selected.x + NODE_WIDTH / 2) * current.scale,
                  y: container.clientHeight / 2 - (selected.y + NODE_HEIGHT / 2) * current.scale,
                }));
              }}
            >
              <Focus className="h-3.5 w-3.5" />
            </CanvasButton>
          )}
        </div>
      </div>
    </section>
  );
};

function buildLayout(snapshot: PhaseXExplorerSnapshot, mode: PhaseXGraphMode): GraphLayout {
  const ids: string[] = [];
  const queued = new Set<string>();
  const queue = [...snapshot.roots];

  while (queue.length > 0 && ids.length < MAX_DRAWN_NODES) {
    const id = queue.shift()!;
    if (queued.has(id) || !snapshot.nodes.has(id)) continue;
    queued.add(id);
    ids.push(id);
    for (const child of snapshot.children.get(id) ?? []) queue.push(child.id);
  }

  for (const id of snapshot.nodes.keys()) {
    if (ids.length >= MAX_DRAWN_NODES) break;
    if (!queued.has(id)) {
      queued.add(id);
      ids.push(id);
    }
  }

  const visible = new Set(ids);
  const structuralEdges: DrawnEdge[] = [];
  for (const [parent, children] of snapshot.children) {
    if (!visible.has(parent)) continue;
    for (const child of children) {
      if (!visible.has(child.id)) continue;
      structuralEdges.push({ id: `structure:${parent}:${child.id}`, from: parent, to: child.id, semantic: false });
    }
  }

  const semanticEdges: DrawnEdge[] = [];
  if (mode === 'all') {
    for (const [from, edges] of snapshot.edges) {
      if (!visible.has(from)) continue;
      for (const edge of edges) {
        if (!visible.has(edge.target) || from === edge.target) continue;
        semanticEdges.push({
          id: `relation:${from}:${edge.relation}:${edge.target}`,
          from,
          to: edge.target,
          semantic: true,
        });
        if (semanticEdges.length >= MAX_DRAWN_RELATIONS) break;
      }
      if (semanticEdges.length >= MAX_DRAWN_RELATIONS) break;
    }
  }

  const positions = new Map<string, PositionedNode>();
  const placed = new Set<string>();
  let leafIndex = 0;
  let deepest = 0;

  const place = (id: string, depth: number, lineage: Set<string>): number => {
    if (placed.has(id)) return positions.get(id)?.x ?? WORLD_PADDING;
    if (lineage.has(id)) {
      const x = WORLD_PADDING + leafIndex++ * (NODE_WIDTH + COLUMN_GAP);
      positions.set(id, { id, x, y: WORLD_PADDING + depth * (NODE_HEIGHT + ROW_GAP) });
      placed.add(id);
      deepest = Math.max(deepest, depth);
      return x;
    }

    const nextLineage = new Set(lineage).add(id);
    const children = (snapshot.children.get(id) ?? [])
      .map((child) => child.id)
      .filter((child) => visible.has(child) && !placed.has(child));
    const childXs = children.map((child) => place(child, depth + 1, nextLineage));
    const x = childXs.length > 0
      ? childXs.reduce((sum, value) => sum + value, 0) / childXs.length
      : WORLD_PADDING + leafIndex++ * (NODE_WIDTH + COLUMN_GAP);
    positions.set(id, { id, x, y: WORLD_PADDING + depth * (NODE_HEIGHT + ROW_GAP) });
    placed.add(id);
    deepest = Math.max(deepest, depth);
    return x;
  };

  for (const root of snapshot.roots) {
    if (visible.has(root)) place(root, 0, new Set());
  }

  let orphanIndex = 0;
  for (const id of ids) {
    if (placed.has(id)) continue;
    const x = WORLD_PADDING + orphanIndex++ * (NODE_WIDTH + COLUMN_GAP);
    positions.set(id, { id, x, y: WORLD_PADDING + (deepest + 1) * (NODE_HEIGHT + ROW_GAP) });
    placed.add(id);
  }

  // Keep cards on the same depth from overlapping when several parents share a child.
  const byLevel = new Map<number, PositionedNode[]>();
  for (const node of positions.values()) {
    const level = Math.round((node.y - WORLD_PADDING) / (NODE_HEIGHT + ROW_GAP));
    byLevel.set(level, [...(byLevel.get(level) ?? []), node]);
  }
  for (const level of byLevel.values()) {
    level.sort((left, right) => left.x - right.x);
    let rightEdge = -Infinity;
    for (const node of level) {
      node.x = Math.max(node.x, rightEdge + COLUMN_GAP);
      rightEdge = node.x + NODE_WIDTH;
    }
  }

  const nodeList = ids.map((id) => positions.get(id)).filter((node): node is PositionedNode => Boolean(node));
  const width = Math.max(700, ...nodeList.map((node) => node.x + NODE_WIDTH + WORLD_PADDING));
  const height = Math.max(440, ...nodeList.map((node) => node.y + NODE_HEIGHT + WORLD_PADDING));

  return {
    nodes: nodeList,
    positions,
    edges: [...structuralEdges, ...semanticEdges],
    width,
    height,
  };
}

const GraphModeButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ active, onClick, icon, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[10.5px] font-medium transition-colors ${
      active ? 'bg-white/[0.1] text-white shadow-apple-sm' : 'text-apple-text-tertiary hover:text-white'
    }`}
  >
    {icon}
    {children}
  </button>
);

const CanvasButton: React.FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="flex h-7 w-7 items-center justify-center rounded-lg text-apple-text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
  >
    {children}
  </button>
);
