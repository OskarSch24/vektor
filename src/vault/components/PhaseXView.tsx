import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, FileText, GitBranch, Layers3, Link2, LoaderCircle, Network } from 'lucide-react';
import type { Connection } from '../services/redis/connection';
import {
  childrenOf, edgesOf, readNode, rootsOf, survey, EXPECTED_LAYOUT,
  type PhaseXChild, type PhaseXEdge, type PhaseXNode, type PhaseXSurvey,
} from '../services/redis/phaseX';
import { PhaseXGraphView } from './PhaseXGraphView';
import { PhaseXJsonView } from './PhaseXJsonView';
import {
  breadcrumbIds, friendlyField, friendlyRelation, friendlyTitle, friendlyType,
  primaryContent, shortTitle, technicalFields, visibleFields,
  type PhaseXDisplayMode, type PhaseXExplorerSnapshot, type PhaseXGraphMode,
} from './PhaseXPresentation';

interface PhaseXViewProps {
  connection: Connection;
  reloadToken: number;
  onError: (message: string) => void;
}

const ROOT_LIMIT = 80;
const CHILD_LIMIT = 80;
const EDGE_LIMIT = 120;
const GRAPH_NODE_BUDGET = 120;
const BATCH_SIZE = 10;

const VIEWS: Array<{ id: PhaseXDisplayMode; label: string; icon: React.ReactNode }> = [
  { id: 'hierarchy', label: 'Hierarchie', icon: <Layers3 className="h-3.5 w-3.5" /> },
  { id: 'graph', label: 'Graph', icon: <GitBranch className="h-3.5 w-3.5" /> },
  { id: 'json', label: 'JSON', icon: <Braces className="h-3.5 w-3.5" /> },
];

