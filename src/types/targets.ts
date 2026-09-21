/**
 * A "target graph database" is anything the app can write a subgraph into. The
 * popup lists these, the app resolves them.
 */

export type TargetKind = 'local' | 'neo4j' | 'file';

export interface GraphTarget {
  id: string;
  name: string;
  kind: TargetKind;
  /** Local targets: the `.graph` file path the native host owns. */
  path?: string;
  /** Neo4j targets: HTTP endpoint of the transactional API, e.g. `http://localhost:7474`. */
  endpoint?: string;
  database?: string;
  username?: string;
  /** Stored alongside the other settings; never leaves the machine. */
  password?: string;
  createdAt: string;
  /** Filled in by a connection check, purely informational. */
  status?: 'unknown' | 'ok' | 'error';
  statusMessage?: string;
}

/** The write a target adapter has to perform, in one batch. */
export interface GraphWrite {
  nodes: Array<{ id: string; labels: string[]; properties: Record<string, unknown> }>;
  edges: Array<{
    id: string;
    type: string;
    from: string;
    to: string;
    properties: Record<string, unknown>;
  }>;
}

export interface WriteResult {
  nodesWritten: number;
  edgesWritten: number;
}
