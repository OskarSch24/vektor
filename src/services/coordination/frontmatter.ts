import { CoordinationRecord, Frontmatter, FrontmatterValue, RecordType } from '../../types/coordination';

/**
 * Reader for the record frontmatter the tracker writes.
 *
 * This is a deliberate port of `parse_value` / `read_record` in
 * `project_tracker.py`, not a general YAML parser. The tracker emits a tiny,
 * fully specified subset — JSON-encoded scalars and flow lists, plus block
 * lists — and it reads back exactly that subset. Matching it line for line
 * means a file the tracker accepts is a file we accept, and a file we reject
 * is one the tracker would reject too. A real YAML library would be larger,
 * would accept documents the tracker cannot read, and would still not tell us
 * anything the tracker does not already guarantee.
 */

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const KEY = /^[A-Za-z0-9_]+$/;
const INTEGER = /^-?\d+$/;

export class RecordParseError extends Error {}

/**
 * One frontmatter scalar. The order of the checks mirrors the tracker's:
 * single-quoted first, then anything JSON can hold, then a bare integer, then
 * the raw text.
 */
export function parseValue(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === '') return '';

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  if (value === 'true' || value === 'false' || value === 'null' || /^["[{]/.test(value)) {
    try {
      return JSON.parse(value) as FrontmatterValue;
    } catch {
      // Falls through to the plain-text reading, exactly as the tracker does:
      // a value that merely looks like JSON is still a string.
    }
  }

  if (INTEGER.test(value)) return Number(value);
  return value;
}

/** Splits a record into its frontmatter and its Markdown body. */
export function parseRecord(contents: string, filename: string): CoordinationRecord {
  const match = FRONTMATTER.exec(contents);
  if (!match) throw new RecordParseError(`${filename}: kein gültiger Frontmatter-Block`);

  const data: Frontmatter = {};
  let currentKey: string | null = null;

  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // A block list continues the key above it. The tracker writes flow lists,
    // but reads both — a record a person edited by hand may well use blocks.
    if (trimmed.startsWith('- ') && currentKey) {
      const existing = data[currentKey];
      if (existing === '') data[currentKey] = [];
      const list = data[currentKey];
      if (!Array.isArray(list)) {
        throw new RecordParseError(`${filename}:${index + 2}: Liste unter einem Wert, der keine ist`);
      }
      list.push(parseValue(trimmed.slice(2)));
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new RecordParseError(`${filename}:${index + 2}: Zeile ohne Doppelpunkt`);
    }
    const key = line.slice(0, separator).trim();
    if (!KEY.test(key)) {
      throw new RecordParseError(`${filename}:${index + 2}: unzulässiger Schlüssel "${key}"`);
    }
    currentKey = key;
    data[key] = parseValue(line.slice(separator + 1));
  }

  const type = data.record_type;
  if (typeof type !== 'string' || !isRecordType(type)) {
    throw new RecordParseError(`${filename}: unbekannter record_type "${String(type)}"`);
  }

  return { type, filename, data };
}

function isRecordType(value: string): value is RecordType {
  return value === 'work' || value === 'event' || value === 'handoff' || value === 'decision' || value === 'actor';
}

// MARK: - Typed access
//
// Frontmatter is data from disk, so every read states what it expects and what
// it falls back to. A record missing a field yields an empty node property
// rather than `undefined` leaking into the graph and onto the canvas.

export function str(data: Frontmatter, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

export function num(data: Frontmatter, key: string): number {
  const value = data[key];
  if (typeof value === 'number') return value;
  // The tracker writes integers unquoted, but a hand-edited record may quote
  // them; a numeric string is still a number to everyone reading the file.
  if (typeof value === 'string' && INTEGER.test(value.trim())) return Number(value);
  return 0;
}

export function bool(data: Frontmatter, key: string): boolean {
  const value = data[key];
  if (typeof value === 'boolean') return value;
  return value === 'true';
}

export function list(data: Frontmatter, key: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}
