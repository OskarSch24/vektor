import { GraphNode, PropertyValue } from '../types/graph';

/**
 * Presentation helpers shared by the canvas, the inspector and the sidebar.
 */

/**
 * The palette labels are coloured from — the same accents the table view uses
 * for its type badges, so every data view reads as one family.
 */
export const LABEL_COLORS = [
  '#0A84FF', // blue
  '#BF5AF2', // purple
  '#30D158', // green
  '#FF9F0A', // amber
  '#FF375F', // pink
  '#64D2FF', // cyan
  '#5E5CE6', // indigo
  '#FF453A', // red
] as const;

/**
 * The labels the pipeline itself produces get a fixed colour. The set is small
 * and known, so leaving it to a hash would be a needless gamble — and a losing
 * one: hashing these particular strings puts five of them on the same red.
 */
const ASSIGNED_COLORS: Record<string, string> = {
  Person: '#0A84FF',
  Organization: '#BF5AF2',
  Place: '#30D158',
  Topic: '#FF9F0A',
  Product: '#FF375F',
  Event: '#64D2FF',
  Work: '#5E5CE6',
  Scene: '#FF453A',
  // Sources are the spine of the graph and share the family they belong to.
  Page: '#0A84FF',
  Video: '#BF5AF2',
  Post: '#64D2FF',
  Site: '#737378',
  Source: '#A1A1A6',
  Author: '#0A84FF',
  // Coordination records. Their labels are deliberately not `Work`, `Event` or
  // `Person`, which the ingest ontology already uses for creative works,
  // calendar events and people: one graph can hold both, and a workstream
  // counted as a schema.org Work in the statistics would be a quiet lie.
  Workstream: '#5E5CE6',
  Actor: '#0A84FF',
  Change: '#FF9F0A',
  Handoff: '#64D2FF',
  Decision: '#30D158',
  Target: '#737378',
};

/**
 * Assigns a stable colour per label: fixed for the known ontology, otherwise
 * derived from the name so a label keeps its colour across sessions.
 */
export function labelColor(label: string): string {
  const assigned = ASSIGNED_COLORS[label];
  if (assigned) return assigned;

  // FNV-1a with a final avalanche step. The plain multiply-and-add hash this
  // replaced left its entropy in the high bits, which a modulo by a power of
  // two throws away — hence the clustering.
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;

  return LABEL_COLORS[(hash >>> 0) % LABEL_COLORS.length];
}

/** The property a node is identified by in lists and on the canvas. */
export function nodeTitle(node: GraphNode): string {
  const candidates = ['name', 'title', 'label', 'handle', 'text', 'url'];
  for (const key of candidates) {
    const value = node.properties[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return node.id;
}

/** Shortens a title for the canvas, where space is measured in pixels. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function formatPropertyValue(value: PropertyValue): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'wahr' : 'falsch';
  if (typeof value === 'number') return new Intl.NumberFormat('de-DE').format(value);
  return value;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('de-DE').format(value);
}

/** Compact form for counters that grow into the millions, e.g. tokens. */
export function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} Mio.`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatRelativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'gerade eben';
  if (seconds < 3600) return `vor ${Math.floor(seconds / 60)} Min.`;
  if (seconds < 86_400) return `vor ${Math.floor(seconds / 3600)} Std.`;
  if (seconds < 604_800) return `vor ${Math.floor(seconds / 86_400)} Tg.`;
  return new Date(isoDate).toLocaleDateString('de-DE');
}

/** A short, readable host name for display next to a source. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Deterministic ids: the same entity ingested from two pages has to land on the
 * same node, otherwise the graph fragments into duplicates. The id is derived
 * from label plus normalised name, never from a counter.
 */
export function entityId(label: string, name: string): string {
  const normalised = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return `${label.toLowerCase()}:${normalised || hash(name)}`;
}

/** URL-keyed ids for pages, videos and posts, which have a natural identity. */
export function urlId(prefix: string, url: string): string {
  try {
    const parsed = new URL(url);
    // Tracking parameters would otherwise turn one page into many nodes.
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|si$|igshid)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    return `${prefix}:${parsed.host}${parsed.pathname}${parsed.search}`.slice(0, 200);
  } catch {
    return `${prefix}:${hash(url)}`;
  }
}

export function edgeId(from: string, type: string, to: string): string {
  return `${from}|${type}|${to}`;
}

function hash(value: string): string {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = (result * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(result).toString(36);
}
