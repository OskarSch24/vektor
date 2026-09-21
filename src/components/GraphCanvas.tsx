import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, ListTree, Maximize2, Minus, Pause, Play, Plus } from 'lucide-react';
import { GraphEdge, GraphNode } from '../types/graph';
import { ForceLayout } from '../lib/layout';
import { labelColor, nodeTitle, truncate } from '../lib/graph';

interface GraphCanvasProps {
  active?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Ids a query matched; everything else is dimmed. */
  highlighted: Set<string> | null;
  /** Labels the user switched off in the sidebar. */
  hiddenLabels: Set<string>;
  searchTerm: string;
  /** Phase-X runs use their stored CONTAINS order; ordinary graphs keep the force simulation. */
  layoutMode?: 'force' | 'hierarchy';
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/**
 * Renders the graph on a 2D canvas rather than as SVG or DOM nodes.
 *
 * A few thousand nodes is normal after a handful of ingests, and that is one to
 * two orders of magnitude past what an SVG scene graph handles at 60 fps. The
 * canvas draws only what is inside the viewport, so zooming in on a dense
 * cluster costs less, not more.
 */
export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  active = true,
  nodes,
  edges,
  selectedId,
  onSelect,
  highlighted,
  hiddenLabels,
  searchTerm,
  layoutMode = 'force',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(new ForceLayout());
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const frameRef = useRef(0);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{
    nodeId: string | null;
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const [isRunning, setIsRunning] = useState(true);
  const [zoomLabel, setZoomLabel] = useState(100);
  const previousLayoutMode = useRef(layoutMode);

  const visibleNodes = useMemo(
    () => nodes.filter((node) => !node.labels.some((label) => hiddenLabels.has(label))),
    [nodes, hiddenLabels]
  );

  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes]
  );

  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)),
    [edges, visibleNodeIds]
  );

  const matchedIds = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (term === '') return null;
    const result = new Set<string>();
    for (const node of visibleNodes) {
      if (nodeTitle(node).toLowerCase().includes(term)) result.add(node.id);
    }
    return result;
  }, [searchTerm, visibleNodes]);

  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes]
  );

  // MARK: - Simulation

  useEffect(() => {
    // sync() decides how much heat the change deserves: a full restart for a
    // new graph, a nudge for nodes joining an existing one.
    layoutRef.current.sync(visibleNodes, visibleEdges);
    if (layoutMode === 'hierarchy') {
      applyHierarchyLayout(layoutRef.current, visibleNodes, visibleEdges);
      hasUserMovedView.current = false;
      setIsRunning(false);
    } else {
      // Only release positions when returning from hierarchy mode. Normal
      // force-graph refreshes must keep nodes the user deliberately parked.
      if (previousLayoutMode.current === 'hierarchy') layoutRef.current.unpinAll();
      setIsRunning(true);
    }
    previousLayoutMode.current = layoutMode;
  }, [layoutMode, visibleNodes, visibleEdges]);

  /** Fits every node into the viewport with a margin. */
  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const bounds = layoutRef.current.bounds();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const graphWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const graphHeight = Math.max(bounds.maxY - bounds.minY, 1);
    // Hierarchy labels sit below every node and are part of what the user is
    // reading. Leave them more breathing room than a compact force graph so
    // the lowest label does not collide with the map controls.
    const fitPadding = layoutMode === 'hierarchy' ? 200 : 120;

    const scale = Math.min(2, Math.max(0.05, Math.min((width - fitPadding) / graphWidth, (height - fitPadding) / graphHeight)));
    viewportRef.current = {
      scale,
      x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
      y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
    };
    setZoomLabel(Math.round(scale * 100));
  }, [layoutMode]);

  /**
   * Until the user pans, zooms or drags, the view keeps itself fitted to the
   * graph on every frame. That way the layout stays framed while it settles and
   * while an ingest adds nodes — and stops moving on its own the instant the
   * user takes over, which is the only time auto-framing is unwelcome.
   */
  const hasUserMovedView = useRef(false);
  useEffect(() => {
    hasUserMovedView.current = false;
  }, [nodes.length === 0]);

  // MARK: - Render loop

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * ratio;
      canvas.height = container.clientHeight * ratio;
      canvas.style.width = `${container.clientWidth}px`;
      canvas.style.height = `${container.clientHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const draw = () => {
      const layout = layoutRef.current;
      if (layoutMode === 'force' && isRunning) {
        // Several ticks per frame: the simulation converges in wall-clock time
        // the user is willing to watch, without raising the frame rate.
        for (let i = 0; i < 3; i += 1) {
          if (!layout.tick()) {
            setIsRunning(false);
            break;
          }
        }
      }

      if (!hasUserMovedView.current && visibleNodes.length > 0) {
        fitToView();
      }

      paint(context, container, {
        layout,
        viewport: viewportRef.current,
        nodes: visibleNodes,
        edges: visibleEdges,
        nodeById,
        selectedId,
        hoveredId: hoveredRef.current,
        highlighted,
        matchedIds,
        layoutMode,
      });

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frameRef.current);
      observer.disconnect();
    };
  }, [active, visibleNodes, visibleEdges, nodeById, selectedId, highlighted, matchedIds, isRunning, fitToView, layoutMode]);

  // MARK: - Interaction

  /** Canvas pixel → simulation coordinates. */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const viewport = viewportRef.current;
    return {
      x: (clientX - rect.left - viewport.x) / viewport.scale,
      y: (clientY - rect.top - viewport.y) / viewport.scale,
    };
  }, []);

  const nodeAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const world = toWorld(clientX, clientY);
      const layout = layoutRef.current;
      let best: { id: string; distance: number } | null = null;

      for (const node of visibleNodes) {
        const position = layout.getNode(node.id);
        if (!position) continue;
        const radius = nodeRadius(position.mass);
        const distance = Math.hypot(position.x - world.x, position.y - world.y);
        if (distance <= radius && (!best || distance < best.distance)) {
          best = { id: node.id, distance };
        }
      }

      return best?.id ?? null;
    },
    [toWorld, visibleNodes]
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    hasUserMovedView.current = true;
    const hit = nodeAt(event.clientX, event.clientY);
    dragRef.current = {
      nodeId: layoutMode === 'force' ? hit : null,
      lastX: event.clientX,
      lastY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    };
    onSelect(hit);
    if (hit && layoutMode === 'force') {
      // Double-click releases a parked node back into the layout.
      if (event.detail === 2 && layoutRef.current.isPinned(hit)) {
        const position = layoutRef.current.getNode(hit)!;
        layoutRef.current.setPosition(hit, position.x, position.y, false);
        layoutRef.current.reheat(0.25);
        dragRef.current = null;
        return;
      }
      const world = toWorld(event.clientX, event.clientY);
      layoutRef.current.setPosition(hit, world.x, world.y, true);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;

    if (!drag) {
      const hit = nodeAt(event.clientX, event.clientY);
      if (hit !== hoveredRef.current) {
        hoveredRef.current = hit;
        event.currentTarget.style.cursor = hit ? 'pointer' : 'grab';
      }
      return;
    }

    if (drag.nodeId && layoutMode === 'force') {
      const world = toWorld(event.clientX, event.clientY);
      layoutRef.current.setPosition(drag.nodeId, world.x, world.y, true);
      // Warm, not hot: the neighbours follow the dragged node, the rest of the
      // graph stays where it is.
      layoutRef.current.keepWarm();
      setIsRunning(true);
    } else {
      viewportRef.current.x += event.clientX - drag.lastX;
      viewportRef.current.y += event.clientY - drag.lastY;
    }

    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    // A node stays where it was put. Releasing it back into the simulation
    // used to let the whole neighbourhood rearrange around it — the very thing
    // the user had just moved it to avoid. Double-click frees it again.
    if (drag?.nodeId && layoutMode === 'force') {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
      const position = layoutRef.current.getNode(drag.nodeId);
      if (position) layoutRef.current.setPosition(drag.nodeId, position.x, position.y, moved);
      if (moved) layoutRef.current.reheat(0.2);
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    hasUserMovedView.current = true;
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const viewport = viewportRef.current;

    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.min(4, Math.max(0.05, viewport.scale * factor));

    // Zoom towards the cursor: the point under it must not move.
    viewport.x = pointerX - ((pointerX - viewport.x) / viewport.scale) * scale;
    viewport.y = pointerY - ((pointerY - viewport.y) / viewport.scale) * scale;
    viewport.scale = scale;
    setZoomLabel(Math.round(scale * 100));
  };

  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    hasUserMovedView.current = true;
    const viewport = viewportRef.current;
    const centreX = canvas.clientWidth / 2;
    const centreY = canvas.clientHeight / 2;
    const scale = Math.min(4, Math.max(0.05, viewport.scale * factor));
    viewport.x = centreX - ((centreX - viewport.x) / viewport.scale) * scale;
    viewport.y = centreY - ((centreY - viewport.y) / viewport.scale) * scale;
    viewport.scale = scale;
    setZoomLabel(Math.round(scale * 100));
  };

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 min-h-0 graph-grid bg-apple-bg">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        className="absolute inset-0 touch-none select-none"
        style={{ cursor: 'grab' }}
      />

      {visibleNodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-xs text-apple-text-tertiary">
            Keine Knoten sichtbar — Labels in der Seitenleiste prüfen.
          </p>
        </div>
      )}

      {layoutMode === 'hierarchy' && visibleNodes.length > 0 && (
        <div className="absolute top-4 left-4 pointer-events-none inline-flex items-center gap-1.5 rounded-lg border border-apple-purple/25 bg-apple-panel/90 px-2.5 py-1.5 text-[10px] font-medium text-apple-text-secondary shadow-apple-sm backdrop-blur-glass">
          <ListTree className="w-3.5 h-3.5 text-apple-purple" />
          Hierarchie · oben nach unten
        </div>
      )}

      {/* Canvas controls, bottom right like every map application. */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 p-1 rounded-xl glass-panel shadow-apple-md select-none">
        {layoutMode === 'force' && (
          <>
            <CanvasButton
              onClick={() => {
                layoutRef.current.reheat(0.9);
                setIsRunning((running) => !running);
              }}
              title={isRunning ? 'Simulation anhalten' : 'Simulation fortsetzen'}
            >
              {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </CanvasButton>

            <div className="w-px h-5 bg-white/[0.08]" />
          </>
        )}

        <CanvasButton onClick={() => zoomBy(1 / 1.25)} title="Verkleinern">
          <Minus className="w-3.5 h-3.5" />
        </CanvasButton>

        <span className="px-1.5 text-[11px] font-mono text-apple-text-tertiary tabular-nums w-11 text-center">
          {zoomLabel}%
        </span>

        <CanvasButton onClick={() => zoomBy(1.25)} title="Vergrößern">
          <Plus className="w-3.5 h-3.5" />
        </CanvasButton>

        <div className="w-px h-5 bg-white/[0.08]" />

        <CanvasButton
          onClick={() => {
            hasUserMovedView.current = false;
            if (layoutMode === 'force') {
              layoutRef.current.unpinAll();
              setIsRunning(true);
            }
            fitToView();
          }}
          title={layoutMode === 'hierarchy'
            ? 'Gesamte Hierarchie einpassen'
            : 'Alles einpassen — löst geparkte Knoten und lässt den Ausschnitt wieder folgen'}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </CanvasButton>

        <CanvasButton
          onClick={() => {
            if (!selectedId) return;
            const position = layoutRef.current.getNode(selectedId);
            const canvas = canvasRef.current;
            if (!position || !canvas) return;
            hasUserMovedView.current = true;
            const viewport = viewportRef.current;
            viewport.x = canvas.clientWidth / 2 - position.x * viewport.scale;
            viewport.y = canvas.clientHeight / 2 - position.y * viewport.scale;
          }}
          title="Auswahl zentrieren"
          disabled={!selectedId}
        >
          <Crosshair className="w-3.5 h-3.5" />
        </CanvasButton>
      </div>
    </div>
  );
};

/**
 * Places a CONTAINS forest from top to bottom. `ordinal` controls sibling
 * order; semantic edges are deliberately ignored for placement and remain
 * visible as cross-links. Parents sit above the centre of their children.
 */
function applyHierarchyLayout(
  layout: ForceLayout,
  nodes: GraphNode[],
  edges: GraphEdge[]
): void {
  const horizontalGap = 210;
  const verticalGap = 150;
  const rootGap = 120;
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const nodeIds = new Set(nodeOrder.keys());
  const incoming = new Set<string>();
  const grouped = new Map<string, Array<{ id: string; ordinal: number; edgeIndex: number }>>();

  edges.forEach((edge, edgeIndex) => {
    if (edge.type !== 'CONTAINS' || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
    incoming.add(edge.to);
    const ordinal = typeof edge.properties.ordinal === 'number'
      ? edge.properties.ordinal
      : edgeIndex + 1;
    const children = grouped.get(edge.from) ?? [];
    children.push({ id: edge.to, ordinal, edgeIndex });
    grouped.set(edge.from, children);
  });

  const childrenById = new Map<string, string[]>();
  for (const [parent, children] of grouped) {
    childrenById.set(
      parent,
      children
        .sort((a, b) => a.ordinal - b.ordinal || a.edgeIndex - b.edgeIndex)
        .map((child) => child.id)
    );
  }

  const roots = nodes
    .filter((node) => !incoming.has(node.id))
    .sort((a, b) => {
      const aPosition = typeof a.properties.position === 'number' ? a.properties.position : Infinity;
      const bPosition = typeof b.properties.position === 'number' ? b.properties.position : Infinity;
      return aPosition - bPosition || (nodeOrder.get(a.id)! - nodeOrder.get(b.id)!);
    })
    .map((node) => node.id);

  const positions = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  let nextLeafX = 0;

  const place = (id: string, depth: number): number => {
    if (visited.has(id)) return positions.get(id)?.x ?? nextLeafX;
    visited.add(id);
    const children = (childrenById.get(id) ?? []).filter((child) => !visited.has(child));
    let x: number;
    if (children.length === 0) {
      x = nextLeafX;
      nextLeafX += horizontalGap;
    } else {
      const childXs = children.map((child) => place(child, depth + 1));
      x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }
    positions.set(id, { x, y: depth * verticalGap });
    return x;
  };

  for (const root of roots) {
    place(root, 0);
    nextLeafX += rootGap;
  }
  // Defensive fallback for an incomplete projection. Canonical Phase-X runs
  // are validated first, but hidden labels can split the visible forest.
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      place(node.id, 0);
      nextLeafX += rootGap;
    }
  }

  if (positions.size === 0) return;
  const xs = [...positions.values()].map((position) => position.x);
  const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
  for (const [id, position] of positions) {
    layout.setPosition(id, position.x - centreX, position.y, true);
  }
}

const CanvasButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, children }) => (
  <button
    onClick={onClick}
    title={title}
    disabled={disabled}
    className="p-1.5 rounded-lg text-apple-text-secondary hover:text-white hover:bg-white/[0.08] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
  >
    {children}
  </button>
);

// MARK: - Painting

/**
 * Node size grows with degree, but slowly and with a ceiling. Mass is
 * 1 + √degree, so a hub with 500 edges has mass 23; a linear radius made it a
 * disc 160 units across that swallowed its own neighbourhood, and ordinary
 * pages (mass ≈ 3) were wider than the spring that separates them. Capped at
 * 22 units, two neighbours 90 units apart never touch.
 */
function nodeRadius(mass: number): number {
  return Math.min(22, 4 + 1.6 * mass);
}

interface PaintState {
  layout: ForceLayout;
  viewport: Viewport;
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  selectedId: string | null;
  hoveredId: string | null;
  highlighted: Set<string> | null;
  matchedIds: Set<string> | null;
  layoutMode: 'force' | 'hierarchy';
}

function paint(context: CanvasRenderingContext2D, container: HTMLDivElement, state: PaintState): void {
  const width = container.clientWidth;
  const height = container.clientHeight;
  const { viewport, layout } = state;

  context.clearRect(0, 0, width, height);
  context.save();
  context.translate(viewport.x, viewport.y);
  context.scale(viewport.scale, viewport.scale);

  // Only paint what is on screen. At high zoom this skips almost the whole
  // graph, which is exactly when the per-node cost is highest.
  const margin = 120;
  const view = {
    minX: -viewport.x / viewport.scale - margin,
    minY: -viewport.y / viewport.scale - margin,
    maxX: (width - viewport.x) / viewport.scale + margin,
    maxY: (height - viewport.y) / viewport.scale + margin,
  };

  const isDimmed = (id: string): boolean => {
    if (state.highlighted && !state.highlighted.has(id)) return true;
    if (state.matchedIds && !state.matchedIds.has(id)) return true;
    return false;
  };

  // MARK: Edges

  context.lineWidth = 1 / viewport.scale + 0.4;
  for (const edge of state.edges) {
    const from = layout.getNode(edge.from);
    const to = layout.getNode(edge.to);
    if (!from || !to) continue;
    if (Math.max(from.x, to.x) < view.minX || Math.min(from.x, to.x) > view.maxX) continue;
    if (Math.max(from.y, to.y) < view.minY || Math.min(from.y, to.y) > view.maxY) continue;

    const touchesSelection = edge.from === state.selectedId || edge.to === state.selectedId;
    const dimmed = isDimmed(edge.from) && isDimmed(edge.to);

    const hierarchyEdge = state.layoutMode === 'hierarchy' && edge.type === 'CONTAINS';
    const hierarchyCrossLink = state.layoutMode === 'hierarchy' && edge.type !== 'CONTAINS';
    let controlX: number | null = null;
    let controlY: number | null = null;
    context.strokeStyle = touchesSelection
      ? 'rgba(10, 132, 255, 0.75)'
      : dimmed
        ? 'rgba(255, 255, 255, 0.05)'
        : hierarchyEdge
          ? 'rgba(191, 90, 242, 0.34)'
          : 'rgba(255, 255, 255, 0.16)';

    context.beginPath();
    if (hierarchyEdge) {
      const middleY = from.y + (to.y - from.y) / 2;
      context.moveTo(from.x, from.y);
      context.lineTo(from.x, middleY);
      context.lineTo(to.x, middleY);
      context.lineTo(to.x, to.y);
    } else if (hierarchyCrossLink) {
      // A semantic relationship may connect the same two nodes as CONTAINS in
      // the opposite direction. Curve it away from the hierarchy spine so the
      // two meanings remain visually distinct instead of being drawn on top of
      // each other.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.hypot(dx, dy) || 1;
      const direction = edge.id.localeCompare(`${edge.from}:${edge.to}`) >= 0 ? 1 : -1;
      const bend = Math.min(72, Math.max(38, distance * 0.24)) * direction;
      controlX = (from.x + to.x) / 2 + (-dy / distance) * bend;
      controlY = (from.y + to.y) / 2 + (dx / distance) * bend;
      context.moveTo(from.x, from.y);
      context.quadraticCurveTo(controlX, controlY, to.x, to.y);
    } else {
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    }
    context.stroke();

    // Arrow heads only once the view is close enough for them to be legible.
    if (viewport.scale > 0.55 && !dimmed) {
      const angle = hierarchyEdge
        ? Math.PI / 2
        : Math.atan2(to.y - (controlY ?? from.y), to.x - (controlX ?? from.x));
      const radius = nodeRadius(to.mass);
      const tipX = to.x - Math.cos(angle) * radius;
      const tipY = to.y - Math.sin(angle) * radius;
      const size = 6;

      context.fillStyle = touchesSelection ? 'rgba(10, 132, 255, 0.85)' : 'rgba(255, 255, 255, 0.28)';
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(
        tipX - Math.cos(angle - 0.4) * size,
        tipY - Math.sin(angle - 0.4) * size
      );
      context.lineTo(
        tipX - Math.cos(angle + 0.4) * size,
        tipY - Math.sin(angle + 0.4) * size
      );
      context.closePath();
      context.fill();
    }

    // Relationship type, drawn only for the selection to avoid a wall of text.
    if (touchesSelection && viewport.scale > 0.7 && !hierarchyEdge) {
      context.save();
      context.font = `${10 / viewport.scale + 4}px -apple-system, sans-serif`;
      context.fillStyle = 'rgba(255, 255, 255, 0.55)';
      context.textAlign = 'center';
      const labelX = controlX === null
        ? (from.x + to.x) / 2
        : (from.x + 2 * controlX + to.x) / 4;
      const labelY = controlY === null
        ? (from.y + to.y) / 2 - 4
        : (from.y + 2 * controlY + to.y) / 4 - 4;
      context.fillText(edge.type, labelX, labelY);
      context.restore();
    }
  }

  // MARK: Nodes

  const labelCandidates: LabelCandidate[] = [];

  for (const node of state.nodes) {
    const position = layout.getNode(node.id);
    if (!position) continue;
    if (position.x < view.minX || position.x > view.maxX) continue;
    if (position.y < view.minY || position.y > view.maxY) continue;

    const radius = nodeRadius(position.mass);
    const colour = labelColor(node.labels[0] ?? 'Node');
    const selected = node.id === state.selectedId;
    const hovered = node.id === state.hoveredId;
    const dimmed = isDimmed(node.id) && !selected;

    context.globalAlpha = dimmed ? 0.18 : 1;

    if (selected) {
      context.beginPath();
      context.arc(position.x, position.y, radius + 7, 0, Math.PI * 2);
      context.fillStyle = 'rgba(10, 132, 255, 0.18)';
      context.fill();
    }

    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.fillStyle = colour;
    context.fill();

    context.lineWidth = selected ? 3 : hovered ? 2 : 1.5;
    context.strokeStyle = selected
      ? '#FFFFFF'
      : hovered
        ? 'rgba(255, 255, 255, 0.7)'
        : 'rgba(10, 12, 16, 0.85)';
    context.stroke();

    // A parked node wears a thin outer ring, so it is visible why it does not
    // move with the others.
    if (state.layoutMode === 'force' && position.pinned && !dimmed) {
      context.beginPath();
      context.arc(position.x, position.y, radius + 4, 0, Math.PI * 2);
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      context.stroke();
    }

    if (!dimmed || selected || state.layoutMode === 'hierarchy') {
      labelCandidates.push({ node, position, radius, selected, hovered, dimmed });
    }

    context.globalAlpha = 1;
  }

  // MARK: Labels
  //
  // Force graphs show labels only for interaction and search. In a deliberately
  // spaced hierarchy the names are the content, so every non-colliding label is
  // eligible.

  const fontSize = Math.min(15, 11 / viewport.scale + 3);
  const lineHeight = fontSize * 1.25;
  context.font = `500 ${fontSize}px -apple-system, "SF Pro Text", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'top';

  // An occupancy grid in screen pixels; a label claims the cells it covers.
  const cell = 14;
  const occupied = new Set<string>();
  const claim = (sx: number, sy: number, w: number, h: number): boolean => {
    const cells: string[] = [];
    for (let x = Math.floor((sx - w / 2) / cell); x <= Math.floor((sx + w / 2) / cell); x += 1) {
      for (let y = Math.floor(sy / cell); y <= Math.floor((sy + h) / cell); y += 1) {
        const key = `${x},${y}`;
        if (occupied.has(key)) return false;
        cells.push(key);
      }
    }
    for (const key of cells) occupied.add(key);
    return true;
  };

  const wanted = labelCandidates
    .filter((c) =>
      state.layoutMode === 'hierarchy' ||
      c.selected ||
      c.hovered ||
      Boolean(state.matchedIds?.has(c.node.id))
    )
    .sort((a, b) => {
      const rank = (c: LabelCandidate) => (c.selected ? 2 : c.hovered ? 1 : 0);
      return rank(b) - rank(a) || b.position.mass - a.position.mass;
    });

  for (const candidate of wanted) {
    const { node, position, radius, selected, hovered } = candidate;
    const text = truncate(nodeTitle(node), selected || hovered ? 48 : 28);
    const width = context.measureText(text).width * viewport.scale + 8;
    const sx = position.x * viewport.scale + viewport.x;
    const sy = (position.y + radius + 5) * viewport.scale + viewport.y;

    // Many search matches can crowd; the selected and hovered node always
    // get their label, the rest only where nothing sits already.
    if (!selected && !hovered && !claim(sx, sy, width, lineHeight * viewport.scale)) continue;
    if (selected || hovered) claim(sx, sy, width, lineHeight * viewport.scale);

    context.globalAlpha = 1;
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(10, 12, 16, 0.9)';
    context.strokeText(text, position.x, position.y + radius + 5);
    context.fillStyle = selected ? '#FFFFFF' : 'rgba(245, 245, 247, 0.82)';
    context.fillText(text, position.x, position.y + radius + 5);
  }

  context.restore();
}

interface LabelCandidate {
  node: GraphNode;
  position: { x: number; y: number; mass: number };
  radius: number;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
}
