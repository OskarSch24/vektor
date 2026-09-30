/**
 * Turns an SQL dump into statements SQLite can run.
 *
 * `sqlite3 .dump` output runs unchanged. MySQL/MariaDB (`mysqldump`) and
 * PostgreSQL (`pg_dump`) dumps are adapted where the dialects differ in ways
 * that only concern the server — table options, locks, session settings,
 * `COPY … FROM stdin` blocks. Whatever still fails is skipped and reported,
 * never silently dropped.
 */

import type { Database } from 'sql.js';

export interface DumpResult {
  executed: number;
  /** Server housekeeping (SET, LOCK TABLES, OWNER TO …) left out on purpose. */
  skipped: number;
  failures: string[];
}

/**
 * Runs a dump into `db`. Each statement gets its own savepoint, so one dialect
 * quirk costs one statement, not the whole import.
 */
export function runDump(db: Database, text: string): DumpResult {
  const mysql = isMysqlDump(text);
  const result: DumpResult = { executed: 0, skipped: 0, failures: [] };
  db.run('BEGIN;');
  for (const statement of splitDump(text, mysql)) {
    const adapted = adaptStatement(statement.sql, mysql);
    if (!adapted) {
      result.skipped += 1;
      continue;
    }
    for (const sql of adapted) {
      try {
        db.run('SAVEPOINT dump_statement;');
        db.run(sql);
        db.run('RELEASE dump_statement;');
        result.executed += 1;
      } catch (err: any) {
        db.run('ROLLBACK TO dump_statement;');
        db.run('RELEASE dump_statement;');
        result.failures.push(`Zeile ${statement.line}: ${err?.message || err}`);
      }
    }
  }
  db.run('COMMIT;');
  return result;
}

export interface DumpStatement {
  sql: string;
  /** 1-based line where the statement starts, for error messages. */
  line: number;
}

/** Server-side housekeeping with no meaning for a local copy. */
const SKIPPED = /^(?:SET|LOCK\s+TABLES|UNLOCK\s+TABLES|USE|DELIMITER|SELECT\s+pg_catalog\.set_config|ALTER\s+TABLE\s+\S+\s+OWNER\s+TO|COMMENT\s+ON|GRANT|REVOKE|CREATE\s+(?:SCHEMA|EXTENSION|SEQUENCE|FUNCTION|TRIGGER|PROCEDURE|TYPE|DOMAIN)|ALTER\s+SEQUENCE|SELECT\s+setval|\\connect)\b/i;

/** mysqldump escapes quotes with a backslash; standard SQL doubles them. */
export function isMysqlDump(text: string): boolean {
  const head = text.slice(0, 20_000);
  return /mysqldump|MariaDB dump|\/\*!\d{5}|ENGINE\s*=|`\w+`/.test(head);
}

export function splitDump(text: string, backslashEscapes = isMysqlDump(text)): DumpStatement[] {
  const statements: DumpStatement[] = [];
  let startIndex = -1;
  let startLine = 1;
  let line = 1;
  let quote: string | null = null;
  let i = 0;
  const parts: string[] = [];
  let segment = 0;

  const flush = (end: number) => {
    if (startIndex >= 0) parts.push(text.slice(segment, end));
    const sql = parts.join('').trim();
    parts.length = 0;
    if (sql) statements.push({ sql, line: startLine });
    startIndex = -1;
  };
  const begin = (index: number) => {
    if (startIndex < 0) {
      startIndex = index;
      segment = index;
      startLine = line;
    }
  };

  while (i < text.length) {
    const char = text[i];

    if (quote) {
      if (char === '\n') line += 1;
      if (backslashEscapes && char === '\\' && quote !== '`') {
        i += 2;
        continue;
      }
      if (char === quote) {
        if (text[i + 1] === quote) i += 1;
        else quote = null;
      }
      i += 1;
      continue;
    }

    if (char === '\n') {
      line += 1;
      i += 1;
      continue;
    }

    // PostgreSQL COPY … FROM stdin; data follows until a line with `\.`.
    if (startIndex < 0 && (char === 'C' || char === 'c') && /^COPY\s/i.test(text.slice(i, i + 5))) {
      const headerEnd = text.indexOf('\n', i);
      if (headerEnd > 0 && /FROM\s+stdin;\s*$/i.test(text.slice(i, headerEnd))) {
        const terminator = text.indexOf('\n\\.', headerEnd);
        const end = terminator < 0 ? text.length : terminator + 3;
        const block = text.slice(i, end);
        statements.push({ sql: block, line });
        line += countLines(block);
        i = end;
        continue;
      }
    }

    // Comments: `-- …`, `# …` (MySQL), `/* … */` incl. MySQL `/*!40101 … */`.
    const next = text[i + 1];
    const lineComment = (char === '-' && next === '-') || (char === '#' && startIndex < 0);
    if (lineComment || (char === '/' && next === '*')) {
      if (startIndex >= 0) parts.push(text.slice(segment, i));
      const end = lineComment ? skipTo(text, i, '\n') : Math.min(text.length, skipTo(text, i + 2, '*/') + 2);
      line += countLines(text.slice(i, end));
      i = end;
      segment = i;
      if (startIndex >= 0) parts.push(' ');
      continue;
    }

    if (char === ';') {
      flush(i);
      i += 1;
      continue;
    }
    if (!/\s/.test(char)) begin(i);
    if (char === "'" || char === '"' || char === '`') quote = char;
    i += 1;
  }
  flush(text.length);
  return statements;
}

