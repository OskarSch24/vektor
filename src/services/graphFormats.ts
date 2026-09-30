import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { GraphDocument, GraphEdge, GraphNode, PropertyValue } from '../types/graph';

/**
 * Reads the common graph exchange formats into Vektor's property graph:
 * GraphML (yEd, Gephi, Neo4j APOC, NetworkX), GEXF (Gephi) and Graphviz DOT.
 *
 * The result is a view on the file. Callers never write it back to the
 * original path; saving produces a separate `.graph`.
 */

export const GRAPH_EXCHANGE_FILE = /\.(?:graphml|gexf|dot|gv)$/i;

const DEFAULT_LABEL = 'Knoten';
const DEFAULT_TYPE = 'VERBUNDEN_MIT';
/** Keeps a pathological file from freezing the canvas. */
const MAX_ELEMENTS = 200_000;

export function isGraphExchangeFile(filename: string): boolean {
  return GRAPH_EXCHANGE_FILE.test(filename);
}

export function parseGraphExchange(text: string, filename: string): GraphDocument {
  const extension = filename.split('.').pop()?.toLowerCase();
  const builder = new GraphBuilder(filename);
  try {
    if (extension === 'graphml') readGraphml(text, builder);
    else if (extension === 'gexf') readGexf(text, builder);
    else readDot(text, builder);
  } catch (err) {
    throw new Error(`"${filename}" konnte nicht als Graph gelesen werden: ${err instanceof Error ? err.message : err}`);
  }
  return builder.document();
}

// MARK: - Builder

class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly edgeIds = new Set<string>();

  constructor(private readonly filename: string) {}

  node(id: string, labels?: string[], properties: Record<string, PropertyValue> = {}): GraphNode {
    let node = this.nodes.get(id);
    if (!node) {
      this.guard();
      node = { id, labels: [], properties: {} };
      this.nodes.set(id, node);
    }
    if (labels?.length) node.labels = unique([...node.labels, ...labels]);
    Object.assign(node.properties, properties);
    return node;
  }

  edge(from: string, to: string, type: string | undefined, properties: Record<string, PropertyValue> = {}, id?: string): void {
    this.guard();
    this.node(from);
    this.node(to);
    let edgeId = id && !this.edgeIds.has(id) ? id : `e${this.edges.length + 1}`;
    while (this.edgeIds.has(edgeId)) edgeId = `${edgeId}_`;
    this.edgeIds.add(edgeId);
    this.edges.push({ id: edgeId, type: relationshipType(type), from, to, properties });
  }

  document(): GraphDocument {
    if (this.nodes.size === 0) throw new Error(`"${this.filename}" enthält keine Knoten.`);
    const now = new Date().toISOString();
    for (const node of this.nodes.values()) {
      if (node.labels.length === 0) node.labels = [DEFAULT_LABEL];
      if (node.properties.name === undefined && node.properties.label === undefined) {
        node.properties.name = node.id;
      }
    }
    return {
      version: 1,
      metadata: {
        name: this.filename.replace(/\.[^.]+$/, ''),
        createdAt: now,
        updatedAt: now,
        sources: [],
      },
      nodes: [...this.nodes.values()],
      edges: this.edges,
    };
  }

  private guard(): void {
    if (this.nodes.size + this.edges.length >= MAX_ELEMENTS) {
      throw new Error(`mehr als ${MAX_ELEMENTS.toLocaleString('de-DE')} Knoten und Kanten`);
    }
  }
}

// MARK: - GraphML

interface GraphmlKey {
  name: string;
  type: string;
  domain: string;
  fallback?: string;
}

function readGraphml(text: string, builder: GraphBuilder): void {
  const root = parseXml(text).graphml;
  if (!root) throw new Error('kein <graphml>-Element');

  const keys = new Map<string, GraphmlKey>();
  for (const key of list(root.key)) {
    const id = attr(key, 'id');
    if (!id) continue;
    keys.set(id, {
      name: attr(key, 'attr.name') ?? attr(key, 'yfiles.type') ?? id,
      type: attr(key, 'attr.type') ?? 'string',
      domain: attr(key, 'for') ?? 'all',
      fallback: textOf(key.default),
    });
  }

  const readData = (element: any, domain: 'node' | 'edge') => {
    const properties: Record<string, PropertyValue> = {};
    for (const key of keys.values()) {
      if (key.fallback !== undefined && (key.domain === domain || key.domain === 'all')) {
        properties[key.name] = typed(key.fallback, key.type);
      }
    }
    for (const data of list(element.data)) {
      const key = keys.get(attr(data, 'key') ?? '');
      const value = textOf(data);
      if (value === undefined) continue;
      properties[key?.name ?? attr(data, 'key') ?? 'wert'] = typed(value, key?.type ?? 'string');
    }
    return properties;
  };

  const visit = (graph: any, directed: boolean) => {
    for (const node of list(graph.node)) {
      const id = attr(node, 'id');
      if (!id) continue;
      const properties = readData(node, 'node');
      builder.node(id, takeLabels(properties), properties);
      for (const nested of list(node.graph)) visit(nested, directed);
    }
    for (const edge of list(graph.edge)) {
      const from = attr(edge, 'source');
      const to = attr(edge, 'target');
      if (!from || !to) continue;
      const properties = readData(edge, 'edge');
      const type = takeString(properties, ['label', 'type', 'relationship', 'relation']);
      const edgeDirected = attr(edge, 'directed');
      if ((edgeDirected === undefined ? !directed : edgeDirected === 'false')) properties.gerichtet = false;
      builder.edge(from, to, type, properties, attr(edge, 'id'));
    }
  };

  for (const graph of list(root.graph)) visit(graph, attr(graph, 'edgedefault') !== 'undirected');
}

