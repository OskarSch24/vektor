import type { SqlValue } from 'sql.js';

/**
 * Quotes an identifier (table / column / index name) for safe interpolation.
 * SQLite escapes a double quote inside a quoted identifier by doubling it.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Escapes the LIKE wildcards `%` and `_` so a user's search term is matched
 * literally. Must be paired with `ESCAPE '\'` in the query.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** SQLite keywords that change the schema and require a metadata refresh. */
const DDL_PATTERN = /^\s*(CREATE|ALTER|DROP|REINDEX|VACUUM)\b/i;

export function containsDdl(sql: string): boolean {
  return sql
    .split(';')
    .some((statement) => DDL_PATTERN.test(statement));
}

export function isBlob(value: SqlValue): value is Uint8Array {
  return value instanceof Uint8Array;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${exponent === 0 ? value : parseFloat(value.toFixed(1))} ${units[exponent]}`;
}

/**
 * Lossless string form of a cell value, for display, copying and text export.
 * Numbers are never rounded or locale-grouped — this is a database viewer, the
 * value on screen has to be the value in the file.
 */
export function toDisplayString(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (isBlob(value)) return blobLabel(value);
  return String(value);
}

export function blobLabel(value: Uint8Array): string {
  return `BLOB (${formatBytes(value.byteLength)})`;
}

/** Hex dump used by the cell inspector, e.g. `89 50 4E 47 …`. */
export function blobToHex(value: Uint8Array, maxBytes = 4096): string {
  const slice = value.subarray(0, maxBytes);
  const hex: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = Array.from(slice.subarray(i, i + 16))
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    hex.push(`${i.toString(16).padStart(8, '0')}  ${row}`);
  }
  if (value.byteLength > maxBytes) {
    hex.push(`… ${formatBytes(value.byteLength - maxBytes)} weitere Bytes`);
  }
  return hex.join('\n');
}

/** Base64 form of a BLOB, so binary columns survive CSV / JSON export. */
export function blobToBase64(value: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < value.length; i += chunkSize) {
    binary += String.fromCharCode(...value.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** One CSV field, RFC 4180 quoted. */
export function toCsvField(value: SqlValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const text = isBlob(value) ? blobToBase64(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** One JSON-serialisable value; BLOBs become base64 strings. */
export function toJsonValue(value: SqlValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (isBlob(value)) return blobToBase64(value);
  return value;
}

/** One SQL literal for an INSERT dump; BLOBs use SQLite's X'…' syntax. */
export function toSqlLiteral(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (isBlob(value)) {
    const hex = Array.from(value)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `X'${hex}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}
