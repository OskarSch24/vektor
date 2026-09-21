import { GraphDocument, GraphEdge, GraphNode, GraphSource } from '../../types/graph';
import { GraphTarget, WriteResult } from '../../types/targets';
import { graphEngine } from '../graphEngine';
import { files } from '../nativeHost';

/**
 * Where an ingested subgraph ends up.
 *
 * Three destinations are supported, and each one is honest about what it can
 * do: the graph open in the app, a Neo4j instance over its HTTP transactional
 * API, and a file on disk. Anything speaking Bolt only — Memgraph, for instance
 * — is served by exporting a Cypher script and running it there, which is why
 * there is no half-working driver in here.
 */

export function describeTarget(target: GraphTarget): string {
  switch (target.kind) {
    case 'local':
      return target.path ? target.path : 'Im Programm geöffneter Graph';
    case 'neo4j':
      return `${target.endpoint ?? ''} · ${target.database || 'neo4j'}`;
    case 'file':
      return target.path ?? 'Datei wird beim Schreiben gewählt';
  }
}

/** Writes a subgraph into the target. Returns what was actually written. */
export async function writeToTarget(
  target: GraphTarget,
  nodes: GraphNode[],
  edges: GraphEdge[],
  source?: GraphSource
): Promise<WriteResult> {
  switch (target.kind) {
    case 'local':
      return writeLocal(nodes, edges);
    case 'neo4j':
      return writeNeo4j(target, nodes, edges);
    case 'file':
      return writeFile(target, nodes, edges, source);
  }
}

/** Verifies a target is reachable, for the status dot in the settings dialog. */
export async function checkTarget(target: GraphTarget): Promise<string> {
  if (target.kind === 'local') return 'Bereit';
  if (target.kind === 'file') return target.path ? 'Pfad gesetzt' : 'Pfad wird beim Schreiben gewählt';

  const result = await runCypher(target, [{ statement: 'RETURN 1 AS ok', parameters: {} }]);
  const value = result[0]?.data?.[0]?.row?.[0];
  if (value !== 1) throw new Error('Unerwartete Antwort der Datenbank');

  const version = await runCypher(target, [
    { statement: 'CALL dbms.components() YIELD name, versions RETURN name, versions[0]', parameters: {} },
  ]).catch(() => null);

  const row = version?.[0]?.data?.[0]?.row;
  return row ? `${String(row[0])} ${String(row[1])}` : 'Verbunden';
}

// MARK: - Local

function writeLocal(nodes: GraphNode[], edges: GraphEdge[]): WriteResult {
  let nodesWritten = 0;
  let edgesWritten = 0;

  for (const node of nodes) {
    const before = graphEngine.getNode(node.id);
    graphEngine.upsertNode(node);
    if (!before) nodesWritten += 1;
  }
  for (const edge of edges) {
    const before = graphEngine.getEdge(edge.id);
    if (graphEngine.upsertEdge(edge) && !before) edgesWritten += 1;
  }

  return { nodesWritten, edgesWritten };
}

// MARK: - Neo4j

interface CypherStatement {
  statement: string;
  parameters: Record<string, unknown>;
}

interface CypherResult {
  columns: string[];
  data: Array<{ row: unknown[] }>;
}

async function writeNeo4j(
  target: GraphTarget,
  nodes: GraphNode[],
  edges: GraphEdge[]
): Promise<WriteResult> {
  // Nodes are grouped by their primary label because a Cypher label cannot be
  // parameterised — one statement per label is the only way to MERGE on it.
  const byLabel = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const label = sanitiseIdentifier(node.labels[0] ?? 'Node');
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(node);
    else byLabel.set(label, [node]);
  }

  const statements: CypherStatement[] = [];

  for (const [label, group] of byLabel) {
    statements.push({
      statement: [
        'UNWIND $rows AS row',
        `MERGE (n:${label} {gsId: row.id})`,
        'SET n += row.properties',
        'WITH n, row',
        'CALL apoc.create.addLabels(n, row.extraLabels) YIELD node',
        'RETURN count(node)',
      ].join('\n'),
      parameters: {
        rows: group.map((node) => ({
          id: node.id,
          properties: node.properties,
          extraLabels: node.labels.slice(1).map(sanitiseIdentifier),
        })),
      },
    });
  }

  const byType = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const type = sanitiseIdentifier(edge.type);
    const bucket = byType.get(type);
    if (bucket) bucket.push(edge);
    else byType.set(type, [edge]);
  }

  for (const [type, group] of byType) {
    statements.push({
      statement: [
        'UNWIND $rows AS row',
        'MATCH (a {gsId: row.from})',
        'MATCH (b {gsId: row.to})',
        `MERGE (a)-[r:${type}]->(b)`,
        'SET r += row.properties',
        'RETURN count(r)',
      ].join('\n'),
      parameters: {
        rows: group.map((edge) => ({
          from: edge.from,
          to: edge.to,
          properties: edge.properties,
        })),
      },
    });
  }

  if (statements.length === 0) return { nodesWritten: 0, edgesWritten: 0 };

  try {
    await runCypher(target, statements);
  } catch (err) {
    // APOC is not installed everywhere; without it, multi-label nodes simply
    // keep their primary label, which is better than failing the whole write.
    if (err instanceof Error && /apoc/i.test(err.message)) {
      const withoutApoc = statements.map((statement) => ({
        ...statement,
        statement: statement.statement
          .replace('WITH n, row\nCALL apoc.create.addLabels(n, row.extraLabels) YIELD node\nRETURN count(node)', 'RETURN count(n)'),
      }));
      await runCypher(target, withoutApoc);
    } else {
      throw err;
    }
  }

  return { nodesWritten: nodes.length, edgesWritten: edges.length };
}

