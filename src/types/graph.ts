/**
 * The property-graph model Database Studio works on — deliberately the same shape
 * Neo4j and Memgraph use, so a graph can be pushed to either without a
 * conversion step: nodes carry labels, relationships carry a single type, both
 * carry free-form properties.
 */

export type PropertyValue = string | number | boolean | null | string[];

export interface GraphNode {
  /** Stable within one graph; used as the key in every edge. */
  id: string;
  /** Neo4j allows several labels per node; the first one drives the colour. */
  labels: string[];
  properties: Record<string, PropertyValue>;
}

export interface GraphEdge {
  id: string;
  /** Relationship type, upper snake case by convention: `MENTIONS`, `AUTHORED_BY`. */
  type: string;
  from: string;
  to: string;
  properties: Record<string, PropertyValue>;
}

export interface GraphMetadata {
  /** File name without a path, or the name given when the graph was created. */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Where the content came from — one entry per ingest run. */
  sources: GraphSource[];
}

export interface GraphSource {
  id: string;
  kind: SourceKind;
  url: string;
  title: string;
  ingestedAt: string;
  /** Node ids created by this run, so a source can be removed again. */
  nodeIds: string[];
}

export type SourceKind = 'website' | 'video' | 'social' | 'manual' | 'import' | 'coordination';

export interface GraphDocument {
  /** Bumped when the on-disk shape changes incompatibly. */
  version: 1;
  metadata: GraphMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Aggregated counts the sidebar and the statistics tab render. */
export interface GraphSchema {
  labels: LabelStat[];
  relationshipTypes: RelationshipStat[];
  propertyKeys: string[];
}

export interface LabelStat {
  label: string;
  count: number;
  /** Property keys seen on nodes carrying this label, most frequent first. */
  propertyKeys: string[];
}

export interface RelationshipStat {
  type: string;
  count: number;
  /** Distinct `label → label` pairs this type connects. */
  pairs: Array<{ from: string; to: string; count: number }>;
}

export type ActiveTab = 'graph' | 'hierarchy' | 'query' | 'ontology' | 'ingest' | 'stats' | 'api';

/** Result rows of a query, kept generic so the grid can render anything. */
export interface QueryResult {
  columns: string[];
  rows: PropertyValue[][];
  /** Nodes and edges the query touched, so the canvas can highlight them. */
  nodeIds: string[];
  edgeIds: string[];
  durationMs: number;
}
