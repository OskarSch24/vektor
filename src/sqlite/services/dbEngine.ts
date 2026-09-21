import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
// Bundled by Vite, so the binary is versioned with the build and resolves under
// both http:// during development and the app:// scheme of the macOS host.
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import {
  DatabaseMetadata,
  ForeignKey,
  QueryResult,
  TableColumn,
  TableIndex,
  TableInfo,
} from '../types/sqlite';
import { escapeLikeTerm, quoteIdent } from '../lib/sql';
import type { ImportedTable } from './importers';
import { compileTableFilters, type TableFilterCondition } from './tableFilters';
import type { SourceDocument } from './importers/documents';

export interface TablePageOptions {
  page?: number;
  pageSize?: number;
  /**
   * Row offset, when the caller pages by offset rather than by page number —
   * which is what the HTTP API and any client iterating a table actually hold.
   * Takes precedence over `page`.
   */
  offset?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  searchTerm?: string;
  /** Metadata-whitelisted, parameter-bound conditions from the filter builder. */
  filters?: TableFilterCondition[];
}

export interface TablePage {
  columns: string[];
  values: SqlValue[][];
  totalCount: number;
  executionTimeMs: number;
  error?: string;
}

const elapsedSince = (start: number) => Math.round((performance.now() - start) * 100) / 100;

/**
 * Statements that actually write rows. `sqlite3_changes()` keeps the count of
 * the last write, so asking it after a SELECT would report a stale number.
 */
