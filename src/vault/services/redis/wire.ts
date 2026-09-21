/**
 * The reply shape both transports agree on.
 *
 * Redis replies are not JSON: `+OK`, `$-1` and an empty array all mean
 * different things, and a bulk string may hold bytes that are not text at all.
 * Flattening that into plain JavaScript values would lose exactly the
 * distinctions a viewer exists to show — "the key holds an empty string" and
 * "the key does not exist" would both arrive as `null`. So the type tag travels
 * with the value, and the UI decides how to render it.
 */

export type WireValue =
  | { t: 'simple'; v: string }
  | { t: 'error'; v: string }
  | { t: 'int'; v: number }
  /** `b` marks `v` as base64 of bytes that are not valid UTF-8. */
  | { t: 'bulk'; v: string; b?: true }
  | { t: 'nil' }
  | { t: 'array'; v: WireValue[] }
  | { t: 'map'; v: WireValue[] }
  | { t: 'set'; v: WireValue[] }
  | { t: 'push'; v: WireValue[] }
  | { t: 'double'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'big'; v: string };

export class RedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisReplyError';
  }
}

export function isError(value: WireValue): value is { t: 'error'; v: string } {
  return value.t === 'error';
}

/** Throws on an error reply; returns the value otherwise. */
export function unwrap(value: WireValue): WireValue {
  if (isError(value)) throw new RedisReplyError(value.v);
  return value;
}

/** True for a bulk string the server sent as raw bytes. */
export function isBinary(value: WireValue): boolean {
  return value.t === 'bulk' && value.b === true;
}

/**
 * The text of a reply, or null when there is none. Binary bulk strings return
 * null rather than their base64 — a caller reading a key name or a TYPE result
 * wants text, and silently handing back base64 would look like a valid answer.
 */
export function asText(value: WireValue): string | null {
  switch (value.t) {
    case 'simple':
    case 'double':
    case 'big':
      return value.v;
    case 'bulk':
      return value.b ? null : value.v;
    case 'int':
      return String(value.v);
    case 'bool':
      return value.v ? '1' : '0';
    default:
      return null;
  }
}

/** Same as `asText`, but base64 for binary values — for display, not for logic. */
export function asDisplayText(value: WireValue): string {
  if (value.t === 'nil') return '';
  if (value.t === 'bulk' && value.b) return value.v;
  return asText(value) ?? '';
}

export function asNumber(value: WireValue): number | null {
  if (value.t === 'int') return value.v;
  const text = asText(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asItems(value: WireValue): WireValue[] {
  return value.t === 'array' || value.t === 'set' || value.t === 'map' || value.t === 'push'
    ? value.v
    : [];
}

/** Elements as plain strings — for replies that are known to be text lists. */
export function asTextList(value: WireValue): string[] {
  return asItems(value).map((item) => asDisplayText(item));
}

/**
 * Reply pairs as tuples. `HGETALL` and `ZRANGE … WITHSCORES` arrive flattened
 * in RESP2 but as a real map in RESP3, so both are folded here rather than at
 * every call site.
 */
export function asPairs(value: WireValue): [WireValue, WireValue][] {
  const items = asItems(value);
  const pairs: [WireValue, WireValue][] = [];
  for (let index = 0; index + 1 < items.length; index += 2) {
    pairs.push([items[index], items[index + 1]]);
  }
  return pairs;
}

/** Parses the `key:value` lines of an `INFO` reply into a flat record. */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    out[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return out;
}

/** Byte length of a bulk value, counting base64 back to real bytes. */
export function byteLength(value: WireValue): number {
  if (value.t !== 'bulk') return asDisplayText(value).length;
  if (!value.b) return new TextEncoder().encode(value.v).length;
  const padding = value.v.endsWith('==') ? 2 : value.v.endsWith('=') ? 1 : 0;
  return Math.max(0, (value.v.length * 3) / 4 - padding);
}
