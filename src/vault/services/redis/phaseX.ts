import type { Connection } from './connection';
import { scanPage } from './keyspace';
import { asItems, asNumber, asPairs, asText, asTextList } from './wire';

/**
 * The Phase-X projection: a hierarchy and a graph, read out of plain Redis.
 *
 * This is the one view in the app that assumes a key layout instead of
 * discovering it. The layout is the one the Phase-X data hub writes:
 *
 *   px:<space>:node:<id>              the node itself — hash or JSON document
 *   px:<space>:node:<id>:children     sorted set, score = position among siblings
 *   px:<space>:node:<id>:edges        sorted set or set of "<relation>|<target>"
 *   px:<space>:root                   set of ids with no parent
 *
 * Two decisions keep it from being brittle. Nodes are read as either a hash or
 * a RedisJSON document, because whether `JSON.SET` exists depends on the build
 * — a Homebrew redis-server has no JSON at all, and the projector then writes
 * hashes. And children come from a sorted set rather than a plain set: order
 * among siblings is meaning here — paragraph three follows paragraph two — and
 * the transformation repo this design came from lost exactly that by using
 * unordered sets.
 *
 * Nothing is written from this view. It reads a projection; the projector owns
 * it.
 */

export const RELATION_TYPES = [
  'REPLIES_TO', 'AUTHORED_BY', 'MENTIONS', 'SAME_AS',
  'SUPPORTS', 'CONTRADICTS', 'DERIVED_FROM', 'OBSERVED_IN',
] as const;

export interface PhaseXNode {
  id: string;
  space: string;
  /** Node fields as stored — free-form, since the projector owns the schema. */
  fields: [string, string][];
  /** Convenience lookups the UI leans on when the projector supplies them. */
  nodeType: string;
  title: string;
  childCount: number;
  edgeCount: number;
  /** How the node was stored, so the inspector can say so. */
  storage: 'hash' | 'json' | 'string' | 'fehlt';
}

export interface PhaseXChild {
  id: string;
  position: number;
}

export interface PhaseXEdge {
  relation: string;
  target: string;
}

export interface PhaseXSurvey {
  present: boolean;
  spaces: string[];
  nodeCount: number;
  /** Keys that look like the schema but sit outside any recognised space. */
  strays: string[];
  note: string;
}

const keyOf = (space: string, id: string, suffix = '') =>
  `px:${space}:node:${id}${suffix}`;

/**
 * Looks for the schema without walking the whole keyspace.
 *
 * A bounded number of SCAN passes is deliberate: this runs on every connect,
 * and an instance that has nothing to do with Phase X must not pay for the
 * question with a full scan.
 */
export async function survey(connection: Connection): Promise<PhaseXSurvey> {
  const spaces = new Set<string>();
  const strays: string[] = [];
  let nodeCount = 0;
  let cursor = '0';

  for (let pass = 0; pass < 12; pass += 1) {
    const page = await scanPage(connection, { cursor, match: 'px:*', count: 500 });
    cursor = page.cursor;

    for (const entry of page.entries) {
      // px:<space>:node:<id> — anything shorter is a stray, anything longer is
      // one of the :children / :edges companions and is counted with its node.
      const parts = entry.key.split(':');
      if (parts.length >= 4 && parts[2] === 'node' && !entry.key.endsWith(':children') && !entry.key.endsWith(':edges')) {
        spaces.add(parts[1]);
        nodeCount += 1;
      } else if (parts.length < 3) {
        strays.push(entry.key);
      }
    }

    if (cursor === '0') break;
  }

  const present = nodeCount > 0;
  return {
    present,
    spaces: [...spaces].sort(),
    nodeCount,
    strays: strays.slice(0, 20),
    note: present
      ? `${nodeCount} Knoten in ${spaces.size} ${spaces.size === 1 ? 'Datenraum' : 'Datenräumen'} gefunden.`
      : cursor === '0'
        ? 'In dieser Datenbank liegen keine Schlüssel im Muster px:<raum>:node:<id>.'
        : 'Kein Phase-X-Muster in den ersten Durchläufen — bei sehr großen Keyspaces kann es weiter hinten liegen.',
  };
}

/** Reads one node, whichever way the projector stored it. */
export async function readNode(
  connection: Connection,
  space: string,
  id: string
): Promise<PhaseXNode> {
  const key = keyOf(space, id);
  const type = asText(await connection.read(['TYPE', key])) ?? 'none';

  let fields: [string, string][] = [];
  let storage: PhaseXNode['storage'] = 'fehlt';

  if (type === 'hash') {
    storage = 'hash';
    fields = asPairs(await connection.read(['HGETALL', key])).map(([field, value]) => [
      asText(field) ?? '',
      asText(value) ?? '',
    ]);
  } else if (type === 'ReJSON-RL') {
    storage = 'json';
    const text = asText(await connection.read(['JSON.GET', key])) ?? '{}';
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      fields = Object.entries(parsed).map(([field, value]) => [
        field,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]);
    } catch {
      fields = [['(roh)', text]];
    }
  } else if (type === 'string') {
    // A projector that writes JSON as a plain string on a server without
    // RedisJSON — the layout this design expects when JSON.SET is missing.
    storage = 'string';
    const text = asText(await connection.read(['GET', key])) ?? '';
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      fields = Object.entries(parsed).map(([field, value]) => [
        field,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]);
    } catch {
      fields = [['(roh)', text]];
    }
  }

  const [childCount, edgeCount] = await Promise.all([
    collectionSize(connection, keyOf(space, id, ':children')),
    collectionSize(connection, keyOf(space, id, ':edges')),
  ]);

  const lookup = (...names: string[]): string => {
    for (const name of names) {
      const found = fields.find(([field]) => field.toLowerCase() === name);
      if (found) return found[1];
    }
    return '';
  };

  return {
    id,
    space,
    fields,
    nodeType: lookup('node_type', 'type', 'kind'),
    title: lookup('title', 'name', 'label', 'text'),
    childCount,
    edgeCount,
    storage,
  };
}