const DML_PATTERN = /^\s*(?:WITH\b[\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE|REPLACE)\b/i;

class DBEngine {
  sourceDocument: SourceDocument | null = null;
  sourceInfo: Record<string, string> = {};
  private SQL: SqlJsStatic | null = null;
  private db: Database | null = null;
  private filename = '';
  private fileSize = 0;
  private initPromise: Promise<SqlJsStatic> | null = null;

  /**
   * Loads the SQLite WebAssembly binary. It is bundled with the app (public/),
   * never fetched from a CDN — the whole point of this viewer is that neither
   * the database nor a network request for it leaves the machine.
   */
  async init(): Promise<SqlJsStatic> {
    if (this.SQL) return this.SQL;

    if (!this.initPromise) {
      this.initPromise = import('sql.js')
        .then(({ default: initSqlJs }) => initSqlJs({
          locateFile: () => sqlWasmUrl,
        }))
        .catch((err) => {
          // Allow a later retry instead of caching the rejection forever.
          this.initPromise = null;
          throw new Error(
            `SQLite WebAssembly konnte nicht geladen werden: ${err?.message || err}`
          );
        });
    }

    this.SQL = await this.initPromise;
    return this.SQL;
  }

  async loadDatabase(
    buffer: ArrayBuffer | Uint8Array,
    filename: string,
    shouldAdopt: () => boolean = () => true
  ): Promise<DatabaseMetadata | null> {
    const SQL = await this.init();
    if (!shouldAdopt()) return null;
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    let next: Database;
    try {
      next = new SQL.Database(bytes);
      // Touch the schema so a non-SQLite file fails here rather than later.
      next.exec('SELECT count(*) FROM sqlite_master;');
    } catch (err: any) {
      throw new Error(
        `"${filename}" konnte nicht als SQLite-Datenbank gelesen werden: ${err?.message || err}`
      );
    }

    if (!shouldAdopt()) {
      next.close();
      return null;
    }
    return this.adopt(next, filename, bytes.byteLength);
  }

  /**
   * Builds an in-memory database from imported tables (CSV, JSON, Excel) so the
   * rest of the app — browsing, SQL, schema, export — works on them unchanged.
   */
  async loadTables(
    tables: ImportedTable[],
    filename: string,
    sourceSize: number,
    shouldAdopt: () => boolean = () => true
  ): Promise<DatabaseMetadata | null> {
    const SQL = await this.init();
    if (!shouldAdopt()) return null;
    const next = new SQL.Database();

    try {
      for (const table of tables) {
        const definition = table.columns
          .map((column) => `${quoteIdent(column.name)} ${column.type}`)
          .join(', ');
        next.run(`CREATE TABLE ${quoteIdent(table.name)} (${definition});`);

        if (table.rows.length === 0) continue;

        const placeholders = table.columns.map(() => '?').join(', ');
        const insert = next.prepare(
          `INSERT INTO ${quoteIdent(table.name)} VALUES (${placeholders});`
        );
        // One transaction for the whole table; row-by-row commits would make
        // importing a large spreadsheet take minutes instead of milliseconds.
        next.run('BEGIN;');
        try {
          for (const row of table.rows) {
            insert.run(row);
          }
          next.run('COMMIT;');
        } catch (err) {
          next.run('ROLLBACK;');
          throw err;
        } finally {
          insert.free();
        }
      }
    } catch (err: any) {
      next.close();
      throw new Error(`"${filename}" konnte nicht importiert werden: ${err?.message || err}`);
    }

    if (!shouldAdopt()) {
      next.close();
      return null;
    }
    const metadata = this.adopt(next, filename, sourceSize);
    this.sourceInfo = Object.fromEntries(tables.filter(table => table.sourceInfo).map(table => [table.name, table.sourceInfo!]));
    return metadata;
  }

  /** Replaces the open database, closing the previous one first. */
  private adopt(next: Database, filename: string, fileSize: number): DatabaseMetadata {
    this.close();
    this.db = next;
    this.filename = filename;
    this.fileSize = fileSize;

    return this.getDatabaseMetadata();
  }

  close(): void {
    this.sourceDocument = null;
    this.sourceInfo = {};
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      console.warn('Fehler beim Schließen der vorherigen Datenbank', err);
    }
    this.db = null;
  }

  isLoaded(): boolean {
    return this.db !== null;
  }

  getFilename(): string {
    return this.filename;
  }

  getFileSize(): number {
    return this.fileSize;
  }

  /**
   * Runs a batch of SQL. Every statement is executed in order; the rows of the
   * last statement that produced any are returned, together with the total
   * number of rows written by the batch.
   */
  executeQuery(sql: string): QueryResult {
    const empty: QueryResult = {
      columns: [],
      values: [],
      executionTimeMs: 0,
      rowCount: 0,
      rowsModified: 0,
      statementCount: 0,
      sql,
    };

    if (!this.db) {
      return { ...empty, error: 'Keine Datenbank geladen.' };
    }

    const start = performance.now();
    let columns: string[] = [];
    let values: SqlValue[][] = [];
    let rowsModified = 0;
    let statementCount = 0;

    try {
      for (const statement of this.db.iterateStatements(sql)) {
        statementCount += 1;
        const statementSql = statement.getSQL();
        const statementColumns = statement.getColumnNames();
        const statementValues: SqlValue[][] = [];

        try {
          while (statement.step()) {
            statementValues.push(statement.get());
          }
        } finally {
          statement.free();
        }

        if (DML_PATTERN.test(statementSql)) {
          rowsModified += this.db.getRowsModified();
        }

        if (statementColumns.length > 0) {
          columns = statementColumns;
          values = statementValues;
        }
      }

      return {
        columns,
        values,
        executionTimeMs: elapsedSince(start),
        rowCount: values.length,
        rowsModified,
        statementCount,
        sql,
      };
    } catch (err: any) {
      return {
        ...empty,
        executionTimeMs: elapsedSince(start),
        rowsModified,
        statementCount,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * One page of a table or view. Search terms and paging bounds are bound as
   * parameters, so no user input is ever concatenated into the SQL.
   */
  getTableData(tableName: string, options: TablePageOptions = {}): TablePage {
    if (!this.db) {
      return { columns: [], values: [], totalCount: 0, executionTimeMs: 0 };
    }

    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, options.pageSize ?? 50);
    const offset = options.offset !== undefined
      ? Math.max(0, Math.floor(options.offset))
      : (page - 1) * pageSize;
    const table = quoteIdent(tableName);
    const start = performance.now();

    const columnNames = this.getColumnNames(tableName);

    let whereClause = '';
    const searchParams: SqlValue[] = [];
    const expressions: string[] = [];
    const term = options.searchTerm?.trim();
    if (term && columnNames.length > 0) {
      const pattern = `%${escapeLikeTerm(term)}%`;
      const conditions = columnNames.map((col) => {
        searchParams.push(pattern);
        return `CAST(${quoteIdent(col)} AS TEXT) LIKE ? ESCAPE '\\'`;
      });
      expressions.push(`(${conditions.join(' OR ')})`);
    }

    const compiledFilters = compileTableFilters(options.filters ?? [], columnNames);
    if (compiledFilters.expression) expressions.push(`(${compiledFilters.expression})`);
    const whereParams = [...searchParams, ...compiledFilters.params];
    if (expressions.length > 0) whereClause = `WHERE ${expressions.join(' AND ')}`;

    // Only sort by a column that actually exists — the name comes from the UI.
    let orderClause = '';
    if (options.sortBy && columnNames.includes(options.sortBy)) {
      const direction = options.sortOrder === 'DESC' ? 'DESC' : 'ASC';
      orderClause = `ORDER BY ${quoteIdent(options.sortBy)} ${direction}`;
    }

    try {
      const totalCount = this.selectScalarNumber(
        `SELECT COUNT(*) FROM ${table} ${whereClause};`,
        whereParams
      );

      const { columns, values } = this.selectRows(
        `SELECT * FROM ${table} ${whereClause} ${orderClause} LIMIT ? OFFSET ?;`,
        [...whereParams, pageSize, offset]
      );

      return {
        columns: columns.length > 0 ? columns : columnNames,
        values,
        totalCount,
        executionTimeMs: elapsedSince(start),
      };
    } catch (err: any) {
      return {
        columns: columnNames,
        values: [],
        totalCount: 0,
        executionTimeMs: elapsedSince(start),
        error: err?.message || String(err),
      };
    }
  }

  /** Every row of one table or view, used by the export dialog. */
  getAllRows(tableName: string): { columns: string[]; values: SqlValue[][] } {
    if (!this.db) return { columns: [], values: [] };
    return this.selectRows(`SELECT * FROM ${quoteIdent(tableName)};`);
  }

  getDatabaseMetadata(): DatabaseMetadata {
    if (!this.db) {
      throw new Error('Keine Datenbank geladen.');
    }

    const objects = this.selectRows(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY type ASC, name ASC;`
    );

    const tables: TableInfo[] = [];
    let totalRows = 0;

    for (const row of objects.values) {
      const name = String(row[0]);
      const type = String(row[1]) === 'view' ? 'view' : 'table';

      // Views are not counted: COUNT(*) would materialise the whole view, which
      // can take minutes on a large database just to open it.
      let rowCount: number | null = null;
      if (type === 'table') {
        rowCount = this.selectScalarNumber(`SELECT COUNT(*) FROM ${quoteIdent(name)};`);
        totalRows += rowCount;
      }

      tables.push({
        name,
        type,
        sql: row[2] ? String(row[2]) : '',
        rowCount,
        columns: this.getColumns(name),
        indexes: this.getIndexes(name),
        foreignKeys: this.getForeignKeys(name),
      });
    }

    return {
      filename: this.filename,
      fileSize: this.fileSize,
      tableCount: tables.filter((t) => t.type === 'table').length,
      viewCount: tables.filter((t) => t.type === 'view').length,
      totalRows,
      tables,
      sqliteVersion: this.selectScalarString('SELECT sqlite_version();', '3.x'),
      pageSize: this.selectScalarNumber('PRAGMA page_size;'),
      pageCount: this.selectScalarNumber('PRAGMA page_count;'),
      encoding: this.selectScalarString('PRAGMA encoding;', 'UTF-8'),
      journalMode: this.selectScalarString('PRAGMA journal_mode;', 'delete'),
    };
  }

  checkIntegrity(): { ok: boolean; message: string } {
    if (!this.db) return { ok: false, message: 'Keine Datenbank geladen.' };
    try {
      const { values } = this.selectRows('PRAGMA integrity_check;');
      const message = values.map((row) => String(row[0])).join('\n') || 'ok';
      return { ok: message.trim() === 'ok', message };
    } catch (err: any) {
      return { ok: false, message: `Fehler bei der Integritätsprüfung: ${err?.message || err}` };
    }
  }

  exportDatabase(): Uint8Array {
    if (!this.db) {
      throw new Error('Keine Datenbank geladen.');
    }
    return this.db.export();
  }

  // ---------------------------------------------------------------- internals

  private selectRows(
    sql: string,
    params: SqlValue[] = []
  ): { columns: string[]; values: SqlValue[][] } {
    if (!this.db) return { columns: [], values: [] };

    const statement = this.db.prepare(sql);
    try {
      if (params.length > 0) statement.bind(params);
      const columns = statement.getColumnNames();
      const values: SqlValue[][] = [];
      while (statement.step()) {
        values.push(statement.get());
      }
      return { columns, values };
    } finally {
      statement.free();
    }
  }

  private selectScalarNumber(sql: string, params: SqlValue[] = []): number {
    try {
      const first = this.selectRows(sql, params).values[0]?.[0];
      const parsed = Number(first);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (err) {
      console.warn(`Abfrage fehlgeschlagen: ${sql}`, err);
      return 0;
    }
  }

  private selectScalarString(sql: string, fallback: string): string {
    try {
      const first = this.selectRows(sql).values[0]?.[0];
      return first === null || first === undefined ? fallback : String(first);
    } catch (err) {
      console.warn(`Abfrage fehlgeschlagen: ${sql}`, err);
      return fallback;
    }
  }

  private getColumnNames(tableName: string): string[] {
    return this.getColumns(tableName).map((col) => col.name);
  }

  private getColumns(tableName: string): TableColumn[] {
    try {
      // PRAGMA does not accept bound parameters, hence the quoted identifier.
      const { values } = this.selectRows(`PRAGMA table_info(${quoteIdent(tableName)});`);
      return values.map((row) => ({
        cid: Number(row[0]),
        name: String(row[1]),
        type: String(row[2] ?? '').toUpperCase(),
        notnull: Number(row[3]),
        dflt_value: row[4] === null ? null : String(row[4]),
        pk: Number(row[5]),
      }));
    } catch (err) {
      console.warn(`Spalten von "${tableName}" konnten nicht gelesen werden`, err);
      return [];
    }
  }

  private getIndexes(tableName: string): TableIndex[] {
    try {
      const { values } = this.selectRows(`PRAGMA index_list(${quoteIdent(tableName)});`);
      return values.map((row) => {
        const name = String(row[1]);
        let columns: string[] = [];
        try {
          columns = this.selectRows(`PRAGMA index_info(${quoteIdent(name)});`).values.map((c) =>
            c[2] === null ? '(Ausdruck)' : String(c[2])
          );
        } catch (err) {
          console.warn(`Index "${name}" konnte nicht gelesen werden`, err);
        }
        return {
          seq: Number(row[0]),
          name,
          unique: Number(row[2]),
          origin: String(row[3] ?? ''),
          partial: Number(row[4]),
          columns,
        };
      });
    } catch (err) {
      console.warn(`Indizes von "${tableName}" konnten nicht gelesen werden`, err);
      return [];
    }
  }

  private getForeignKeys(tableName: string): ForeignKey[] {
    try {
      const { values } = this.selectRows(`PRAGMA foreign_key_list(${quoteIdent(tableName)});`);
      return values.map((row) => ({
        id: Number(row[0]),
        seq: Number(row[1]),
        table: String(row[2]),
        from: String(row[3]),
        to: row[4] === null ? '' : String(row[4]),
        on_update: String(row[5] ?? ''),
        on_delete: String(row[6] ?? ''),
        match: String(row[7] ?? ''),
      }));
    } catch (err) {
      console.warn(`Fremdschlüssel von "${tableName}" konnten nicht gelesen werden`, err);
      return [];
    }
  }
}

export const dbEngine = new DBEngine();
