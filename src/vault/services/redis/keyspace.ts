import type { Connection } from './connection';
import { asItems, asNumber, asPairs, asText, asTextList, byteLength, type WireValue } from './wire';

/**
 * Reading a keyspace without stalling the server.
 *
 * Two rules run through this file. Keys are listed with `SCAN`, never `KEYS`:
 * `KEYS *` blocks a server for as long as it takes to walk every key, which on
 * a Phase-X vault is exactly when someone is watching. And values are read a
 * page at a time — a list with two million entries is opened, not loaded, and
 * the viewer asks for the slice it is about to draw.
 */

export const PAGE_SIZE = 200;
/** Above this, a string is shown as a head and the rest fetched on demand. */
export const STRING_PREVIEW_BYTES = 64 * 1024;

export interface KeyEntry {
  key: string;
  /** Base64 when the key name itself is not valid UTF-8; rare but legal. */
  binaryKey: boolean;
  type: string;
  /** −1 when the key never expires, −2 when it vanished between SCAN and TTL. */
  ttl: number;
  /** Entries for a collection, bytes for a string; null when not applicable. */
  size: number | null;
  encoding: string;
}

export interface ScanResult {
  cursor: string;
  entries: KeyEntry[];
  /** Keys seen in this pass before filtering — tells "empty page" from "done". */
  scanned: number;
}

/** The command that reports an element count, per Redis type. */
const SIZE_COMMAND: Record<string, string> = {
  string: 'STRLEN',
  list: 'LLEN',
  set: 'SCARD',
  zset: 'ZCARD',
  hash: 'HLEN',
  stream: 'XLEN',
  vectorset: 'VCARD',
};

/**
 * One `SCAN` page, enriched with the type, TTL, size and encoding of every key.
 *
 * The enrichment is a single pipelined round trip. Asking key by key would be
 * four bridge hops per key — a page of 200 keys would take longer to describe
 * than the server took to find them.
 */
export async function scanPage(
  connection: Connection,
  options: { cursor?: string; match?: string; count?: number; type?: string } = {}
): Promise<ScanResult> {
  const args = ['SCAN', options.cursor ?? '0', 'COUNT', String(options.count ?? PAGE_SIZE)];
  if (options.match) args.push('MATCH', options.match);
  // Filtering by type in the server avoids shipping keys the UI would discard.
  if (options.type) args.push('TYPE', options.type);

  const reply = await connection.read(args);
  const [cursorValue, keysValue] = asItems(reply);
  const cursor = asText(cursorValue) ?? '0';
  const keyValues = asItems(keysValue);

  if (keyValues.length === 0) {
    return { cursor, entries: [], scanned: 0 };
  }

  const names = keyValues.map((value) => ({
    text: value.t === 'bulk' && value.b ? value.v : asText(value) ?? '',
    binary: value.t === 'bulk' && value.b === true,
  }));

  const typeReplies = await connection.readMany(names.map(({ text }) => ['TYPE', text]));
  const types = typeReplies.map((value) => asText(value) ?? 'none');

  const details = await connection.readMany(
    names.flatMap(({ text }, index) => {
      const sizeCommand = SIZE_COMMAND[types[index]];
      return [
        ['TTL', text],
        ['OBJECT', 'ENCODING', text],
        sizeCommand ? [sizeCommand, text] : ['TTL', text],
      ];
    })
  );

  const entries: KeyEntry[] = names.map(({ text, binary }, index) => {
    const base = index * 3;
    const hasSize = Boolean(SIZE_COMMAND[types[index]]);
    return {
      key: text,
      binaryKey: binary,
      type: types[index],
      ttl: asNumber(details[base]) ?? -1,
      encoding: asText(details[base + 1]) ?? '',
      size: hasSize ? asNumber(details[base + 2]) : null,
    };
  });

  // A key can expire between SCAN and TYPE; it is gone, not empty.
  return { cursor, entries: entries.filter((entry) => entry.type !== 'none'), scanned: names.length };
}

// MARK: - Values

export type KeyValue =
  | { kind: 'string'; bytes: number; value: WireValue; truncated: boolean }
  | { kind: 'list'; total: number; offset: number; items: WireValue[] }
  | { kind: 'set'; total: number; cursor: string; items: WireValue[] }
  | { kind: 'hash'; total: number; cursor: string; fields: [WireValue, WireValue][] }
  | { kind: 'zset'; total: number; offset: number; entries: { member: WireValue; score: string }[] }
  | { kind: 'stream'; total: number; entries: { id: string; fields: [string, WireValue][] }[] }
  | { kind: 'json'; text: string; valid: boolean }
  | { kind: 'vectorset'; card: number; dimensions: number; sample: string[]; info: [string, string][] }
  | { kind: 'unsupported'; type: string; note: string };

export interface ValueRequest {
  offset?: number;
  cursor?: string;
  limit?: number;
}