/**
 * Children in their stored order.
 *
 * The score carries the position, so `ZRANGE … WITHSCORES` returns siblings in
 * document order rather than in whatever order the set happens to hash them.
 */
export async function childrenOf(
  connection: Connection,
  space: string,
  id: string,
  offset = 0,
  limit = 200
): Promise<PhaseXChild[]> {
  const key = keyOf(space, id, ':children');
  const type = asText(await connection.read(['TYPE', key])) ?? 'none';

  if (type === 'zset') {
    const reply = await connection.read([
      'ZRANGE', key, String(offset), String(offset + limit - 1), 'WITHSCORES',
    ]);
    return asPairs(reply).map(([member, score]) => ({
      id: asText(member) ?? '',
      position: Number(asText(score) ?? '0'),
    }));
  }

  if (type === 'set') {
    // The unordered fallback is scanned rather than loaded in full. Sorting by
    // id at least makes this bounded page stable; new projections should use a
    // sorted set so the score carries the real document order.
    const reply = await connection.read(['SSCAN', key, '0', 'COUNT', String(limit)]);
    const [, page] = asItems(reply);
    const members = asTextList(page).sort();
    return members.slice(offset, offset + limit).map((memberId, index) => ({
      id: memberId,
      position: offset + index,
    }));
  }

  if (type === 'list') {
    const items = asTextList(
      await connection.read(['LRANGE', key, String(offset), String(offset + limit - 1)])
    );
    return items.map((memberId, index) => ({ id: memberId, position: offset + index }));
  }

  return [];
}

/** Typed edges, stored as "<RELATION>|<target-id>" members. */
export async function edgesOf(
  connection: Connection,
  space: string,
  id: string,
  limit = 200
): Promise<PhaseXEdge[]> {
  const key = keyOf(space, id, ':edges');
  const type = asText(await connection.read(['TYPE', key])) ?? 'none';

  let members: string[] = [];
  if (type === 'zset') {
    members = asTextList(await connection.read(['ZRANGE', key, '0', String(limit - 1)]));
  } else if (type === 'set') {
    const reply = await connection.read(['SSCAN', key, '0', 'COUNT', String(limit)]);
    const [, page] = asItems(reply);
    members = asTextList(page).slice(0, limit);
  } else if (type === 'hash') {
    // relation → target, one edge per field.
    return asPairs(await connection.read(['HGETALL', key]))
      .map(([relation, target]) => ({
        relation: asText(relation) ?? '',
        target: asText(target) ?? '',
      }))
      .slice(0, limit);
  } else {
    return [];
  }

  return members.map((member) => {
    const separator = member.indexOf('|');
    return separator === -1
      ? { relation: 'VERWEIST_AUF', target: member }
      : { relation: member.slice(0, separator), target: member.slice(separator + 1) };
  });
}

/** Root ids of a space — the entry points the tree starts from. */
export async function rootsOf(
  connection: Connection,
  space: string,
  limit = 500
): Promise<string[]> {
  const key = `px:${space}:root`;
  const type = asText(await connection.read(['TYPE', key])) ?? 'none';

  if (type === 'set') {
    const reply = await connection.read(['SSCAN', key, '0', 'COUNT', String(limit)]);
    const [, page] = asItems(reply);
    return asTextList(page).sort().slice(0, limit);
  }
  if (type === 'zset') {
    return asTextList(await connection.read(['ZRANGE', key, '0', String(limit - 1)]));
  }
  if (type === 'list') {
    return asTextList(await connection.read(['LRANGE', key, '0', String(limit - 1)]));
  }

  // No root key: fall back to scanning the space's nodes and offering the first
  // page. Better an incomplete entry point than an empty view.
  const found: string[] = [];
  let cursor = '0';
  for (let pass = 0; pass < 6 && found.length < 200; pass += 1) {
    const page = await scanPage(connection, {
      cursor,
      match: `px:${space}:node:*`,
      count: 300,
    });
    cursor = page.cursor;
    for (const entry of page.entries) {
      if (entry.key.endsWith(':children') || entry.key.endsWith(':edges')) continue;
      found.push(entry.key.split(':').slice(3).join(':'));
    }
    if (cursor === '0') break;
  }
  return found.sort();
}

/** Formats a node for the tree: a title if the projector gave one, else the id. */
export function labelOf(node: { id: string; title: string; nodeType: string }): string {
  const label = node.title || node.id;
  return node.nodeType ? `${label} · ${node.nodeType}` : label;
}

/** Number of members in one relationship container, whichever Redis type a projector used. */
async function collectionSize(connection: Connection, key: string): Promise<number> {
  const type = asText(await connection.read(['TYPE', key])) ?? 'none';
  const command: Record<string, string> = {
    zset: 'ZCARD',
    set: 'SCARD',
    list: 'LLEN',
    hash: 'HLEN',
  };
  const sizeCommand = command[type];
  if (!sizeCommand) return 0;
  return asNumber(await connection.read([sizeCommand, key])) ?? 0;
}

/** Unused elsewhere, but it documents the contract the projector must meet. */
export const EXPECTED_LAYOUT = [
  'px:<raum>:node:<id>            Hash oder JSON-Dokument mit den Feldern des Knotens',
  'px:<raum>:node:<id>:children   Sorted Set, Score = Position unter den Geschwistern',
  'px:<raum>:node:<id>:edges      Sorted Set oder Set mit "RELATION|ziel-id"',
  'px:<raum>:root                 Set der Knoten ohne Elternteil',
];