// MARK: - GEXF

function readGexf(text: string, builder: GraphBuilder): void {
  const root = parseXml(text).gexf;
  const graph = list(root?.graph)[0];
  if (!graph) throw new Error('kein <gexf><graph>-Element');
  const undirected = attr(graph, 'defaultedgetype') === 'undirected';

  const titles = new Map<string, { title: string; type: string }>();
  for (const block of list(graph.attributes)) {
    const cls = attr(block, 'class') ?? 'node';
    for (const attribute of list(block.attribute)) {
      const id = attr(attribute, 'id');
      if (id) titles.set(`${cls}:${id}`, { title: attr(attribute, 'title') ?? id, type: attr(attribute, 'type') ?? 'string' });
    }
  }

  const readValues = (element: any, cls: string) => {
    const properties: Record<string, PropertyValue> = {};
    for (const values of list(element.attvalues)) {
      for (const value of list(values.attvalue)) {
        const id = attr(value, 'for') ?? attr(value, 'id');
        const raw = attr(value, 'value');
        if (!id || raw === undefined) continue;
        const meta = titles.get(`${cls}:${id}`);
        properties[meta?.title ?? id] = typed(raw, meta?.type ?? 'string');
      }
    }
    return properties;
  };

  for (const nodes of list(graph.nodes)) {
    for (const node of list(nodes.node)) {
      const id = attr(node, 'id');
      if (!id) continue;
      const properties = readValues(node, 'node');
      const label = attr(node, 'label');
      if (label !== undefined) properties.name = label;
      builder.node(id, takeLabels(properties), properties);
    }
  }
  for (const edges of list(graph.edges)) {
    for (const edge of list(edges.edge)) {
      const from = attr(edge, 'source');
      const to = attr(edge, 'target');
      if (!from || !to) continue;
      const properties = readValues(edge, 'edge');
      const weight = attr(edge, 'weight');
      if (weight !== undefined) properties.gewicht = typed(weight, 'double');
      const type = attr(edge, 'label') ?? attr(edge, 'kind') ?? takeString(properties, ['type', 'label']);
      const edgeType = attr(edge, 'type');
      if (edgeType === 'undirected' || (edgeType === undefined && undirected)) properties.gerichtet = false;
      builder.edge(from, to, type, properties, attr(edge, 'id'));
    }
  }
}

// MARK: - Graphviz DOT

type DotToken = { kind: 'id'; value: string } | { kind: 'op'; value: string };

function readDot(text: string, builder: GraphBuilder): void {
  const tokens = tokenizeDot(text);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()!.value === value;
  const expectOp = (value: string) => {
    const token = next();
    if (token?.kind !== 'op' || token.value !== value) throw new Error(`„${value}“ erwartet`);
  };

  // strict? (graph|digraph) ID? {
  if (peek()?.kind === 'id' && peek()!.value.toLowerCase() === 'strict') next();
  const header = next();
  if (header?.kind !== 'id' || !/^(?:di)?graph$/i.test(header.value)) throw new Error('kein graph/digraph');
  const directed = header.value.toLowerCase() === 'digraph';
  if (peek()?.kind === 'id') next();
  expectOp('{');

  const readAttributes = (): Record<string, PropertyValue> => {
    const attributes: Record<string, PropertyValue> = {};
    while (isOp('[')) {
      next();
      while (!isOp(']')) {
        const key = next();
        if (!key) throw new Error('„]“ fehlt');
        if (key.kind === 'op') continue; // separators , ;
        if (isOp('=')) {
          next();
          const value = next();
          attributes[key.value] = value?.kind === 'id' ? typed(value.value, 'auto') : true;
        } else {
          attributes[key.value] = true;
        }
      }
      next();
    }
    return attributes;
  };

  /** A node id or a `{ a b }` / `subgraph { … }` group; returns its node ids. */
  const readOperand = (): string[] => {
    if (peek()?.kind === 'id' && peek()!.value.toLowerCase() === 'subgraph') {
      next();
      if (peek()?.kind === 'id') next();
    }
    if (isOp('{')) {
      next();
      return readStatements();
    }
    const token = next();
    if (token?.kind !== 'id') throw new Error('Knoten erwartet');
    // Ports (`a:port:n`) belong to the same node.
    while (isOp(':')) {
      next();
      next();
    }
    return [token.value];
  };

  function readStatements(): string[] {
    const members: string[] = [];
    while (!isOp('}')) {
      if (!peek()) throw new Error('„}“ fehlt');
      if (isOp(';') || isOp(',')) {
        next();
        continue;
      }
      const first = peek()!;
      if (first.kind === 'id' && /^(?:graph|node|edge)$/i.test(first.value) && tokens[index + 1]?.value === '[') {
        next();
        readAttributes();
        continue;
      }
      if (first.kind === 'id' && tokens[index + 1]?.kind === 'op' && tokens[index + 1].value === '=') {
        index += 3; // graph attribute `rankdir = LR`
        continue;
      }

      const chain = [readOperand()];
      while (isOp('->') || isOp('--')) {
        next();
        chain.push(readOperand());
      }
      const attributes = readAttributes();
      if (chain.length === 1) {
        for (const id of chain[0]) {
          const properties = { ...attributes };
          builder.node(id, takeLabels(properties, ['labels', 'type', 'kind']), rename(properties, 'label', 'name'));
        }
      } else {
        for (let i = 0; i < chain.length - 1; i += 1) {
          for (const from of chain[i]) {
            for (const to of chain[i + 1]) {
              const properties = { ...attributes };
              const type = takeString(properties, ['label', 'type']);
              if (!directed) properties.gerichtet = false;
              builder.edge(from, to, type, properties);
            }
          }
        }
      }
      for (const group of chain) members.push(...group);
    }
    next();
    return members;
  }

  readStatements();
}

