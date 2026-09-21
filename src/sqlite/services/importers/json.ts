import { buildTable, ImportedTable, RawCell, tableNameFrom } from './tables';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nested objects and arrays are kept as JSON text — the cell inspector formats them. */
function flattenCell(value: JsonValue): RawCell {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/** Column order follows first appearance across all records, not just the first one. */
function collectColumns(records: Array<{ [key: string]: JsonValue }>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function tableFromArray(name: string, items: JsonValue[]): ImportedTable {
  const records = items.filter(isRecord);

  // An array of plain values becomes a single-column table.
  if (records.length === 0) {
    return buildTable(name, ['wert'], items.map((item) => [flattenCell(item)]));
  }

  const columns = collectColumns(records);
  if (!columns.length) return buildTable(name, ['wert'], items.map(item => [JSON.stringify(item)]));
  return buildTable(
    name,
    columns,
    items.map((item) =>
      isRecord(item)
        ? columns.map((column) => flattenCell(item[column] ?? null))
        : [flattenCell(item), ...columns.slice(1).map(() => null)]
    )
  );
}

function parseNdjson(text: string): JsonValue[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonValue;
      } catch (err: any) {
        throw new Error(`Zeile ${index + 1} ist kein gültiges JSON: ${err?.message || err}`);
      }
    });
}

export function importJson(bytes: Uint8Array, filename: string): ImportedTable[] {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '').trim();
  if (text === '') {
    throw new Error(`"${filename}" ist leer.`);
  }

  const isLineDelimited = /\.(jsonl|ndjson)$/i.test(filename);
  const baseName = tableNameFrom(filename);

  if (isLineDelimited) {
    return [tableFromArray(baseName, parseNdjson(text))];
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch (err: any) {
    throw new Error(`"${filename}" ist kein gültiges JSON: ${err?.message || err}`);
  }

  if (Array.isArray(parsed)) {
    return [tableFromArray(baseName, parsed)];
  }

  if (isRecord(parsed)) {
    // A common export shape: one object whose properties are each a record list.
    const arrayEntries = Object.entries(parsed).filter(
      (entry): entry is [string, JsonValue[]] => Array.isArray(entry[1])
    );
    if (arrayEntries.length > 0) {
      return arrayEntries.map(([key, items]) => tableFromArray(tableNameFrom(key), items));
    }
    // Otherwise present the object itself as a key/value table.
    return [
      buildTable(
        baseName,
        ['schluessel', 'wert'],
        Object.entries(parsed).map(([key, value]) => [key, flattenCell(value)])
      ),
    ];
  }

  return [buildTable(baseName, ['wert'], [[flattenCell(parsed)]])];
}
