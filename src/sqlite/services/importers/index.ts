import { ImportedTable } from './tables';
import { importCsv } from './csv';
import { importJson } from './json';
import { importXlsx } from './xlsx';
import { documentTables, parseSourceDocument } from './documents';

/** File formats the app can open. `sqlite` is read natively, the rest are imported. */
export type FileFormat = 'sqlite' | 'csv' | 'json' | 'xlsx' | 'document' | 'parquet' | 'arrow' | 'duckdb' | 'connection';

interface FormatSpec {
  format: FileFormat;
  label: string;
  extensions: string[];
}

export const FORMATS: FormatSpec[] = [
  { format: 'sqlite', label: 'SQLite', extensions: ['sqlite', 'sqlite3', 'sqlite2', 'db', 'db3'] },
  { format: 'csv', label: 'CSV', extensions: ['csv', 'tsv'] },
  { format: 'json', label: 'JSON', extensions: ['json', 'jsonl', 'ndjson'] },
  { format: 'xlsx', label: 'Excel', extensions: ['xlsx', 'xlsm'] },
  { format: 'document', label: 'Dokument', extensions: ['yaml', 'yml', 'toml', 'xml', 'geojson'] },
  { format: 'parquet', label: 'Parquet', extensions: ['parquet'] },
  { format: 'arrow', label: 'Arrow', extensions: ['arrow', 'feather', 'ipc'] },
  { format: 'duckdb', label: 'DuckDB', extensions: ['duckdb'] },
  { format: 'connection', label: 'Datenbankverbindung', extensions: ['dbconnection'] },
];

/** Every extension the app offers in file dialogs and looks for in projects. */
export const SUPPORTED_EXTENSIONS = FORMATS.flatMap((spec) => spec.extensions);

export const FILE_INPUT_ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export function extensionOf(filename: string): string {
  const match = /\.([^.\\/]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : '';
}

export function detectFormat(filename: string): FileFormat | null {
  if (filename.toLowerCase().endsWith('.dbconnection.json')) return 'connection';
  const extension = extensionOf(filename);
  return FORMATS.find((spec) => spec.extensions.includes(extension))?.format ?? null;
}

export function formatLabel(filename: string): string | null {
  const extension = extensionOf(filename);
  return FORMATS.find((spec) => spec.extensions.includes(extension))?.label ?? null;
}

/**
 * Converts a non-SQLite file into tables. SQLite files never reach this — they
 * are handed straight to the engine.
 */
export async function importTables(
  bytes: Uint8Array,
  filename: string,
  format: Exclude<FileFormat, 'sqlite'>
): Promise<ImportedTable[]> {
  switch (format) {
    case 'csv':
      return importCsv(bytes, filename);
    case 'json':
      return importJson(bytes, filename);
    case 'xlsx':
      return importXlsx(bytes, filename);
    case 'document':
      return documentTables(parseSourceDocument(bytes, filename)!, filename);
    case 'parquet':
    case 'arrow':
      return (await import('./columnar')).importColumnar(bytes, filename, format);
    case 'duckdb':
    case 'connection':
      return (await import('./remote')).importRemote(bytes, filename, format);
  }
}

export type { ImportedTable } from './tables';