function tokenizeDot(text: string): DotToken[] {
  const tokens: DotToken[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '/' && text[i + 1] === '/') { i = lineEnd(text, i); continue; }
    if (char === '#' && (i === 0 || text[i - 1] === '\n')) { i = lineEnd(text, i); continue; }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if ((char === '-' && (text[i + 1] === '>' || text[i + 1] === '-'))) {
      tokens.push({ kind: 'op', value: text.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ('{}[]=;,:'.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      i += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && text[i + 1] === '"') { value += '"'; i += 2; continue; }
        if (text[i] === '\\' && text[i + 1] === '\n') { i += 2; continue; }
        value += text[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'id', value });
      continue;
    }
    if (char === '<') {
      // HTML-like label: keep it as text, nested brackets included.
      let depth = 0;
      const start = i;
      do {
        if (text[i] === '<') depth += 1;
        else if (text[i] === '>') depth -= 1;
        i += 1;
      } while (i < text.length && depth > 0);
      tokens.push({ kind: 'id', value: text.slice(start + 1, i - 1) });
      continue;
    }
    const match = /^(?:-?(?:\.\d+|\d+(?:\.\d*)?)|[A-Za-z_\u0080-￿][\w\u0080-￿]*)/.exec(text.slice(i, i + 256));
    if (!match) throw new Error(`unerwartetes Zeichen „${char}“`);
    tokens.push({ kind: 'id', value: match[0] });
    i += match[0].length;
  }
  return tokens;
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf('\n', from);
  return end < 0 ? text.length : end;
}

// MARK: - Helpers

function parseXml(text: string): any {
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`XML: ${valid.err.msg} (Zeile ${valid.err.line})`);
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    removeNSPrefix: true,
    textNodeName: '#text',
  }).parse(text);
}

function list<T = any>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(element: any, name: string): string | undefined {
  const value = element?.[`@${name}`];
  return value === undefined ? undefined : String(value);
}

function textOf(element: any): string | undefined {
  if (element === undefined || element === null) return undefined;
  if (typeof element !== 'object') return String(element);
  const text = element['#text'];
  return text === undefined ? undefined : String(text);
}

function typed(value: string, type: string): PropertyValue {
  const kind = type.toLowerCase();
  if (kind === 'boolean') return value.trim().toLowerCase() === 'true';
  if (['int', 'integer', 'long', 'float', 'double', 'auto'].includes(kind)) {
    const trimmed = value.trim();
    if (trimmed !== '' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
    if (kind === 'auto' && /^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  }
  return value;
}

/** Neo4j exports labels as `:Person:Actor`; other tools use a type column. */
function takeLabels(properties: Record<string, PropertyValue>, keys = ['labels', 'label_type', 'type', 'kind', 'category']): string[] | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    delete properties[key];
    return value.split(':').map((part) => part.trim()).filter(Boolean);
  }
  return undefined;
}

function takeString(properties: Record<string, PropertyValue>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (value === undefined || value === null || value === '') continue;
    delete properties[key];
    return String(value);
  }
  return undefined;
}

function rename(properties: Record<string, PropertyValue>, from: string, to: string): Record<string, PropertyValue> {
  if (from in properties && !(to in properties)) {
    properties[to] = properties[from];
    delete properties[from];
  }
  return properties;
}

/** Relationship types by convention: upper snake case. */
function relationshipType(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return cleaned || DEFAULT_TYPE;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
