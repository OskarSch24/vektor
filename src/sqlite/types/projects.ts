import type { FileFormat } from '../services/importers';

/** A single openable data file inside a project folder. */
export interface ProjectFileNode {
  kind: 'file';
  /** Stable across refreshes: `<projectId>:<relative path>`. */
  id: string;
  name: string;
  /** Absolute path (native host) or path relative to the project root (browser). */
  path: string;
  size: number;
  /** Last modification, epoch milliseconds. `0` when unknown. */
  modified: number;
  format: FileFormat;
  /**
   * A non-empty `-wal` sidecar sits next to this database: it holds committed
   * changes that the in-memory reader cannot see, so the view may be stale.
   */
  pendingWal?: boolean;
}

/** A folder that contains at least one openable file somewhere below it. */
export interface ProjectFolderNode {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
  children: ProjectNode[];
}

export type ProjectNode = ProjectFileNode | ProjectFolderNode;

export interface Project {
  id: string;
  name: string;
  path: string;
  children: ProjectNode[];
  fileCount: number;
  /** Set when the folder could not be read (moved, deleted, no permission). */
  error?: string;
}

export function isFolder(node: ProjectNode): node is ProjectFolderNode {
  return node.kind === 'folder';
}

/** Depth-first walk over every file in a project subtree. */
export function* walkFiles(nodes: ProjectNode[]): Generator<ProjectFileNode> {
  for (const node of nodes) {
    if (node.kind === 'file') {
      yield node;
    } else {
      yield* walkFiles(node.children);
    }
  }
}
