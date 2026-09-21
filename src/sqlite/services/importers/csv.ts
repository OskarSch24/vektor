import { buildTable, ImportedTable, RawCell, tableNameFrom } from './tables';

const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Guesses the delimiter by taking the one that yields the most consistent
 * column count across the first few lines — more reliable than counting
 * occurrences, which trips over commas inside quoted text.
 */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const rows = parseDelimited(sample, delimiter).slice(0, 20);
    if (rows.length < 2) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    const consistent = rows.filter((row) => row.length === width).length / rows.length;
    // Prefer consistency first, then the wider table.
    const score = consistent * 100 + Math.min(width, 50);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** RFC 4180 parser: handles quoted fields, escaped quotes and embedded newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Ignore the trailing empty line every text file ends with.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
    } else if (char === delimiter) {
      pushField();
      index += 1;
    } else if (char === '\r') {
      // Swallow CRLF as a single line break.
      index += text[index + 1] === '\n' ? 2 : 1;
      pushRow();
    } else if (char === '\n') {
      index += 1;
      pushRow();
    } else {
      field += char;
      index += 1;
    }
  }

  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

export function importCsv(bytes: Uint8Array, filename: string): ImportedTable[] {
  // Strip a UTF-8 BOM; Excel writes one and it would end up in the first header.
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  if (text.trim() === '') {
    throw new Error(`"${filename}" ist leer.`);
  }

  const delimiter = filename.toLowerCase().endsWith('.tsv') ? '\t' : detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) {
    throw new Error(`"${filename}" enthält keine Datenzeilen.`);
  }

  const [header, ...body] = rows as RawCell[][];
  return [buildTable(tableNameFrom(filename), header, body)];
}
