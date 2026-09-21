import type { SqlValue } from 'sql.js';

/** A column type as declared in the generated `CREATE TABLE`. */
export type ColumnType = 'INTEGER' | 'REAL' | 'TEXT';

export interface ImportedColumn {
  name: string;
  type: ColumnType;
}

/** One table produced by an importer, ready to be written into SQLite. */
export interface ImportedTable {
  sourceInfo?: string;
  name: string;
  columns: ImportedColumn[];
  rows: SqlValue[][];
}

/** Cell values as an importer sees them before type inference. */
export type RawCell = string | number | boolean | Date | null | undefined;

const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_POINT_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DECIMAL_COMMA_PATTERN = /^[+-]?\d{1,3}(\.\d{3})*,\d+$|^[+-]?\d+,\d+$/;

/** Values that stand for "no value" in exported spreadsheets and CSV files. */
const NULL_TOKENS = new Set(['', 'null', 'NULL', 'NaN', 'N/A', 'n/a', '-', '—']);

export function isBlank(value: RawCell): boolean {
  return value === null || value === undefined || (typeof value === 'string' && NULL_TOKENS.has(value.trim()));
}

/**
 * Parses a German-formatted decimal such as `1.234,56`. Only used when a whole
 * column looks like that, so an ordinary text column is never mangled.
 */
function parseDecimalComma(text: string): number {
  return Number(text.replace(/\./g, '').replace(',', '.'));
}

/**
 * Picks the narrowest type that holds every value in the column. A column is
 * only numeric if *all* of its non-empty values are — one stray label is enough
 * to keep the whole column as text, which is what a viewer should do.
 */
export function inferColumnType(values: RawCell[]): { type: ColumnType; decimalComma: boolean } {
  let sawValue = false;
  let allInteger = true;
  let allDecimalPoint = true;
  let allDecimalComma = true;

  for (const value of values) {
    if (isBlank(value)) continue;
    if (typeof value === 'number') {
      sawValue = true;
      allDecimalComma = false;
      if (!Number.isInteger(value)) allInteger = false;
      continue;
    }
    if (typeof value === 'boolean' || value instanceof Date) {
      return { type: 'TEXT', decimalComma: false };
    }

    sawValue = true;
    const text = String(value).trim();
    if (!INTEGER_PATTERN.test(text)) allInteger = false;
    if (!DECIMAL_POINT_PATTERN.test(text)) allDecimalPoint = false;
    if (!DECIMAL_COMMA_PATTERN.test(text)) allDecimalComma = false;
    if (!allInteger && !allDecimalPoint && !allDecimalComma) {
      return { type: 'TEXT', decimalComma: false };
    }
  }

  if (!sawValue) return { type: 'TEXT', decimalComma: false };
  // Integers beyond 2^53 lose precision as JavaScript numbers, so they stay text.
  if (allInteger) {
    const overflows = values.some(
      (value) => !isBlank(value) && !Number.isSafeInteger(Number(String(value).trim()))
    );
    return overflows ? { type: 'TEXT', decimalComma: false } : { type: 'INTEGER', decimalComma: false };
  }
  if (allDecimalPoint) return { type: 'REAL', decimalComma: false };
  if (allDecimalComma) return { type: 'REAL', decimalComma: true };
  return { type: 'TEXT', decimalComma: false };
}

function coerce(value: RawCell, type: ColumnType, decimalComma: boolean): SqlValue {
  if (isBlank(value)) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (type === 'TEXT') return typeof value === 'number' ? String(value) : String(value);
  if (typeof value === 'number') return value;

  const text = String(value).trim();
  const parsed = decimalComma ? parseDecimalComma(text) : Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}

/** Makes column names unique, non-empty and safe to display. */
export function normaliseColumnNames(names: RawCell[]): string[] {
  const used = new Map<string, number>();
  return names.map((raw, index) => {
    const base = isBlank(raw) ? `spalte_${index + 1}` : String(raw).trim().replace(/\s+/g, ' ');
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}_${seen + 1}`;
  });
}

/**
 * Turns a header row plus data rows into a typed table. Rows shorter than the
 * header are padded, longer rows are truncated — real-world CSV files are ragged.
 */
export function buildTable(name: string, header: RawCell[], rows: RawCell[][]): ImportedTable {
  const columnNames = normaliseColumnNames(header);
  const inferred = columnNames.map((_, index) =>
    inferColumnType(rows.map((row) => row[index]))
  );

  return {
    name,
    columns: columnNames.map((columnName, index) => ({
      name: columnName,
      type: inferred[index].type,
    })),
    rows: rows.map((row) =>
      columnNames.map((_, index) =>
        coerce(row[index], inferred[index].type, inferred[index].decimalComma)
      )
    ),
  };
}

/** Derives a usable SQL table name from a file or sheet name. */
export function tableNameFrom(source: string): string {
  const withoutExtension = source.replace(/\.[^./\\]+$/, '');
  const cleaned = withoutExtension
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1');
  return cleaned || 'daten';
}
