import type { Connection } from '../redis/connection';
import { readValue, scanPage, type KeyValue } from '../redis/keyspace';
import { childrenOf, edgesOf, readNode, rootsOf, survey } from '../redis/phaseX';
import { asDisplayText, isBinary, type WireValue } from '../redis/wire';

/**
 * The Redis HTTP surface of Vektor, resolved against the connection
 * open in the window right now.
 *
 * Everything here runs in the renderer, on the same connection the UI reads
 * from — same server, same database index, same read-only setting. A tool that
 * opened its own connection would be looking at a different session: a
 * different `SELECT`ed database, and none of the gating the user chose.
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

export interface RouterContext {
  /** The API's own write switch, separate from the window's. */
  allowWrites: boolean;
  /** Lets the mounted workspace invalidate views after an API mutation. */
  onDataChanged?: () => void;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

const ok = (payload: unknown): ApiReply => ({ status: 200, payload });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiReply => ({
  status,
  payload: { error, ...extra },
});

/** The connection the window has open; set by App.tsx on every change. */
let current: Connection | null = null;

export function setConnection(connection: Connection | null): void {
  current = connection;
}

/**
 * Replies as JSON.
 *
 * A binary bulk string is described rather than dumped as text: a client that
 * received mangled UTF-8 could not tell it from a value that really looks like
 * that, and one that received base64 without being told would treat it as a
 * string.
 */
function encode(value: WireValue): unknown {
  switch (value.t) {
    case 'nil':
      return null;
    case 'int':
      return value.v;
    case 'bool':
      return value.v;
    case 'error':
      return { __type: 'error', message: value.v };
    case 'bulk':
      return isBinary(value)
        ? { __type: 'binary', base64: value.v }
        : value.v;
    case 'array':
    case 'set':
    case 'push':
      return (value.v as WireValue[]).map(encode);
    case 'map': {
      const items = value.v as WireValue[];
      const out: Record<string, unknown> = {};
      for (let index = 0; index + 1 < items.length; index += 2) {
        out[asDisplayText(items[index])] = encode(items[index + 1]);
      }
      return out;
    }
    default:
      return asDisplayText(value);
  }
}

function readLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

/** What `/health` reports even while the renderer is busy. */
export function health() {
  return {
    connected: current !== null,
    host: current ? `${current.host}:${current.port}` : '',
    database: current?.database ?? 0,
    version: current?.facts.version ?? '',
  };
}

