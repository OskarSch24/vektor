import {
  GraphDocument,
  GraphEdge,
  GraphNode,
  GraphSchema,
  GraphSource,
  LabelStat,
  PropertyValue,
  RelationshipStat,
} from '../types/graph';

/**
 * The in-memory property graph every view reads from. One instance per app —
 * the module-level `graphEngine` below — mirroring how `dbEngine` works in
 * SQLite Studio.
 *
 * Nodes and edges are kept in maps plus an adjacency index, so neighbour lookups
 * during layout and traversal stay O(degree) instead of scanning every edge.
 */
class GraphEngine {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  /** node id -> edge ids, both directions. */
  private adjacency = new Map<string, Set<string>>();
  private sources: GraphSource[] = [];
  private name = '';
  private createdAt = '';

  isLoaded(): boolean {
    return this.name !== '';
  }

  // MARK: - Lifecycle

  create(name: string): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.sources = [];
    this.name = name;
    this.createdAt = new Date().toISOString();
  }

  /** Releases the current document without creating a replacement graph. */
  close(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.sources = [];
    this.name = '';
    this.createdAt = '';
  }

  /** Replaces the current graph with a parsed `.graph` document. */
  load(document: GraphDocument, fallbackName: string): void {
    if (document.version !== 1) {
      throw new Error(`Unbekannte Graph-Version: ${(document as { version: number }).version}`);
    }
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();

    for (const node of document.nodes) {
      this.nodes.set(node.id, {
        id: node.id,
        labels: node.labels?.length > 0 ? node.labels : ['Node'],
        properties: node.properties ?? {},
      });
    }
    for (const edge of document.edges) {
      // Edges pointing at nodes that are not in the file would break every
      // traversal later on, so they are dropped at load time rather than
      // guarded against in a dozen places.
      if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) continue;
      this.edges.set(edge.id, { ...edge, properties: edge.properties ?? {} });
      this.link(edge);
    }

    this.name = document.metadata?.name || fallbackName;
    this.createdAt = document.metadata?.createdAt || new Date().toISOString();
    this.sources = document.metadata?.sources ?? [];
  }

  /** Serialises the graph for writing to disk or exporting. */
  toDocument(): GraphDocument {
    return {
      version: 1,
      metadata: {
        name: this.name,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
        sources: this.sources,
      },
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  getName(): string {
    return this.name;
  }

  rename(name: string): void {
    this.name = name;
  }

  // MARK: - Reads

  getNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  getEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  getSources(): GraphSource[] {
    return this.sources;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  /** Edges touching `nodeId`, in either direction. */
  incidentEdges(nodeId: string): GraphEdge[] {
    const ids = this.adjacency.get(nodeId);
    if (!ids) return [];
    const result: GraphEdge[] = [];
    for (const id of ids) {
      const edge = this.edges.get(id);
      if (edge) result.push(edge);
    }
    return result;
  }

  neighbours(nodeId: string): GraphNode[] {
    const seen = new Set<string>();
    const result: GraphNode[] = [];
    for (const edge of this.incidentEdges(nodeId)) {
      const otherId = edge.from === nodeId ? edge.to : edge.from;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const node = this.nodes.get(otherId);
      if (node) result.push(node);
    }
    return result;
  }

  // MARK: - Writes

  /**
   * Inserts a node, or merges into an existing one when the id is already
   * taken. Merging keeps existing property values — an ingest run should never
   * overwrite something a previous, possibly better, run established.
   */
  upsertNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (!existing) {
      const created: GraphNode = {
        id: node.id,
        labels: node.labels.length > 0 ? [...node.labels] : ['Node'],
        properties: { ...node.properties },
      };
      this.nodes.set(created.id, created);
      return created;
    }

    for (const label of node.labels) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    for (const [key, value] of Object.entries(node.properties)) {
      if (existing.properties[key] === undefined || existing.properties[key] === null) {
        existing.properties[key] = value;
      }
    }
    return existing;
  }

  upsertEdge(edge: GraphEdge): GraphEdge | null {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return null;

    const existing = this.edges.get(edge.id);
    if (existing) {
      for (const [key, value] of Object.entries(edge.properties)) {
        if (existing.properties[key] === undefined) existing.properties[key] = value;
      }
      return existing;
    }

    const created: GraphEdge = { ...edge, properties: { ...edge.properties } };
    this.edges.set(created.id, created);
    this.link(created);
    return created;
  }

  updateNodeProperties(id: string, properties: Record<string, PropertyValue>): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.properties = { ...properties };
  }

  deleteNode(id: string): void {
    const edgeIds = this.adjacency.get(id);
    if (edgeIds) {
      for (const edgeId of [...edgeIds]) this.deleteEdge(edgeId);
    }
    this.adjacency.delete(id);
    this.nodes.delete(id);
  }

  deleteEdge(id: string): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.adjacency.get(edge.from)?.delete(id);
    this.adjacency.get(edge.to)?.delete(id);
    this.edges.delete(id);
  }

  addSource(source: GraphSource): void {
    this.sources = [source, ...this.sources.filter((s) => s.id !== source.id)];
  }

  /** Removes a source together with every node it introduced. */
  removeSource(sourceId: string): void {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) return;
    for (const nodeId of source.nodeIds) this.deleteNode(nodeId);
    this.sources = this.sources.filter((s) => s.id !== sourceId);
  }

  private link(edge: GraphEdge): void {
    for (const nodeId of [edge.from, edge.to]) {
      let set = this.adjacency.get(nodeId);
      if (!set) {
        set = new Set();
        this.adjacency.set(nodeId, set);
      }
      set.add(edge.id);
    }
  }

  // MARK: - Schema

  /**
   * Derives labels, relationship types and property keys from the data. A
   * property graph has no declared schema, so this is the only description of
   * its shape that exists.
   */
  getSchema(): GraphSchema {
    const labelCounts = new Map<string, number>();
    const labelProps = new Map<string, Map<string, number>>();
    const propertyKeys = new Set<string>();

    for (const node of this.nodes.values()) {
      for (const label of node.labels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        let props = labelProps.get(label);
        if (!props) {
          props = new Map();
          labelProps.set(label, props);
        }
        for (const key of Object.keys(node.properties)) {
          props.set(key, (props.get(key) ?? 0) + 1);
          propertyKeys.add(key);
        }
      }
    }

    const labels: LabelStat[] = [...labelCounts.entries()]
      .map(([label, count]) => ({
        label,
        count,
        propertyKeys: [...(labelProps.get(label) ?? new Map<string, number>()).entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key]) => key),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const typeCounts = new Map<string, number>();
    const typePairs = new Map<string, Map<string, number>>();

    for (const edge of this.edges.values()) {
      typeCounts.set(edge.type, (typeCounts.get(edge.type) ?? 0) + 1);
      const fromLabel = this.nodes.get(edge.from)?.labels[0] ?? 'Node';
      const toLabel = this.nodes.get(edge.to)?.labels[0] ?? 'Node';
      const key = `${fromLabel} ${toLabel}`;
      let pairs = typePairs.get(edge.type);
      if (!pairs) {
        pairs = new Map();
        typePairs.set(edge.type, pairs);
      }
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }

    const relationshipTypes: RelationshipStat[] = [...typeCounts.entries()]
      .map(([type, count]) => ({
        type,
        count,
        pairs: [...(typePairs.get(type) ?? new Map<string, number>()).entries()]
          .map(([key, pairCount]) => {
            const [from, to] = key.split(' ');
            return { from, to, count: pairCount };
          })
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    return {
      labels,
      relationshipTypes,
      propertyKeys: [...propertyKeys].sort(),
    };
  }
}

export const graphEngine = new GraphEngine();