async function runCypher(target: GraphTarget, statements: CypherStatement[]): Promise<CypherResult[]> {
  const endpoint = (target.endpoint ?? '').replace(/\/$/, '');
  if (!endpoint) throw new Error('Für dieses Ziel ist kein Endpunkt hinterlegt.');

  const database = target.database || 'neo4j';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.username) {
    headers.Authorization = `Basic ${btoa(`${target.username}:${target.password ?? ''}`)}`;
  }

  const response = await fetch(`${endpoint}/db/${encodeURIComponent(database)}/tx/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ statements }),
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 200) || response.statusText}`);
  }

  const payload = (await response.json()) as {
    results?: CypherResult[];
    errors?: Array<{ code: string; message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  return payload.results ?? [];
}

/**
 * Labels and relationship types are interpolated into Cypher, so they are
 * restricted to a safe character set rather than escaped — a label that needed
 * backticks would be a sign the extraction went wrong anyway.
 */
function sanitiseIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return cleaned || 'Node';
}

// MARK: - File

async function writeFile(
  target: GraphTarget,
  nodes: GraphNode[],
  edges: GraphEdge[],
  source?: GraphSource
): Promise<WriteResult> {
  // A Cypher script is a one-shot export; there is nothing in it to merge with.
  if (target.path?.endsWith('.cypher')) {
    const contents = toCypherScript(nodes, edges);
    if (target.path) await files.write(target.path, contents);
    else await files.saveAs(`${target.name}.cypher`, contents);
    return { nodesWritten: nodes.length, edgesWritten: edges.length };
  }

  // A graph file is a database, not an export: importing a second page into it
  // has to add to what is there. Overwriting would silently discard everything
  // collected before.
  const existing = target.path ? await readGraphDocument(target.path) : null;

  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  for (const node of existing?.nodes ?? []) nodeMap.set(node.id, node);
  for (const edge of existing?.edges ?? []) edgeMap.set(edge.id, edge);

  let nodesWritten = 0;
  let edgesWritten = 0;

  for (const node of nodes) {
    const before = nodeMap.get(node.id);
    if (!before) {
      nodeMap.set(node.id, { ...node, properties: { ...node.properties } });
      nodesWritten += 1;
      continue;
    }
    // Merging keeps what is already there: a later run should not overwrite a
    // value an earlier, possibly better, extraction established.
    for (const label of node.labels) {
      if (!before.labels.includes(label)) before.labels.push(label);
    }
    for (const [key, value] of Object.entries(node.properties)) {
      if (before.properties[key] === undefined || before.properties[key] === null) {
        before.properties[key] = value;
      }
    }
  }

  for (const edge of edges) {
    if (edgeMap.has(edge.id)) continue;
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
    edgeMap.set(edge.id, { ...edge, properties: { ...edge.properties } });
    edgesWritten += 1;
  }

  const document: GraphDocument = {
    version: 1,
    metadata: {
      name: existing?.metadata?.name || target.name,
      createdAt: existing?.metadata?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Recording the source is what makes the file a graph you can maintain
      // rather than an append-only pile: a source can be removed again later.
      sources: source
        ? [source, ...(existing?.metadata?.sources ?? []).filter((entry) => entry.id !== source.id)]
        : existing?.metadata?.sources ?? [],
    },
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };

  const contents = JSON.stringify(document, null, 2);
  if (target.path) await files.write(target.path, contents);
  else await files.saveAs(`${target.name}.graph`, contents);

  return { nodesWritten, edgesWritten };
}

/**
 * Reads an existing graph file. A missing file is a normal case — the target
 * may be a path that does not exist yet — but a file that exists and cannot be
 * parsed is not: overwriting it would destroy data.
 */
async function readGraphDocument(path: string): Promise<GraphDocument | null> {
  let contents: string;
  try {
    contents = (await files.read(path)).contents;
  } catch {
    return null;
  }

  if (contents.trim() === '') return null;

  try {
    const parsed = JSON.parse(contents) as GraphDocument;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('kein Graph-Dokument');
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `"${path}" ist vorhanden, lässt sich aber nicht als Graph lesen (${
        err instanceof Error ? err.message : err
      }). Der Import wurde abgebrochen, statt die Datei zu überschreiben.`
    );
  }
}

/** A standalone Cypher script — the way into Memgraph and any Bolt-only store. */
export function toCypherScript(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines: string[] = [
    '// Von Vektor erzeugt.',
    '// Einspielen z. B. mit:  cypher-shell -f graph.cypher',
    '',
    'CREATE INDEX gs_id IF NOT EXISTS FOR (n:Node) ON (n.gsId);',
    '',
  ];

  for (const node of nodes) {
    const labels = node.labels.map(sanitiseIdentifier).join(':');
    lines.push(
      `MERGE (n:${labels} {gsId: ${literal(node.id)}}) SET n += ${mapLiteral(node.properties)};`
    );
  }

  lines.push('');

  for (const edge of edges) {
    lines.push(
      `MATCH (a {gsId: ${literal(edge.from)}}), (b {gsId: ${literal(edge.to)}}) ` +
        `MERGE (a)-[r:${sanitiseIdentifier(edge.type)}]->(b) SET r += ${mapLiteral(edge.properties)};`
    );
  }

  return lines.join('\n');
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  return JSON.stringify(String(value));
}

function mapLiteral(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}: ${literal(value)}`);
  return `{${entries.join(', ')}}`;
}
