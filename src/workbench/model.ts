import type { ProjectFileNode } from '../types/projects';

export type WorkspaceKind = 'home' | 'graph' | 'table' | 'vault';
export type DataWorkspaceKind = Exclude<WorkspaceKind, 'home'>;

export interface ActiveSource {
  kind: WorkspaceKind;
  path: string | null;
  name: string;
  fileType?: ProjectFileNode['fileType'];
  pendingWal?: boolean;
  requestVersion: number;
}

export interface WorkspaceSourceUpdate {
  name: string;
  path?: string | null;
  fileType?: ProjectFileNode['fileType'];
  pendingWal?: boolean;
}

export interface WorkspaceSyncContext {
  ownerTabId: string | null;
  requestVersion: number;
}

/**
 * Tells a resident renderer that a root editor stopped owning one logical
 * session. Renderers use the monotone token as an edge-trigger: tab switching
 * never emits an event, while close/replace does even when the next tab uses
 * the same workspace kind.
 */
export interface WorkspaceDisposeEvent {
  token: number;
  tabId: string;
  sessionKey: string;
  /** False when another open tab still references the same database session. */
  releaseSession: boolean;
  /** True when the disposed tab currently owns the resident engine. */
  unloadActive: boolean;
}

export interface EditorTab {
  id: string;
  source: ActiveSource;
  /** A table/view tab shares the database session but restores its own focus. */
  tableName?: string;
  /** Unsaved in-memory changes. Rendered like Cursor's dirty editor marker. */
  dirty?: boolean;
}

export interface ExternalGraphTarget {
  /** Pathless graph documents live in memory and therefore need a tab identity. */
  sessionKey: string | null;
  /** True when the extension needed a brand-new root editor tab. */
  created: boolean;
}

export type OpenDisposition = 'current' | 'new-tab';

const HOME_SOURCE: ActiveSource = {
  kind: 'home',
  path: null,
  name: 'Neuer Tab',
  requestVersion: 0,
};

export function newHomeSource(requestVersion = 0): ActiveSource {
  return { ...HOME_SOURCE, requestVersion };
}

export function initialEditorTabs(): EditorTab[] {
  return [{ id: 'tab-1', source: newHomeSource() }];
}

export function initialWorkspaceSources(): Record<DataWorkspaceKind, ActiveSource> {
  return {
    graph: {
      kind: 'graph',
      path: null,
      name: 'Graph-Arbeitsraum',
      fileType: 'graph',
      requestVersion: 0,
    },
    table: {
      kind: 'table',
      path: null,
      name: 'Tabellen-Arbeitsraum',
      requestVersion: 0,
    },
    vault: {
      kind: 'vault',
      path: null,
      name: 'Redis-Speicherstand',
      requestVersion: 0,
    },
  };
}

export function workspaceFor(file: Pick<ProjectFileNode, 'fileType' | 'name'>): DataWorkspaceKind {
  switch (file.fileType) {
    case 'sqlite':
    case 'csv':
    case 'json-table':
    case 'excel':
    case 'document':
    case 'parquet':
    case 'arrow':
    case 'duckdb':
    case 'connection':
      return 'table';
    case 'redis-rdb':
    case 'redis-aof':
      return 'vault';
    case 'graph':
    case 'phase-x-run':
      return 'graph';
    default: {
      const lower = file.name.toLocaleLowerCase();
      if (/\.(?:sqlite3?|sqlite2|db3?|csv|tsv|jsonl|ndjson|xlsx|xlsm)$/.test(lower)) return 'table';
      if (/\.(?:rdb|aof)$/.test(lower) || lower.endsWith('.aof.manifest')) return 'vault';
      return 'graph';
    }
  }
}

export function fileTypeForName(name: string): ProjectFileNode['fileType'] {
  const lower = name.toLocaleLowerCase();
  if (/\.dbconnection(?:\.json)?$/.test(lower)) return 'connection';
  if (/\.(?:ya?ml|xml|toml|geojson)$/.test(lower)) return 'document';
  if (/\.(?:arrow|feather|ipc)$/.test(lower)) return 'arrow';
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.duckdb')) return 'duckdb';
  if (lower.endsWith('.amqrun') || lower.endsWith('.amqrun.json')) return 'phase-x-run';
  if (lower.endsWith('.graph')) return 'graph';
  if (/\.(?:sqlite3?|sqlite2|db3?)$/.test(lower)) return 'sqlite';
  if (/\.(?:csv|tsv|jsonl|ndjson)$/.test(lower)) {
    return lower.endsWith('jsonl') || lower.endsWith('ndjson') ? 'json-table' : 'csv';
  }
  if (/\.(?:xlsx|xlsm)$/.test(lower)) return 'excel';
  if (lower.endsWith('.rdb')) return 'redis-rdb';
  if (lower.endsWith('.aof') || lower.endsWith('.aof.manifest')) return 'redis-aof';
  return lower.endsWith('.json') ? 'json-table' : 'graph';
}

export function sourceIdentity(source: ActiveSource, tableName?: string): string {
  const location = source.path ?? source.name;
  return `${source.kind}\u0000${location}\u0000${tableName ?? ''}`;
}

export function sourceLabel(source: ActiveSource): string {
  if (source.fileType === 'phase-x-run') return 'Phase-X-Lauf';
  if (source.kind === 'graph') return 'Graph';
  if (source.kind === 'table') return 'Tabelle';
  if (source.kind === 'vault') return 'Redis';
  return 'Start';
}
