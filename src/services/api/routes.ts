import { graphEngine } from '../graphEngine';
import { runQuery } from '../query';
import type { GraphEdge, GraphNode, PropertyValue } from '../../types/graph';

/**
 * The graph HTTP surface of Database Studio, resolved against the graph open in
 * the window right now.
 *
 * Everything here runs in the renderer, on the same in-memory graph the canvas
 * draws. A second process reading the `.graph` file would miss whatever an
 * ingest run added in the last few seconds, and would see nothing at all for a
 * graph that has never been saved.
 */

export interface ApiCall {
  method: string;
  path: string;
  /** The external, namespaced path before the dispatcher selected an adapter. */
  publicPath?: string;
  query: Record<string, string>;
  body: unknown;
}

export interface ApiReply {
  status: number;
  payload: unknown;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

const ok = (payload: unknown): ApiReply => ({ status: 200, payload });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiReply => ({
  status,
  payload: { error, ...extra },
});

function readLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function readOffset(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** A node with its degree, which is what a caller usually wants next. */
function describeNode(node: GraphNode) {
  return {
    id: node.id,
    labels: node.labels,
    properties: node.properties,
    degree: graphEngine.incidentEdges(node.id).length,
  };
}

const describeEdge = (edge: GraphEdge) => ({
  id: edge.id,
  type: edge.type,
  from: edge.from,
  to: edge.to,
  properties: edge.properties,
});

/** Free-text match across a node's labels and property values. */
function matchesSearch(node: GraphNode, term: string): boolean {
  const needle = term.toLowerCase();
  if (node.id.toLowerCase().includes(needle)) return true;
  if (node.labels.some((label) => label.toLowerCase().includes(needle))) return true;
  return Object.values(node.properties).some((value) =>
    String(value ?? '').toLowerCase().includes(needle)
  );
}

export interface RouterContext {
  /** Whether the window currently allows writes over the API. */
  allowWrites: boolean;
  /** Called after any change, so the canvas and the autosave catch up. */
  onGraphChanged?: () => void;
  /** Opens a `.graph` file from disk into the live session. */
  openPath?: (path: string) => Promise<{ name: string; nodeCount: number; edgeCount: number }>;
}

const ROUTES = [
  'GET    /api/v1/graph/health',
  'GET    /api/v1/graph/schema',
  'GET    /api/v1/graph/graph',
  'GET    /api/v1/graph/sources',
  'GET    /api/v1/graph/nodes?label=&search=&limit=&offset=',
  'GET    /api/v1/graph/nodes/:id',
  'GET    /api/v1/graph/nodes/:id/neighbours',
  'GET    /api/v1/graph/edges?type=&from=&to=&limit=&offset=',
  'POST   /api/v1/graph/query    { query }  — Cypher-Teilmenge',
  'POST   /api/v1/graph/nodes    { id?, labels, properties }',
  'PATCH  /api/v1/graph/nodes/:id { properties }',
  'DELETE /api/v1/graph/nodes/:id',
  'POST   /api/v1/graph/edges    { id?, type, from, to, properties? }',
  'DELETE /api/v1/graph/edges/:id',
  'POST   /api/v1/graph/open     { path }',
];

export async function route(call: ApiCall, context: RouterContext): Promise<ApiReply> {
  // Kennungen kommen prozentkodiert an (studio-mcp nutzt encodeURIComponent):
  // „organization%3Afacebook“ muss als „organization:facebook“ gesucht werden.
  const segments = call.path.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean).map(decodeSegment);
  const [head, id, sub] = segments;

  switch (head ?? '') {
    case '':
    case 'health':
      return call.method === 'GET' ? ok(health()) : unknown(call);

    case 'schema':
      return requireGraph(() => ok({ name: graphEngine.getName(), ...graphEngine.getSchema() }));

    case 'graph':
      return requireGraph(() => ok(graphEngine.toDocument()));

    case 'sources':
      return requireGraph(() => ok({ sources: graphEngine.getSources() }));

    case 'nodes':
      return nodes(call, context, id, sub);

    case 'edges':
      return edges(call, context, id);

    case 'query':
      return call.method === 'POST' ? cypher(call) : unknown(call);

    case 'open':
      return call.method === 'POST' ? openFile(call, context) : unknown(call);

    default:
      return unknown(call);
  }
}

const unknown = (call: ApiCall): ApiReply =>
  fail(404, `Unbekannte Route: ${call.method} ${call.publicPath ?? call.path}`, { routes: ROUTES });

function requireGraph(handler: () => ApiReply): ApiReply {
  if (!graphEngine.isLoaded()) return fail(409, 'Kein Graph geladen.');
  return handler();
}

function requireWrites(context: RouterContext, handler: () => ApiReply): ApiReply {
  if (!context.allowWrites) {
    return fail(403, 'Schreibende Aufrufe sind über die API abgeschaltet.', {
      hint: 'Im API-Tab der App "Schreibzugriff erlauben" aktivieren.',
    });
  }
  const reply = handler();
  if (reply.status < 400) context.onGraphChanged?.();
  return reply;
}

// MARK: - Handlers

export function health() {
  if (!graphEngine.isLoaded()) return { loaded: false, graph: null };
  return {
    loaded: true,
    graph: {
      name: graphEngine.getName(),
      nodeCount: graphEngine.nodeCount(),
      edgeCount: graphEngine.edgeCount(),
      sourceCount: graphEngine.getSources().length,
    },
  };
}

function nodes(
  call: ApiCall,
  context: RouterContext,
  id: string | undefined,
  sub: string | undefined
): ApiReply {
  if (call.method === 'POST' && !id) {
    return requireWrites(context, () => createNode(call));
  }

  if (id && call.method === 'PATCH') {
    return requireWrites(context, () => patchNode(call, id));
  }

  if (id && call.method === 'DELETE') {
    return requireWrites(context, () => {
      if (!graphEngine.getNode(id)) return fail(404, `Unbekannter Knoten: "${id}"`);
      graphEngine.deleteNode(id);
      return ok({ deleted: true, id });
    });
  }

  if (call.method !== 'GET') return unknown(call);

  return requireGraph(() => {
    if (!id) return listNodes(call);

    const node = graphEngine.getNode(id);
    if (!node) return fail(404, `Unbekannter Knoten: "${id}"`);

    if (sub === 'neighbours' || sub === 'neighbors') {
      return ok({
        node: describeNode(node),
        neighbours: graphEngine.neighbours(id).map(describeNode),
        edges: graphEngine.incidentEdges(id).map(describeEdge),
      });
    }
    if (sub) return fail(404, `Unbekannter Unterpfad: "${sub}"`);

    return ok({
      ...describeNode(node),
      edges: graphEngine.incidentEdges(id).map(describeEdge),
    });
  });
}

function listNodes(call: ApiCall): ApiReply {
  const limit = readLimit(call.query.limit);
  const offset = readOffset(call.query.offset);
  const label = call.query.label;
  const search = call.query.search?.trim();

  let matched = graphEngine.getNodes();
  if (label) matched = matched.filter((node) => node.labels.includes(label));
  if (search) matched = matched.filter((node) => matchesSearch(node, search));

  const page = matched.slice(offset, offset + limit);
  return ok({
    nodes: page.map(describeNode),
    limit,
    offset,
    totalCount: matched.length,
    hasMore: offset + page.length < matched.length,
  });
}

function createNode(call: ApiCall): ApiReply {
  const body = (call.body ?? {}) as {
    id?: string;
    labels?: string[];
    properties?: Record<string, PropertyValue>;
  };

  if (!graphEngine.isLoaded()) return fail(409, 'Kein Graph geladen.');

  const id = body.id?.trim() || `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Asked before the upsert: afterwards the node exists either way, and the
  // caller needs to know which of the two happened.
  const existed = graphEngine.getNode(id) !== undefined;

  const created = graphEngine.upsertNode({
    id,
    labels: Array.isArray(body.labels) ? body.labels : [],
    properties: body.properties ?? {},
  });

  return {
    status: existed ? 200 : 201,
    payload: {
      node: describeNode(created),
      merged: existed,
      // `upsertNode` fills gaps rather than overwriting, so say so instead of
      // letting a caller believe a PATCH happened.
      note: existed
        ? 'Vorhandener Knoten ergänzt; bestehende Werte blieben stehen. Zum Überschreiben PATCH /api/v1/graph/nodes/:id verwenden.'
        : undefined,
    },
  };
}

function patchNode(call: ApiCall, id: string): ApiReply {
  if (!graphEngine.getNode(id)) return fail(404, `Unbekannter Knoten: "${id}"`);
  const body = (call.body ?? {}) as { properties?: Record<string, PropertyValue> };
  if (!body.properties || typeof body.properties !== 'object') {
    return fail(400, 'Feld "properties" fehlt.');
  }
  graphEngine.updateNodeProperties(id, body.properties);
  return ok({ node: describeNode(graphEngine.getNode(id)!) });
}

function edges(call: ApiCall, context: RouterContext, id: string | undefined): ApiReply {
  if (call.method === 'POST' && !id) {
    return requireWrites(context, () => createEdge(call));
  }

  if (id && call.method === 'DELETE') {
    return requireWrites(context, () => {
      if (!graphEngine.getEdge(id)) return fail(404, `Unbekannte Kante: "${id}"`);
      graphEngine.deleteEdge(id);
      return ok({ deleted: true, id });
    });
  }

  if (call.method !== 'GET') return unknown(call);

  return requireGraph(() => {
    if (id) {
      const edge = graphEngine.getEdge(id);
      return edge ? ok(describeEdge(edge)) : fail(404, `Unbekannte Kante: "${id}"`);
    }

    const limit = readLimit(call.query.limit);
    const offset = readOffset(call.query.offset);

    let matched = graphEngine.getEdges();
    if (call.query.type) matched = matched.filter((edge) => edge.type === call.query.type);
    if (call.query.from) matched = matched.filter((edge) => edge.from === call.query.from);
    if (call.query.to) matched = matched.filter((edge) => edge.to === call.query.to);

    const page = matched.slice(offset, offset + limit);
    return ok({
      edges: page.map(describeEdge),
      limit,
      offset,
      totalCount: matched.length,
      hasMore: offset + page.length < matched.length,
    });
  });
}

function createEdge(call: ApiCall): ApiReply {
  if (!graphEngine.isLoaded()) return fail(409, 'Kein Graph geladen.');

  const body = (call.body ?? {}) as {
    id?: string;
    type?: string;
    from?: string;
    to?: string;
    properties?: Record<string, PropertyValue>;
  };

  if (!body.type || !body.from || !body.to) {
    return fail(400, 'Felder "type", "from" und "to" werden gebraucht.');
  }

  const created = graphEngine.upsertEdge({
    id: body.id?.trim() || `${body.from}-${body.type}-${body.to}`,
    type: body.type,
    from: body.from,
    to: body.to,
    properties: body.properties ?? {},
  });

  if (!created) {
    return fail(409, 'Kante nicht angelegt: mindestens ein Endknoten fehlt im Graphen.', {
      from: body.from,
      to: body.to,
    });
  }
  return { status: 201, payload: { edge: describeEdge(created) } };
}

function cypher(call: ApiCall): ApiReply {
  if (!graphEngine.isLoaded()) return fail(409, 'Kein Graph geladen.');

  const body = (call.body ?? {}) as { query?: string; cypher?: string };
  const source = (body.query ?? body.cypher ?? '').trim();
  if (!source) return fail(400, 'Feld "query" fehlt oder ist leer.');

  try {
    const result = runQuery(source);
    return ok({
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      nodeIds: result.nodeIds,
      edgeIds: result.edgeIds,
      durationMs: result.durationMs,
    });
  } catch (err: any) {
    // The query language is a documented subset, so its own error message —
    // which names the unsupported clause — is the most useful thing to return.
    return fail(400, err?.message || String(err), { query: source });
  }
}

async function openFile(call: ApiCall, context: RouterContext): Promise<ApiReply> {
  const body = (call.body ?? {}) as { path?: string };
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return fail(400, 'Feld "path" fehlt.');
  if (!context.openPath) {
    return fail(503, 'Dateien öffnen geht nur in der App, nicht im Browser.');
  }

  try {
    return ok({ opened: true, ...(await context.openPath(path)) });
  } catch (err: any) {
    return fail(400, err?.message || String(err));
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