/** Reads one page of a key's value, chosen by its type. */
export async function readValue(
  connection: Connection,
  key: string,
  type: string,
  request: ValueRequest = {}
): Promise<KeyValue> {
  const limit = request.limit ?? PAGE_SIZE;
  const offset = request.offset ?? 0;

  switch (type) {
    case 'string': {
      const [lengthReply] = await connection.readMany([['STRLEN', key]]);
      const bytes = asNumber(lengthReply) ?? 0;
      if (bytes > STRING_PREVIEW_BYTES) {
        // GETRANGE, not GET: pulling a 200 MB value across the bridge to show
        // its first screen would cost the memory twice and show no more.
        const head = await connection.read(['GETRANGE', key, '0', String(STRING_PREVIEW_BYTES - 1)]);
        return { kind: 'string', bytes, value: head, truncated: true };
      }
      const value = await connection.read(['GET', key]);
      return { kind: 'string', bytes: bytes || byteLength(value), value, truncated: false };
    }

    case 'list': {
      const [lengthReply, itemsReply] = await connection.readMany([
        ['LLEN', key],
        ['LRANGE', key, String(offset), String(offset + limit - 1)],
      ]);
      return {
        kind: 'list',
        total: asNumber(lengthReply) ?? 0,
        offset,
        items: asItems(itemsReply),
      };
    }

    case 'set': {
      const [cardReply, scanReply] = await connection.readMany([
        ['SCARD', key],
        ['SSCAN', key, request.cursor ?? '0', 'COUNT', String(limit)],
      ]);
      const [nextCursor, members] = asItems(scanReply);
      return {
        kind: 'set',
        total: asNumber(cardReply) ?? 0,
        cursor: asText(nextCursor) ?? '0',
        items: asItems(members),
      };
    }

    case 'hash': {
      const [lengthReply, scanReply] = await connection.readMany([
        ['HLEN', key],
        ['HSCAN', key, request.cursor ?? '0', 'COUNT', String(limit)],
      ]);
      const [nextCursor, flat] = asItems(scanReply);
      return {
        kind: 'hash',
        total: asNumber(lengthReply) ?? 0,
        cursor: asText(nextCursor) ?? '0',
        fields: asPairs(flat),
      };
    }

    case 'zset': {
      const [cardReply, rangeReply] = await connection.readMany([
        ['ZCARD', key],
        ['ZRANGE', key, String(offset), String(offset + limit - 1), 'WITHSCORES'],
      ]);
      return {
        kind: 'zset',
        total: asNumber(cardReply) ?? 0,
        offset,
        entries: asPairs(rangeReply).map(([member, score]) => ({
          member,
          // Scores are doubles; the text form is what Redis sent and keeps
          // 9007199254740993 from becoming …92.
          score: asText(score) ?? '0',
        })),
      };
    }

    case 'stream': {
      const [lengthReply, rangeReply] = await connection.readMany([
        ['XLEN', key],
        // Newest first: a stream is read at its head far more often than at its
        // start, and the head is where an ingest run's last entries are.
        ['XREVRANGE', key, '+', '-', 'COUNT', String(limit)],
      ]);
      const entries = asItems(rangeReply).map((entry) => {
        const [idValue, fieldsValue] = asItems(entry);
        const flat = asItems(fieldsValue);
        const fields: [string, WireValue][] = [];
        for (let index = 0; index + 1 < flat.length; index += 2) {
          fields.push([asText(flat[index]) ?? '', flat[index + 1]]);
        }
        return { id: asText(idValue) ?? '', fields };
      });
      return { kind: 'stream', total: asNumber(lengthReply) ?? 0, entries };
    }

    case 'ReJSON-RL': {
      const reply = await connection.read(['JSON.GET', key]);
      const text = asText(reply) ?? '';
      let valid = true;
      try {
        JSON.parse(text);
      } catch {
        valid = false;
      }
      return { kind: 'json', text, valid };
    }

    case 'vectorset': {
      const [cardReply, dimReply, infoReply, sampleReply] = await connection.readMany([
        ['VCARD', key],
        ['VDIM', key],
        ['VINFO', key],
        ['VRANDMEMBER', key, String(Math.min(limit, 20))],
      ]);
      const flat = asTextList(infoReply);
      const info: [string, string][] = [];
      for (let index = 0; index + 1 < flat.length; index += 2) {
        info.push([flat[index], flat[index + 1]]);
      }
      return {
        kind: 'vectorset',
        card: asNumber(cardReply) ?? 0,
        dimensions: asNumber(dimReply) ?? 0,
        sample: asTextList(sampleReply),
        info,
      };
    }

    default:
      return {
        kind: 'unsupported',
        type,
        note:
          type === 'none'
            ? 'Der Schlüssel existiert nicht mehr — er ist abgelaufen oder wurde gelöscht.'
            : `Für den Typ "${type}" hat diese Redis-Instanz keine Leseroutine, die Vektor kennt.`,
      };
  }
}

/** Human-readable TTL. −1 means no expiry, −2 that the key is gone. */
export function formatTtl(ttl: number): string {
  if (ttl === -1) return 'unbegrenzt';
  if (ttl === -2) return 'abgelaufen';
  if (ttl < 60) return `${ttl} s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)} min`;
  if (ttl < 86_400) return `${Math.floor(ttl / 3600)} h`;
  return `${Math.floor(ttl / 86_400)} d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