export const PhaseXView: React.FC<PhaseXViewProps> = ({ connection, reloadToken, onError }) => {
  const [result, setResult] = useState<PhaseXSurvey | null>(null);
  const [space, setSpace] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<PhaseXDisplayMode>('hierarchy');
  const [graphMode, setGraphMode] = useState<PhaseXGraphMode>('structure');
  const [scanning, setScanning] = useState(true);
  const [loadingRoots, setLoadingRoots] = useState(false);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphLimited, setGraphLimited] = useState(false);
  const [rootLimited, setRootLimited] = useState(false);
  const [revision, setRevision] = useState(0);

  const nodesRef = useRef(new Map<string, PhaseXNode>());
  const childrenRef = useRef(new Map<string, PhaseXChild[]>());
  const edgesRef = useRef(new Map<string, PhaseXEdge[]>());
  const parentsRef = useRef(new Map<string, string>());
  const truncatedChildrenRef = useRef(new Set<string>());
  const truncatedEdgesRef = useRef(new Set<string>());
  const pendingNodesRef = useRef(new Map<string, Promise<PhaseXNode>>());
  const pendingChildrenRef = useRef(new Map<string, Promise<PhaseXChild[]>>());
  const pendingEdgesRef = useRef(new Map<string, Promise<PhaseXEdge[]>>());
  const generationRef = useRef(0);
  const graphBusyRef = useRef(false);
  const graphPrimedRef = useRef(false);
  const changed = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    survey(connection)
      .then((found) => {
        if (cancelled) return;
        setResult(found);
        setSpace((current) => found.spaces.includes(current) ? current : found.spaces[0] ?? '');
      })
      .catch((error) => !cancelled && onError(error?.message || String(error)))
      .finally(() => !cancelled && setScanning(false));
    return () => { cancelled = true; };
  }, [connection, reloadToken, onError]);

  const markLoading = useCallback((ids: string[], loading: boolean) => {
    setLoadingIds((current) => {
      const next = new Set(current);
      for (const id of ids) loading ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  const ensureNode = useCallback((id: string): Promise<PhaseXNode> => {
    const cached = nodesRef.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = pendingNodesRef.current.get(id);
    if (pending) return pending;
    const generation = generationRef.current;
    const request = readNode(connection, space, id).then((node) => {
      if (generation === generationRef.current) { nodesRef.current.set(id, node); changed(); }
      return node;
    }).finally(() => {
      if (pendingNodesRef.current.get(id) === request) pendingNodesRef.current.delete(id);
    });
    pendingNodesRef.current.set(id, request);
    return request;
  }, [changed, connection, space]);

  const hydrateNodes = useCallback(async (ids: string[]) => {
    const unique = [...new Set(ids)].filter(Boolean);
    for (let start = 0; start < unique.length; start += BATCH_SIZE) {
      try { await Promise.all(unique.slice(start, start + BATCH_SIZE).map(ensureNode)); }
      catch (error: any) { onError(error?.message || String(error)); return; }
    }
  }, [ensureNode, onError]);

  const ensureChildren = useCallback((id: string): Promise<PhaseXChild[]> => {
    const cached = childrenRef.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = pendingChildrenRef.current.get(id);
    if (pending) return pending;
    const generation = generationRef.current;
    const request = Promise.all([ensureNode(id).catch(() => null), childrenOf(connection, space, id, 0, CHILD_LIMIT + 1)])
      .then(([node, found]) => {
        const visible = found.slice(0, CHILD_LIMIT);
        if (generation === generationRef.current) {
          childrenRef.current.set(id, visible);
          for (const child of visible) if (!parentsRef.current.has(child.id)) parentsRef.current.set(child.id, id);
          if (found.length > CHILD_LIMIT || (node?.childCount ?? 0) > visible.length) truncatedChildrenRef.current.add(id);
          changed();
        }
        return visible;
      }).finally(() => {
        if (pendingChildrenRef.current.get(id) === request) pendingChildrenRef.current.delete(id);
      });
    pendingChildrenRef.current.set(id, request);
    return request;
  }, [changed, connection, ensureNode, space]);

  const ensureEdges = useCallback((id: string): Promise<PhaseXEdge[]> => {
    const cached = edgesRef.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = pendingEdgesRef.current.get(id);
    if (pending) return pending;
    const generation = generationRef.current;
    const request = edgesOf(connection, space, id, EDGE_LIMIT + 1).then((found) => {
      const visible = found.slice(0, EDGE_LIMIT);
      if (generation === generationRef.current) {
        edgesRef.current.set(id, visible);
        if (found.length > EDGE_LIMIT) truncatedEdgesRef.current.add(id);
        changed();
      }
      return visible;
    }).finally(() => {
      if (pendingEdgesRef.current.get(id) === request) pendingEdgesRef.current.delete(id);
    });
    pendingEdgesRef.current.set(id, request);
    return request;
  }, [changed, connection, space]);

  const selectNode = useCallback(async (id: string) => {
    setSelectedId(id); markLoading([id], true);
    try {
      const [, relations] = await Promise.all([ensureNode(id), ensureEdges(id)]);
      await hydrateNodes(relations.slice(0, 24).map((edge) => edge.target));
    } catch (error: any) { onError(error?.message || String(error)); }
    finally { markLoading([id], false); }
  }, [ensureEdges, ensureNode, hydrateNodes, markLoading, onError]);

  const toggleNode = useCallback(async (id: string) => {
    if (expanded.has(id)) {
      setExpanded((current) => { const next = new Set(current); next.delete(id); return next; });
      return;
    }
    setExpanded((current) => new Set(current).add(id)); markLoading([id], true);
    try { const children = await ensureChildren(id); await hydrateNodes(children.map((child) => child.id)); }
    catch (error: any) { onError(error?.message || String(error)); }
    finally { markLoading([id], false); }
  }, [ensureChildren, expanded, hydrateNodes, markLoading, onError]);

  useEffect(() => {
    if (!space || !result?.present || !result.spaces.includes(space)) return;
    const generation = ++generationRef.current;
    nodesRef.current = new Map(); childrenRef.current = new Map(); edgesRef.current = new Map(); parentsRef.current = new Map();
    truncatedChildrenRef.current = new Set(); truncatedEdgesRef.current = new Set();
    pendingNodesRef.current = new Map(); pendingChildrenRef.current = new Map(); pendingEdgesRef.current = new Map();
    graphPrimedRef.current = false;
    setRoots([]); setSelectedId(null); setExpanded(new Set()); setLoadingIds(new Set()); setGraphLimited(false); setRootLimited(false); setLoadingRoots(true); changed();
    rootsOf(connection, space, ROOT_LIMIT + 1).then(async (found) => {
      if (generation !== generationRef.current) return;
      const visible = found.slice(0, ROOT_LIMIT);
      setRoots(visible); setRootLimited(found.length > ROOT_LIMIT);
      await hydrateNodes(visible);
      if (generation !== generationRef.current || visible.length === 0) return;
      setSelectedId(visible[0]); await ensureEdges(visible[0]).catch(() => []);
    }).catch((error) => generation === generationRef.current && onError(error?.message || String(error)))
      .finally(() => generation === generationRef.current && setLoadingRoots(false));
  }, [changed, connection, ensureEdges, hydrateNodes, onError, result, space]);

  const loadRelations = useCallback(async () => {
    const ids = [...nodesRef.current.keys()].slice(0, GRAPH_NODE_BUDGET);
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      try { await Promise.all(ids.slice(start, start + BATCH_SIZE).map(ensureEdges)); }
      catch (error: any) { onError(error?.message || String(error)); return; }
    }
    const room = Math.max(0, GRAPH_NODE_BUDGET - nodesRef.current.size);
    const targets = [...edgesRef.current.values()].flat().map((edge) => edge.target)
      .filter((id) => !nodesRef.current.has(id)).slice(0, room);
    await hydrateNodes(targets);
  }, [ensureEdges, hydrateNodes, onError]);

  const loadGraph = useCallback(async (focused: boolean) => {
    if (graphBusyRef.current) return;
    graphBusyRef.current = true; setGraphLoading(true);
    const generation = generationRef.current;
    const queue = (focused && selectedId ? [selectedId] : roots).map((id) => ({ id, depth: 0 }));
    // Small runs should open as one complete picture. The shallow preview is
    // only useful once a data room is genuinely larger than the drawing
    // budget; applying it to an eight-node test run made the graph look
    // incomplete and forced a needless second click.
    const depthLimit = focused
      ? 5
      : (result?.nodeCount ?? GRAPH_NODE_BUDGET + 1) <= GRAPH_NODE_BUDGET
        ? 16
        : 3;
    const seen = new Set<string>(); let parentsRead = 0; let limited = false;
    try {
      while (queue.length && parentsRead < 64) {
        if (generation !== generationRef.current) return;
        const next = queue.shift()!;
        if (seen.has(next.id)) continue;
        seen.add(next.id);
        if (!nodesRef.current.has(next.id) && nodesRef.current.size >= GRAPH_NODE_BUDGET) { limited = true; break; }
        await ensureNode(next.id);
        const children = await ensureChildren(next.id); parentsRead += 1;
        if (next.depth >= depthLimit) { if (children.length) limited = true; continue; }
        for (const child of children) {
          if (!nodesRef.current.has(child.id) && nodesRef.current.size + queue.length >= GRAPH_NODE_BUDGET) { limited = true; break; }
          queue.push({ id: child.id, depth: next.depth + 1 });
        }
      }
      await hydrateNodes([...seen].slice(0, GRAPH_NODE_BUDGET));
      if (graphMode === 'all') await loadRelations();
      setGraphLimited(limited || queue.length > 0 || truncatedChildrenRef.current.size > 0 || (result?.nodeCount ?? 0) > nodesRef.current.size);
    } catch (error: any) { onError(error?.message || String(error)); }
    finally { graphBusyRef.current = false; if (generation === generationRef.current) setGraphLoading(false); }
  }, [ensureChildren, ensureNode, graphMode, hydrateNodes, loadRelations, onError, result?.nodeCount, roots, selectedId]);

  useEffect(() => {
    if (view !== 'graph' || !roots.length || graphPrimedRef.current) return;
    graphPrimedRef.current = true; void loadGraph(false);
  }, [loadGraph, roots.length, view]);

  const changeGraphMode = useCallback((next: PhaseXGraphMode) => {
    setGraphMode(next);
    if (next === 'all') { setGraphLoading(true); void loadRelations().finally(() => setGraphLoading(false)); }
  }, [loadRelations]);

  const snapshot = useMemo<PhaseXExplorerSnapshot>(() => ({
    space, roots, nodes: nodesRef.current, children: childrenRef.current, edges: edgesRef.current,
    parents: parentsRef.current, truncatedChildren: truncatedChildrenRef.current, truncatedEdges: truncatedEdgesRef.current,
  }), [revision, roots, space]);

  if (scanning) return <Centered>Der Phase-X-Speicher wird geöffnet …</Centered>;
  if (!result?.present) return <EmptyPhaseX result={result} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-apple-border bg-[#11141b]/88 px-4 py-3">
        <div className="flex min-w-[180px] items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-apple-blue/12 text-apple-cyan"><Layers3 className="h-4 w-4" /></span>
          <div><h2 className="text-[13px] font-semibold">Phase-X-Daten</h2><p className="text-[9.5px] text-apple-text-tertiary">{result.nodeCount.toLocaleString('de-DE')} Einträge gefunden</p></div>
        </div>
        <nav className="mx-auto inline-flex rounded-[10px] border border-white/[0.07] bg-black/25 p-0.5" aria-label="Darstellung wählen">
          {VIEWS.map((option) => <button key={option.id} type="button" onClick={() => setView(option.id)} className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium ${view === option.id ? 'bg-white/[0.1] text-white shadow-apple-sm' : 'text-apple-text-tertiary hover:text-white'}`}>{option.icon}{option.label}</button>)}
        </nav>
        <label className="flex min-w-[190px] items-center gap-2 text-[10px] font-medium text-apple-text-tertiary">Datenbereich
          <select value={space} onChange={(event) => setSpace(event.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-apple-border bg-apple-subtle px-2 text-[11px] text-apple-text-primary focus:outline-none">
            {result.spaces.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </header>
      {rootLimited && <div className="border-b border-apple-amber/15 bg-apple-amber/[0.05] px-4 py-2 text-[10.5px] text-[#d9b273]">Sehr viele Einstiegspunkte: Zunächst werden die ersten {ROOT_LIMIT} gezeigt.</div>}
      {view === 'hierarchy' ? (
        <HierarchyView snapshot={snapshot} selectedId={selectedId} expanded={expanded} loadingIds={loadingIds} loadingRoots={loadingRoots} onSelect={(id) => void selectNode(id)} onToggle={(id) => void toggleNode(id)} />
      ) : view === 'graph' ? (
        <PhaseXGraphView snapshot={snapshot} selectedId={selectedId} mode={graphMode} loading={graphLoading} limited={graphLimited} totalNodeCount={result.nodeCount} onSelect={(id) => void selectNode(id)} onModeChange={changeGraphMode} onLoadMore={() => void loadGraph(true)} />
      ) : (
        <PhaseXJsonView snapshot={snapshot} selectedId={selectedId} expanded={expanded} loadingIds={loadingIds} onSelect={(id) => void selectNode(id)} onToggle={(id) => void toggleNode(id)} />
      )}
    </div>
  );
};

const EmptyPhaseX: React.FC<{ result: PhaseXSurvey | null }> = ({ result }) => (
  <div className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_35%_0%,rgba(10,132,255,0.1),transparent_42%)] p-7">
    <div className="mx-auto max-w-2xl rounded-2xl border border-white/[0.08] bg-[#12151d]/85 p-6 shadow-apple-md">
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-[14px] bg-apple-blue/12 text-apple-cyan"><Layers3 className="h-5 w-5" /></span>
      <h2 className="text-[17px] font-semibold">Noch keine Phase-X-Struktur vorhanden</h2>
      <p className="mt-2 text-[12.5px] leading-relaxed text-apple-text-secondary">Sobald ein Workflow Ergebnisse als Phase-X-Struktur speichert, erscheinen sie hier als Hierarchie, Graph und JSON.</p>
      <details className="mt-5 rounded-xl border border-white/[0.07] bg-black/15 px-4 py-3 text-[11px] text-apple-text-tertiary"><summary className="cursor-pointer font-medium text-apple-text-secondary">Technische Hinweise</summary><p className="mt-3">{result?.note}</p><pre className="mt-3 overflow-x-auto rounded-lg bg-black/25 p-3 font-mono text-[10.5px]">{EXPECTED_LAYOUT.join('\n')}</pre></details>
    </div>
  </div>
);

const HierarchyView: React.FC<{
  snapshot: PhaseXExplorerSnapshot; selectedId: string | null; expanded: ReadonlySet<string>; loadingIds: ReadonlySet<string>; loadingRoots: boolean; onSelect: (id: string) => void; onToggle: (id: string) => void;
}> = ({ snapshot, selectedId, expanded, loadingIds, loadingRoots, onSelect, onToggle }) => {
  const selected = selectedId ? snapshot.nodes.get(selectedId) : undefined;
  return <div className="flex min-h-0 flex-1">
    <aside className="flex w-[390px] shrink-0 flex-col border-r border-apple-border bg-black/[0.07]">
      <div className="border-b border-apple-border px-3 py-2.5"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-apple-text-tertiary">Inhaltliche Struktur</p><p className="mt-1 text-[10.5px] text-apple-text-muted">Zweige werden einzeln geöffnet, damit auch große Bestände schnell bleiben.</p></div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">{loadingRoots && !snapshot.roots.length ? <p className="px-4 py-5 text-[11.5px] text-apple-text-tertiary">Struktur wird geladen …</p> : <HierarchyBranch ids={snapshot.roots} depth={0} snapshot={snapshot} selectedId={selectedId} expanded={expanded} loadingIds={loadingIds} onSelect={onSelect} onToggle={onToggle} />}</div>
      <div className="border-t border-apple-border px-3 py-2 text-[10px] text-apple-text-muted">{snapshot.nodes.size.toLocaleString('de-DE')} Einträge geladen</div>
    </aside>
    <section className="min-w-0 flex-1 overflow-y-auto">{selected ? <NodeDetails node={selected} snapshot={snapshot} onSelect={onSelect} /> : <Centered>Links einen Eintrag auswählen.</Centered>}</section>
  </div>;
};

const HierarchyBranch: React.FC<{
  ids: string[]; depth: number; snapshot: PhaseXExplorerSnapshot; selectedId: string | null; expanded: ReadonlySet<string>; loadingIds: ReadonlySet<string>; onSelect: (id: string) => void; onToggle: (id: string) => void;
}> = ({ ids, depth, snapshot, selectedId, expanded, loadingIds, onSelect, onToggle }) => <ul>{ids.map((id) => {
  const node = snapshot.nodes.get(id); const open = expanded.has(id); const children = snapshot.children.get(id); const canExpand = node ? node.childCount > 0 : true; const busy = loadingIds.has(id);
  return <li key={id}><div className={`flex items-center gap-1.5 border-l-2 py-1.5 pr-2 ${selectedId === id ? 'border-apple-blue bg-apple-blue/12' : 'border-transparent hover:bg-white/[0.035]'}`} style={{ paddingLeft: 7 + depth * 15 }}>
    <button type="button" onClick={() => canExpand && onToggle(id)} disabled={!canExpand || busy} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-apple-text-tertiary disabled:opacity-25">{busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
    <button type="button" onClick={() => onSelect(id)} className="min-w-0 flex-1 text-left"><span className="block truncate text-[11.5px] font-medium text-apple-text-primary">{shortTitle(node, 68)}</span><span className="mt-0.5 block text-[9px] font-semibold uppercase tracking-[0.09em] text-apple-text-muted">{friendlyType(node)}</span></button>
  </div>{open && children?.length ? <HierarchyBranch ids={children.map((child) => child.id)} depth={depth + 1} snapshot={snapshot} selectedId={selectedId} expanded={expanded} loadingIds={loadingIds} onSelect={onSelect} onToggle={onToggle} /> : null}{open && children && !children.length ? <p className="py-1 text-[10px] text-apple-text-muted" style={{ paddingLeft: 45 + depth * 15 }}>Keine untergeordneten Einträge</p> : null}{open && snapshot.truncatedChildren.has(id) ? <p className="py-1 pr-3 text-[9.5px] text-apple-amber" style={{ paddingLeft: 45 + depth * 15 }}>Die ersten {CHILD_LIMIT} Einträge werden gezeigt.</p> : null}</li>;
})}</ul>;

const NodeDetails: React.FC<{ node: PhaseXNode; snapshot: PhaseXExplorerSnapshot; onSelect: (id: string) => void }> = ({ node, snapshot, onSelect }) => {
  const content = primaryContent(node); const fields = visibleFields(node); const internals = technicalFields(node); const relations = snapshot.edges.get(node.id) ?? []; const breadcrumb = breadcrumbIds(node.id, snapshot.parents);
  return <div className="mx-auto max-w-[980px] space-y-5 p-5">
    <div><nav className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-apple-text-tertiary">{breadcrumb.map((id, index) => <React.Fragment key={id}>{index > 0 && <ChevronRight className="h-3 w-3" />}<button type="button" onClick={() => onSelect(id)} className="max-w-48 truncate hover:text-apple-cyan">{shortTitle(snapshot.nodes.get(id), 38)}</button></React.Fragment>)}</nav><h2 className="text-[20px] font-semibold leading-tight text-white">{friendlyTitle(node)}</h2><div className="mt-2 flex flex-wrap gap-2 text-[10px]"><span className="rounded-full bg-apple-blue/10 px-2 py-1 font-semibold uppercase tracking-[0.09em] text-apple-cyan">{friendlyType(node)}</span><span className="rounded-full bg-white/[0.04] px-2 py-1 text-apple-text-tertiary">{node.childCount} untergeordnet</span><span className="rounded-full bg-white/[0.04] px-2 py-1 text-apple-text-tertiary">{node.edgeCount} Verbindungen</span></div></div>
    {content && <section className="rounded-2xl border border-white/[0.075] bg-[#151922]/78 p-5"><h3 className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-apple-text-tertiary"><FileText className="h-3.5 w-3.5 text-apple-cyan" />{friendlyField(content.field)}</h3><p className="whitespace-pre-wrap text-[13px] leading-[1.68] text-[#d7d8dc]">{content.value.length > 6000 ? `${content.value.slice(0, 6000)}…` : content.value}</p></section>}
    {fields.length > 0 && <dl className="overflow-hidden rounded-xl border border-white/[0.075] bg-[#12161e]/65">{fields.map(([field, value]) => <div key={field} className="grid grid-cols-[minmax(130px,0.32fr)_1fr] gap-4 border-b border-white/[0.055] px-4 py-2.5 last:border-0"><dt className="text-[10.5px] font-medium text-apple-text-tertiary">{friendlyField(field)}</dt><dd className="break-words text-[11.5px] text-apple-text-primary">{value}</dd></div>)}</dl>}
    {relations.length > 0 && <section><h3 className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-apple-text-tertiary"><Network className="h-3.5 w-3.5 text-apple-purple" />Weitere Verbindungen</h3><div className="grid gap-2 sm:grid-cols-2">{relations.map((edge, index) => <button key={`${edge.relation}:${edge.target}:${index}`} type="button" onClick={() => onSelect(edge.target)} className="flex min-w-0 items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 text-left hover:border-apple-purple/30"><Link2 className="h-3.5 w-3.5 shrink-0 text-apple-purple" /><span className="min-w-0"><span className="block text-[9px] font-semibold uppercase text-apple-purple">{friendlyRelation(edge.relation)}</span><span className="block truncate text-[11.5px]">{shortTitle(snapshot.nodes.get(edge.target), 58)}</span></span></button>)}</div></section>}
    <details className="rounded-xl border border-white/[0.07] bg-black/15 px-4 py-3 text-[10.5px] text-apple-text-tertiary"><summary className="cursor-pointer font-medium text-apple-text-secondary">Technische Details</summary><dl className="mt-3 grid grid-cols-[130px_1fr] gap-2 font-mono"><dt>ID</dt><dd className="break-all">{node.id}</dd><dt>Speicherform</dt><dd>{node.storage}</dd>{internals.map(([field, value]) => <React.Fragment key={field}><dt>{field}</dt><dd className="break-all">{value}</dd></React.Fragment>)}</dl></details>
  </div>;
};

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="flex flex-1 items-center justify-center p-6 text-center text-[12.5px] text-apple-text-tertiary">{children}</div>;