export async function route(call: ApiCall, context: RouterContext): Promise<ApiReply> {
  const segments = call.path.replace(/^\/+|\/+$/g, '').split('/');

  // `/api/v1/health` and `/api/v1/ping` never arrive here: the host answers
  // them from the snapshot `pushHealth` gives it, so a health check still
  // replies while the renderer is busy — which is when one is worth asking.
  if (segments[0] !== 'api' || segments[1] !== 'v1') {
    return fail(404, `Unbekannter Pfad "${call.publicPath ?? call.path}".`);
  }

  const connection = current;
  if (!connection) {
    return fail(503, 'Vektor ist mit keiner Redis-Instanz verbunden.', {
      hint: 'Im Fenster oben links eine Verbindung öffnen.',
    });
  }

  const resource = segments[2];

  try {
    switch (resource) {
      case 'server':
        return ok({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          ...connection.facts,
          commandsKnown: connection.catalogue.size,
        });

      case 'keys': {
        // /api/v1/keys — one SCAN page, cursor and all.
        if (segments.length === 3) {
          const page = await scanPage(connection, {
            cursor: call.query.cursor ?? '0',
            match: call.query.match || undefined,
            type: call.query.type || undefined,
            count: readLimit(call.query.count),
          });
          return ok({
            cursor: page.cursor,
            done: page.cursor === '0',
            count: page.entries.length,
            keys: page.entries,
          });
        }

        // /api/v1/keys/<key> — the key may itself contain slashes.
        const key = decodeURIComponent(segments.slice(3).join('/'));
        const type = call.query.type || null;
        const resolvedType =
          type ?? asDisplayText(await connection.read(['TYPE', key]));
        if (resolvedType === 'none') return fail(404, `"${key}" existiert nicht.`);

        const value = await readValue(connection, key, resolvedType, {
          offset: Number(call.query.offset) || 0,
          cursor: call.query.cursor,
          limit: readLimit(call.query.limit),
        });
        return ok({ key, type: resolvedType, value: serialiseValue(value) });
      }

      case 'command': {
        if (call.method !== 'POST') return fail(405, 'Befehle werden per POST gesendet.');
        const args = (call.body as { args?: unknown } | null)?.args;
        if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
          return fail(400, 'Erwartet wird { "args": ["GET", "schlüssel"] }.');
        }

        const verdict = connection.inspect(args as string[]);
        if (connection.immutable && verdict.info.kind !== 'read') {
          return fail(403, 'Dieser Speicherstand ist eine geschützte Arbeitskopie.', {
            hint: 'Der ausgewählte Projektordner wird von Vektor niemals verändert.',
            command: verdict.info.name,
          });
        }
        // The API has its own switch, and the confirmation the console asks a
        // person for cannot be asked of a client — a destructive command is
        // refused here rather than being auto-confirmed.
        if (verdict.info.kind !== 'read' && !context.allowWrites) {
          return fail(403, 'Schreibende Aufrufe sind über die API abgeschaltet.', {
            hint: 'Im API-Tab der App "Schreibzugriff erlauben" aktivieren.',
            command: verdict.info.name,
          });
        }
        if (verdict.needsConfirmation) {
          return fail(409, verdict.reason ?? 'Dieser Befehl verlangt eine Bestätigung im Fenster.', {
            hint: 'Befehle mit Bestätigungspflicht laufen nur in der Konsole der App.',
            command: verdict.info.name,
          });
        }

        const reply = await connection.transport.command(connection.id, args as string[]);
        if (reply.t === 'error') return fail(400, reply.v, { command: verdict.info.name });
        if (verdict.info.kind !== 'read') context.onDataChanged?.();
        return ok({ command: verdict.info.name, value: encode(reply) });
      }

      case 'phasex': {
        const space = call.query.space || '';
        if (segments[3] === 'survey' || segments.length === 3) {
          return ok(await survey(connection));
        }
        if (!space) return fail(400, 'Der Datenraum fehlt: ?space=test');

        if (segments[3] === 'roots') return ok({ space, roots: await rootsOf(connection, space) });

        if (segments[3] === 'nodes') {
          const id = decodeURIComponent(segments.slice(4).join('/'));
          if (!id) return fail(400, 'Keine Knoten-Kennung angegeben.');

          if (id.endsWith('/children')) {
            const nodeId = id.slice(0, -'/children'.length);
            return ok({ space, node: nodeId, children: await childrenOf(connection, space, nodeId) });
          }
          if (id.endsWith('/edges')) {
            const nodeId = id.slice(0, -'/edges'.length);
            return ok({ space, node: nodeId, edges: await edgesOf(connection, space, nodeId) });
          }

          const node = await readNode(connection, space, id);
          return ok({
            ...node,
            fields: Object.fromEntries(node.fields),
          });
        }
        return fail(404, `Unbekannter Phase-X-Pfad "${call.publicPath ?? call.path}".`);
      }

      default:
        return fail(404, `Unbekannte Ressource "${resource}".`);
    }
  } catch (err: any) {
    return fail(500, err?.message || String(err));
  }
}

/** Turns a typed value page into plain JSON for a client. */
function serialiseValue(value: KeyValue): unknown {
  switch (value.kind) {
    case 'string':
      return { kind: value.kind, bytes: value.bytes, truncated: value.truncated, value: encode(value.value) };
    case 'list':
      return { kind: value.kind, total: value.total, offset: value.offset, items: value.items.map(encode) };
    case 'set':
      return { kind: value.kind, total: value.total, cursor: value.cursor, items: value.items.map(encode) };
    case 'hash':
      return {
        kind: value.kind,
        total: value.total,
        cursor: value.cursor,
        fields: Object.fromEntries(
          value.fields.map(([field, item]) => [asDisplayText(field), encode(item)])
        ),
      };
    case 'zset':
      return {
        kind: value.kind,
        total: value.total,
        offset: value.offset,
        entries: value.entries.map((entry) => ({ member: encode(entry.member), score: entry.score })),
      };
    case 'stream':
      return {
        kind: value.kind,
        total: value.total,
        entries: value.entries.map((entry) => ({
          id: entry.id,
          fields: Object.fromEntries(entry.fields.map(([field, item]) => [field, encode(item)])),
        })),
      };
    default:
      return value;
  }
}
