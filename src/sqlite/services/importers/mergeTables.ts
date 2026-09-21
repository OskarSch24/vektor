import type { SqlValue } from 'sql.js';
import { tableNameFrom, type ColumnType, type ImportedColumn, type ImportedTable } from './tables.ts';

export interface MergeTableSource {
  /** The original file, used only for reporting in the assistant. */
  filename: string;
  table: ImportedTable;
}

export interface MergeTablesOptions {
  /** Display name entered by the user. It is normalised into a SQLite-safe table name. */
  targetName: string;
  /** Empty or omitted means that every row is retained. */
  deduplicateBy?: readonly string[];
}

export interface MergeTablesResult {
  tables: ImportedTable[];
  inputRows: number;
  outputRows: number;
  duplicatesRemoved: number;
  sourceFiles: number;
  sourceTables: number;
}

interface UnionColumn extends ImportedColumn {
  key: string;
}

function columnKey(name: string): string {
  // SQLite identifiers are case-insensitive. Treating `ID` and `id` as one
  // column prevents an otherwise invalid CREATE TABLE statement downstream.
  return name.trim().toLowerCase();
}

function mergeTypes(left: ColumnType, right: ColumnType): ColumnType {
  if (left === right) return left;
  if (left === 'TEXT' || right === 'TEXT') return 'TEXT';
  return 'REAL';
}

/**
 * Builds the stable first-seen column union shared by preview and final merge.
 * INTEGER + REAL becomes REAL; any TEXT occurrence promotes the whole column
 * to TEXT so no source value is lost.
 */
export function unionColumns(sources: readonly MergeTableSource[]): ImportedColumn[] {
  const columns: UnionColumn[] = [];
  const byKey = new Map<string, number>();

  for (const { table } of sources) {
    for (const column of table.columns) {
      const key = columnKey(column.name);
      const existingIndex = byKey.get(key);
      if (existingIndex === undefined) {
        byKey.set(key, columns.length);
        columns.push({ ...column, key });
      } else {
        const existing = columns[existingIndex];
        existing.type = mergeTypes(existing.type, column.type);
      }
    }
  }

  return columns.map(({ key: _key, ...column }) => column);
}

function coerceForUnion(value: SqlValue | undefined, type: ColumnType): SqlValue {
  if (value === undefined || value === null) return null;
  if (type === 'TEXT' && typeof value === 'number') return String(value);
  return value;
}

function valueKey(value: SqlValue): string {
  if (value === null) return 'null;';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:nan;';
    if (Object.is(value, -0)) return 'number:-0;';
    return `number:${value};`;
  }
  if (typeof value === 'string') return `string:${value.length}:${value};`;
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return `bytes:${value.byteLength}:${hex};`;
}

/**
 * Merges imported tables into one in-memory table. Rows are projected onto the
 * column union, and optional duplicate removal keeps the first occurrence.
 */
export function mergeImportedTables(
  sources: readonly MergeTableSource[],
  options: MergeTablesOptions
): MergeTablesResult {
  if (sources.length === 0) {
    throw new Error('Zum Zusammenführen wurde keine Tabelle ausgewählt.');
  }

  const columns = unionColumns(sources);
  if (columns.length === 0) {
    throw new Error('Die ausgewählten Dateien enthalten keine Spalten.');
  }

  const unionIndex = new Map(columns.map((column, index) => [columnKey(column.name), index]));
  const requestedDedupe = options.deduplicateBy ?? [];
  const dedupeIndices = requestedDedupe.map((name) => {
    const index = unionIndex.get(columnKey(name));
    if (index === undefined) {
      throw new Error(`Die Dublettenspalte „${name}“ ist nicht im gemeinsamen Schema enthalten.`);
    }
    return index;
  });

  const rows: SqlValue[][] = [];
  const seen = dedupeIndices.length > 0 ? new Set<string>() : null;
  let inputRows = 0;
  let duplicatesRemoved = 0;

  for (const { table } of sources) {
    const sourceIndices = new Map<string, number>();
    table.columns.forEach((column, index) => {
      const key = columnKey(column.name);
      if (!sourceIndices.has(key)) sourceIndices.set(key, index);
    });
    // Build this projection once per table rather than looking up every column
    // again for every row. It matters for six-figure CSV imports.
    const projection = columns.map((column) => sourceIndices.get(columnKey(column.name)));

    for (const sourceRow of table.rows) {
      inputRows += 1;
      const row = columns.map((column, index) => {
        const sourceIndex = projection[index];
        return coerceForUnion(
          sourceIndex === undefined ? undefined : sourceRow[sourceIndex],
          column.type
        );
      });

      if (seen) {
        const key = dedupeIndices.map((index) => valueKey(row[index])).join('');
        if (seen.has(key)) {
          duplicatesRemoved += 1;
          continue;
        }
        seen.add(key);
      }
      rows.push(row);
    }
  }

  const sourceFiles = new Set(sources.map((source) => source.filename)).size;
  return {
    tables: [{ name: tableNameFrom(options.targetName), columns, rows }],
    inputRows,
    outputRows: rows.length,
    duplicatesRemoved,
    sourceFiles,
    sourceTables: sources.length,
  };
}
