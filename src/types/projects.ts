import type { VaultDatabase } from '../vault/types/projects';

/** An ordinary graph or immutable Phase-X run found inside a project folder. */
export interface ProjectFileNode {
  kind: 'file';
  fileType?:
    | 'graph'
    | 'phase-x-run'
    | 'sqlite'
    | 'csv'
    | 'json-table'
    | 'excel'
    | 'document'
    | 'parquet'
    | 'arrow'
    | 'duckdb'
    | 'connection'
    | 'redis-rdb'
    | 'redis-aof';
  /** The absolute path — stable across re-scans, so it doubles as the id. */
  id: string;
  name: string;
  path: string;
  size: number;
  /** Last modification, epoch milliseconds. `0` when unknown. */
  modified: number;
  /** SQLite sidecar contains changes not visible to sql.js until checkpoint. */
  pendingWal?: boolean;
}

/** A folder that holds at least one graph file somewhere below it. */
export interface ProjectFolderNode {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
  children: ProjectNode[];
  /**
   * Presentation-only group for numbered table shards such as
   * `ag_01.json` ... `ag_71.json`. The files stay separate on disk because
   * producer workflows address them individually; the Explorer may show them
   * as one quiet logical collection.
   */
  collection?: {
    partCount: number;
    pattern: string;
  };
}

export type ProjectNode = ProjectFileNode | ProjectFolderNode;

export interface Project {
  id: string;
  name: string;
  path: string;
  children: ProjectNode[];
  fileCount: number;
  /** Redis artifacts discovered by the same native scan, for the Vault view. */
  redisDatabases?: VaultDatabase[];
  redisDatabaseCount?: number;
  redisTruncated?: boolean;
  /** Set when the folder could not be read — moved, deleted, no permission. */
  error?: string;
}

/** Depth-first walk over every file in a subtree. */
export function* walkFiles(nodes: ProjectNode[]): Generator<ProjectFileNode> {
  for (const node of nodes) {
    if (node.kind === 'file') yield node;
    else yield* walkFiles(node.children);
  }
}
