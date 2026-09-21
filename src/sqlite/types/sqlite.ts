import type { SqlValue } from 'sql.js';

export interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface TableIndex {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: string[];
}

export interface ForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
  sql: string;
  /** `null` for views — counting one would materialise the whole view. */
  rowCount: number | null;
  columns: TableColumn[];
  indexes: TableIndex[];
  foreignKeys: ForeignKey[];
}

export interface DatabaseMetadata {
  filename: string;
  fileSize: number;
  tableCount: number;
  viewCount: number;
  totalRows: number;
  tables: TableInfo[];
  sqliteVersion: string;
  pageSize: number;
  pageCount: number;
  encoding: string;
  journalMode: string;
}

export interface QueryResult {
  columns: string[];
  values: SqlValue[][];
  executionTimeMs: number;
  /** Rows returned by the last statement that produced a result set. */
  rowCount: number;
  /** Rows inserted, updated or deleted by the whole batch. */
  rowsModified: number;
  statementCount: number;
  error?: string;
  sql: string;
}

export interface QueryHistoryItem {
  id: string;
  sql: string;
  timestamp: number;
  executionTimeMs: number;
  rowCount: number;
  success: boolean;
}

export type ActiveTab = 'data' | 'query' | 'schema' | 'stats' | 'api';