/** Returns the statement in SQLite's dialect, or null when it is to be skipped. */
export function adaptStatement(sql: string, backslashEscapes = false): string[] | null {
  if (SKIPPED.test(sql)) return null;
  if (/^COPY\s/i.test(sql)) return copyToInserts(sql);
  if (/^(?:BEGIN|START\s+TRANSACTION|COMMIT)\b/i.test(sql)) return null;

  let adapted = sql;
  if (/^CREATE\s+TABLE/i.test(adapted)) {
    adapted = adapted
      // MySQL table options after the closing parenthesis.
      .replace(/\)\s*(?:ENGINE|AUTO_INCREMENT|DEFAULT\s+CHARSET|CHARSET|COLLATE|ROW_FORMAT|COMMENT)[\s\S]*$/i, ')')
      .replace(/\bAUTO_INCREMENT\b/gi, '')
      .replace(/\bunsigned\b/gi, '')
      .replace(/\b(?:CHARACTER\s+SET|COLLATE)\s+[\w"'`]+/gi, '')
      .replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\))?/gi, '')
      .replace(/\bCOMMENT\s+'(?:[^'\\]|\\.|'')*'/gi, '')
      // MySQL index clauses inside CREATE TABLE have no SQLite equivalent.
      .replace(/,\s*(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+[`"\w]+\s*\([^)]*\)(?:\s+USING\s+\w+)?/gi, '')
      // PostgreSQL: serial types, schema prefixes, casts in defaults.
      .replace(/\b(?:big|small)?serial\b/gi, 'INTEGER')
      .replace(/::[\w ]+(?:\[\])?/g, '');
  }
  if (backslashEscapes && /^INSERT/i.test(adapted)) {
    adapted = mysqlStringsToSqlite(adapted);
  }
  adapted = adapted.replace(/^(CREATE\s+TABLE\s+|INSERT\s+INTO\s+)(?:public|"public")\./i, '$1');
  return [adapted];
}

const MYSQL_ESCAPES: Record<string, string> = {
  '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '\\': '\\', "'": "'", '"': '"',
};

/** Rewrites MySQL's backslash-escaped string literals as SQLite literals. */
export function mysqlStringsToSqlite(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === '`') {
      const end = sql.indexOf('`', i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (char !== "'" && char !== '"') {
      out += char;
      i += 1;
      continue;
    }
    // MySQL also accepts double-quoted strings; SQLite reads those as names.
    const quote = char;
    let value = '';
    i += 1;
    while (i < sql.length) {
      const c = sql[i];
      if (c === '\\' && i + 1 < sql.length) {
        const escaped = sql[i + 1];
        value += MYSQL_ESCAPES[escaped] ?? escaped;
        i += 2;
        continue;
      }
      if (c === quote) {
        if (sql[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      value += c;
      i += 1;
    }
    out += `'${value.replace(/'/g, "''")}'`;
  }
  return out;
}

function copyToInserts(block: string): string[] {
  const [header, ...rows] = block.split('\n');
  const match = /^COPY\s+((?:"[^"]+"|[\w.]+))\s*(\([^)]*\))?\s+FROM\s+stdin;/i.exec(header);
  if (!match) return [];
  const table = match[1].replace(/^(?:public|"public")\./i, '');
  const columns = match[2] ?? '';
  const inserts: string[] = [];
  for (const row of rows) {
    if (row === '\\.' || row === '') continue;
    const values = row.split('\t').map((value) => (
      value === '\\N' ? 'NULL' : `'${unescapeCopy(value).replace(/'/g, "''")}'`
    ));
    inserts.push(`INSERT INTO ${table} ${columns} VALUES (${values.join(', ')})`);
  }
  return inserts;
}

function unescapeCopy(value: string): string {
  return value.replace(/\\([tnr\\])/g, (_, char) => ({ t: '\t', n: '\n', r: '\r', '\\': '\\' }[char as 't' | 'n' | 'r' | '\\']));
}

function skipTo(text: string, from: number, marker: string): number {
  const end = text.indexOf(marker, from);
  return end < 0 ? text.length : end;
}

function countLines(text: string): number {
  let lines = 0;
  for (const char of text) if (char === '\n') lines += 1;
  return lines;
}
