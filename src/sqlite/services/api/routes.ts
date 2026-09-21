import type { SqlValue } from 'sql.js';
import { dbEngine } from '../dbEngine';
import type { TableInfo } from '../../types/sqlite';

/**
 * The table HTTP surface of Database Studio, resolved against the database
 * open in the window right now.
 *
 * Everything here runs in the renderer, on the same sql.js instance the UI
 * reads from. That is the whole reason the API exists in this shape: a second
 * process reading the file on disk would miss unsaved edits, and would see
 * nothing at all for a CSV or a spreadsheet that was imported into memory and
 * never was a SQLite file.
 */

export interface ApiCall {
  method: string;
  path: string;
  /** The external, namespaced path before the dispatcher selected an adapter. */
  publicPath?: string;
  query: Record<string, string>;
  body: unknown;
}

export interface ApiReply {
  status: number;
  payload: unknown;
}

/** Rows are capped so a `SELECT *` on a million-row table cannot wedge the app. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

const ok = (payload: unknown): ApiReply => ({ status: 200, payload });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiReply => ({
  status,
  payload: { error, ...extra },
});

/**
 * `SqlValue` includes `Uint8Array` for BLOB columns, which JSON cannot carry.
 * Blobs are described rather than dumped: a client asking for a table of
 * thumbnails wants to know they are there, not to receive megabytes of bytes it
 * did not ask for.
 */
function encodeValue(value: SqlValue): unknown {
  if (value instanceof Uint8Array) {
    return { __type: 'blob', bytes: value.byteLength };
  }
  return value;
}

const encodeRows = (rows: SqlValue[][]): unknown[][] => rows.map((row) => row.map(encodeValue));

/** Rows as objects — what most clients want, and what an LLM reads far better. */
function toObjects(columns: string[], rows: SqlValue[][]): Record<string, unknown>[] {
  return rows.map((row) => {
    const object: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      object[column] = encodeValue(row[index]);
    });
    return object;
  });
}

function readLimit(raw: string | undefined, fallback = DEFAULT_LIMIT): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function readOffset(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function describeTable(table: TableInfo) {
  return {
    name: table.name,
    type: table.type,
    rowCount: table.rowCount,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notnull === 1,
      primaryKey: column.pk > 0,
      default: column.dflt_value,
    })),
    primaryKey: table.columns.filter((c) => c.pk > 0).map((c) => c.name),
    foreignKeys: table.foreignKeys.map((key) => ({
      column: key.from,
      references: { table: key.table, column: key.to },
      onDelete: key.on_delete,
      onUpdate: key.on_update,
    })),
    indexes: table.indexes.map((index) => ({
      name: index.name,
      unique: index.unique === 1,
      columns: index.columns,
    })),
    sql: table.sql,
  };
}

/**
 * Splits a SQL batch without treating semicolons in strings or comments as a
 * boundary. Every resulting statement is classified before the first one is
 * executed, so `SELECT 1; DELETE …` cannot slip through the write gate.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      const closing = quote === ']' ? ']' : quote;
      if (character === closing) {
        if (quote !== '`' && next === closing) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '[') {
      quote = ']';
    } else if (character === ';') {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function structuralKeywords(sql: string): Array<{ word: string; depth: number }> {
  const words: Array<{ word: string; depth: number }> = [];
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      index += 1;
    } else if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 2;
      } else index += 1;
    } else if (quote) {
      const closing = quote === ']' ? ']' : quote;
      if (character === closing) {
        if (quote !== '`' && next === closing) index += 2;
        else {
          quote = null;
          index += 1;
        }
      } else index += 1;
    } else if (character === '-' && next === '-') {
      lineComment = true;
      index += 2;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 2;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
      index += 1;
    } else if (character === '[') {
      quote = ']';
      index += 1;
    } else if (character === '(') {
      depth += 1;
      index += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
    } else if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      words.push({ word: sql.slice(index, end).toUpperCase(), depth });
      index = end;
    } else index += 1;
  }
  return words;
}

function statementWrites(sql: string): boolean {
  const words = structuralKeywords(sql);
  const first = words.find((token) => token.depth === 0)?.word;
  if (!first) return false;
  if (first === 'SELECT' || first === 'VALUES' || first === 'EXPLAIN') return false;
  if (first === 'PRAGMA') return /[=(]/.test(sql);
  if (first === 'WITH') {
    const main = words.find(
      (token, index) => index > 0 && token.depth === 0 &&
        ['SELECT', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(token.word)
    )?.word;
    return main !== 'SELECT' && main !== 'VALUES';
  }
  // Unknown top-level commands are denied conservatively. SQLite grows new
  // maintenance statements over time; read-only mode must fail closed.
  return true;
}

export interface RouterContext {
  /** Whether the window currently allows writes over the API. */
  allowWrites: boolean;
  /** Opens a file from disk into the live session; rejects when unavailable. */
  openPath?: (path: string) => Promise<{ filename: string; tableCount: number }>;
  /** Re-reads the mounted workspace after a successful SQL write. */
  onDatabaseChanged?: () => void;
}

export async function route(call: ApiCall, context: RouterContext): Promise<ApiReply> {
  // Kennungen kommen prozentkodiert an (studio-mcp nutzt encodeURIComponent):
  // „organization%3Afacebook“ muss als „organization:facebook“ gesucht werden.
  const segments = call.path.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean).map(decodeSegment);
  const [head, ...rest] = segments;

  switch (`${call.method} /${head ?? ''}`) {
    case 'GET /':
    case 'GET /health':
      return ok(health());

    case 'GET /schema':
      return schema();

    case 'GET /tables':
      return rest.length === 0 ? tables() : tableResource(rest, call);

    case 'POST /sql':
      return runSql(call, context);

    case 'POST /open':
      return openFile(call, context);

    case 'GET /integrity':
      return dbEngine.isLoaded()
        ? ok(dbEngine.checkIntegrity())
        : fail(409, 'Keine Datenbank geladen.');

    default:
      return fail(404, `Unbekannte Route: ${call.method} ${call.publicPath ?? call.path}`, {
        routes: [
          'GET  /api/v1/sqlite/health',
          'GET  /api/v1/sqlite/schema',
          'GET  /api/v1/sqlite/tables',
          'GET  /api/v1/sqlite/tables/:name?limit=&offset=&search=&orderBy=&order=',
          'GET  /api/v1/sqlite/tables/:name/schema',
          'POST /api/v1/sqlite/sql          { sql, limit?, format? }',
          'POST /api/v1/sqlite/open         { path }',
          'GET  /api/v1/sqlite/integrity',
        ],
      });
  }
}

// MARK: - Handlers

export function health() {
  if (!dbEngine.isLoaded()) {
    return { loaded: false, database: null };
  }
  const metadata = dbEngine.getDatabaseMetadata();
  return {
    loaded: true,
    database: {
      filename: metadata.filename,
      fileSize: metadata.fileSize,
      tableCount: metadata.tableCount,
      viewCount: metadata.viewCount,
      totalRows: metadata.totalRows,
      sqliteVersion: metadata.sqliteVersion,
      encoding: metadata.encoding,
    },
  };
}

function schema(): ApiReply {
  if (!dbEngine.isLoaded()) return fail(409, 'Keine Datenbank geladen.');
  const metadata = dbEngine.getDatabaseMetadata();
  return ok({
    filename: metadata.filename,
    sqliteVersion: metadata.sqliteVersion,
    tables: metadata.tables.map(describeTable),
  });
}

function tables(): ApiReply {
  if (!dbEngine.isLoaded()) return fail(409, 'Keine Datenbank geladen.');
  const metadata = dbEngine.getDatabaseMetadata();
  return ok({
    tables: metadata.tables.map((table) => ({
      name: table.name,
      type: table.type,
      rowCount: table.rowCount,
      columns: table.columns.map((column) => column.name),
    })),
  });
}

/** `/tables/:name` and `/tables/:name/schema`. */
function tableResource(rest: string[], call: ApiCall): ApiReply {
  if (!dbEngine.isLoaded()) return fail(409, 'Keine Datenbank geladen.');

  const [name, sub] = rest;
  const metadata = dbEngine.getDatabaseMetadata();
  const table = metadata.tables.find((entry) => entry.name === name);
  if (!table) {
    return fail(404, `Unbekannte Tabelle: "${name}"`, {
      available: metadata.tables.map((entry) => entry.name),
    });
  }

  if (sub === 'schema') return ok(describeTable(table));
  if (sub) return fail(404, `Unbekannter Unterpfad: "${sub}"`);

  const limit = readLimit(call.query.limit);
  const offset = readOffset(call.query.offset);
  const orderBy = call.query.orderBy;

  const result = dbEngine.getTableData(name, {
    offset,
    pageSize: limit,
    sortBy: orderBy,
    sortOrder: call.query.order?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
    searchTerm: call.query.search,
  });

  if (result.error) return fail(400, result.error);

  return ok({
    table: name,
    columns: result.columns,
    rows: toObjects(result.columns, result.values),
    limit,
    offset,
    totalCount: result.totalCount,
    hasMore: offset + result.values.length < result.totalCount,
    durationMs: result.executionTimeMs,
  });
}

function runSql(call: ApiCall, context: RouterContext): ApiReply {
  if (!dbEngine.isLoaded()) return fail(409, 'Keine Datenbank geladen.');

  const body = (call.body ?? {}) as { sql?: string; limit?: number; format?: string };
  const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
  if (!sql) return fail(400, 'Feld "sql" fehlt oder ist leer.');

  const isWrite = splitStatements(sql).some(statementWrites);
  if (isWrite && !context.allowWrites) {
    return fail(403, 'Schreibende Anweisungen sind über die API abgeschaltet.', {
      hint: 'Im API-Tab der App "Schreibzugriff erlauben" aktivieren.',
    });
  }

  const result = dbEngine.executeQuery(sql);
  if (result.error) {
    return fail(400, result.error, { sql: result.sql });
  }
  if (isWrite) context.onDatabaseChanged?.();

  const limit = readLimit(body.limit === undefined ? undefined : String(body.limit));
  const truncated = result.values.length > limit;
  const values = truncated ? result.values.slice(0, limit) : result.values;

  return ok({
    columns: result.columns,
    // Arrays are cheaper for a large result; objects read better for a small
    // one. The caller decides, and rows-as-objects is the friendlier default.
    rows: body.format === 'array' ? encodeRows(values) : toObjects(result.columns, values),
    format: body.format === 'array' ? 'array' : 'object',
    rowCount: values.length,
    totalRowCount: result.values.length,
    truncated,
    rowsModified: result.rowsModified,
    statementCount: result.statementCount,
    durationMs: result.executionTimeMs,
    isWrite,
  });
}

async function openFile(call: ApiCall, context: RouterContext): Promise<ApiReply> {
  const body = (call.body ?? {}) as { path?: string };
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return fail(400, 'Feld "path" fehlt.');
  if (!context.openPath) {
    return fail(503, 'Dateien öffnen geht nur in der App, nicht im Browser.');
  }

  try {
    const opened = await context.openPath(path);
    return ok({ opened: true, ...opened });
  } catch (err: any) {
    return fail(400, err?.message || String(err));
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
