import { asItems, asText, type WireValue } from './wire';

/**
 * What a command is allowed to do — and who decides.
 *
 * The obvious implementation is a hand-written list of write commands. It is
 * also wrong within a release: Redis 8 ships vector sets, a module adds
 * `JSON.SET`, and a list written today silently classifies tomorrow's command
 * as harmless. So the catalogue comes from `COMMAND`, which every server
 * answers for exactly the commands it actually has, with the flags it actually
 * enforces.
 *
 * The static tables below add only what the server's flags do not express: a
 * short list of commands that are destructive in a way no `write` flag conveys,
 * and a fallback for the case where `COMMAND` itself is unavailable.
 */

export type CommandKind = 'read' | 'write' | 'admin' | 'unknown';

export interface CommandInfo {
  name: string;
  kind: CommandKind;
  /** Server flags, verbatim — shown in the console's command hint. */
  flags: string[];
  /** `KEYS`, `FLUSHALL` and friends can stall a server for seconds. */
  blocking: boolean;
  arity: number;
  summary?: string;
}

/**
 * Commands that need a deliberate confirmation even after writing is enabled.
 *
 * These are not merely writes. Each one either destroys data wholesale or
 * changes what the server is, and in every case a typo is enough: `FLUSHALL` is
 * three characters away from `FLUSHDB`, and the audit in the Phase-X plan found
 * exactly this — an unguarded `flushdb()` sitting in a helper script.
 */
export const DESTRUCTIVE = new Set([
  'flushall', 'flushdb', 'shutdown', 'swapdb', 'migrate', 'failover',
  'replicaof', 'slaveof', 'reset', 'script|flush', 'function|flush',
  'cluster|reset', 'acl|deluser', 'config|resetstat', 'debug',
]);

/**
 * Commands that walk the whole keyspace. Not destructive, but on a large
 * instance they block the server for as long as they run — the browser uses
 * `SCAN` for that reason, and the console says so before running one.
 */
export const SWEEPING = new Set(['keys', 'flushall', 'flushdb', 'debug']);

/**
 * Used only when `COMMAND` is unavailable — an ACL can hide it. Deliberately
 * biased: anything not known to be a read is treated as a write, so a locked
 * viewer never lets something through because the catalogue was missing.
 */
const FALLBACK_READS = new Set([
  'get', 'mget', 'strlen', 'getrange', 'substr', 'exists', 'type', 'ttl', 'pttl',
  'expiretime', 'pexpiretime', 'randomkey', 'keys', 'scan', 'dbsize', 'select',
  'hget', 'hmget', 'hgetall', 'hkeys', 'hvals', 'hlen', 'hexists', 'hstrlen', 'hscan', 'hrandfield',
  'lrange', 'llen', 'lindex', 'lpos', 'sismember', 'smismember', 'smembers', 'scard', 'srandmember',
  'sscan', 'sinter', 'sintercard', 'sunion', 'sdiff',
  'zrange', 'zrangebyscore', 'zrangebylex', 'zrevrange', 'zrevrangebyscore', 'zrevrangebylex',
  'zscore', 'zmscore', 'zcard', 'zcount', 'zrank', 'zrevrank', 'zscan', 'zrandmember', 'zlexcount',
  'xrange', 'xrevrange', 'xlen', 'xinfo', 'xpending',
  'bitcount', 'bitpos', 'getbit', 'pfcount', 'object', 'memory', 'dump',
  'info', 'ping', 'echo', 'time', 'lastsave', 'lolwut', 'command', 'config', 'client',
  'dbsize', 'acl', 'latency', 'slowlog', 'function', 'script', 'wait', 'hello',
  'vcard', 'vdim', 'vemb', 'vgetattr', 'vinfo', 'vlinks', 'vrandmember', 'vsim',
  'json.get', 'json.mget', 'json.type', 'json.strlen', 'json.arrlen', 'json.objlen', 'json.objkeys',
  'ft.search', 'ft.aggregate', 'ft.info', 'ft._list', 'ft.explain',
  'ts.get', 'ts.mget', 'ts.range', 'ts.revrange', 'ts.info', 'ts.queryindex',
]);

/** Container commands whose subcommand decides everything about them. */
const CONTAINERS = new Set([
  'config', 'client', 'cluster', 'acl', 'command', 'script', 'function',
  'memory', 'object', 'xgroup', 'xinfo', 'latency', 'slowlog', 'pubsub', 'debug',
]);

export class CommandCatalogue {
  private readonly entries = new Map<string, CommandInfo>();

  /** True once the server's own catalogue was loaded. */
  readonly loaded: boolean;

  constructor(reply?: WireValue) {
    if (!reply) {
      this.loaded = false;
      return;
    }
    for (const entry of asItems(reply)) {
      this.absorb(entry);
    }
    this.loaded = this.entries.size > 0;
  }

  /**
   * One `COMMAND` row: [name, arity, flags, firstKey, lastKey, step, aclCats,
   * tips, keySpecs, subcommands]. Only the first three and the last are used;
   * the key positions matter to a proxy, not to a viewer.
   */
  private absorb(entry: WireValue, parent?: string): void {
    const fields = asItems(entry);
    if (fields.length < 3) return;

    const rawName = asText(fields[0])?.toLowerCase();
    if (!rawName) return;
    // Subcommands come back already qualified as "config|set" on modern servers
    // and bare on older ones; both end up under the qualified name.
    const name = parent && !rawName.includes('|') ? `${parent}|${rawName}` : rawName;

    const flags = asItems(fields[2])
      .map((flag) => asText(flag) ?? '')
      .filter(Boolean);

    this.entries.set(name, {
      name,
      kind: flags.includes('write')
        ? 'write'
        : flags.includes('admin')
          ? 'admin'
          : flags.includes('readonly')
            ? 'read'
            // No flag at all: PING, HELLO, SUBSCRIBE. They touch no data, and
            // treating them as writes would lock the console for no reason.
            : 'read',
      flags,
      blocking: flags.includes('blocking') || SWEEPING.has(name),
      arity: Number(asText(fields[1]) ?? 0),
    });

    for (const subcommand of asItems(fields[9] ?? { t: 'array', v: [] })) {
      this.absorb(subcommand, name);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** Looks a parsed command up, preferring the qualified subcommand entry. */
  lookup(args: string[]): CommandInfo {
    const head = (args[0] ?? '').toLowerCase();
    const qualified = args.length > 1 ? `${head}|${args[1].toLowerCase()}` : '';

    const direct = (qualified && this.entries.get(qualified)) || this.entries.get(head);
    if (direct) {
      // A read on a container command says nothing about the subcommand:
      // `CONFIG` is readonly, `CONFIG SET` is not. Without an entry for the
      // subcommand the safe reading wins.
      if (!qualified || !CONTAINERS.has(head) || this.entries.has(qualified)) {
        return direct;
      }
      return { ...direct, name: qualified, kind: 'admin' };
    }

    const known = FALLBACK_READS.has(qualified) || FALLBACK_READS.has(head);
    return {
      name: qualified || head,
      kind: this.loaded ? 'write' : known ? 'read' : 'unknown',
      flags: [],
      blocking: SWEEPING.has(head),
      arity: 0,
    };
  }
}

const sweepWarning = (name: string) =>
  `"${name.toUpperCase()}" durchläuft den gesamten Keyspace und blockiert den Server so lange. ` +
  'Der Schlüssel-Tab benutzt dafür SCAN, das in Häppchen arbeitet.';

export interface Verdict {
  allowed: boolean;
  /** True when the command needs an explicit confirmation before it runs. */
  needsConfirmation: boolean;
  info: CommandInfo;
  reason?: string;
}

/**
 * Decides whether a command may run.
 *
 * `writesAllowed` is the session switch from the settings; it is off after
 * every start. Confirmation is asked for independently of it, because the
 * commands that need it are exactly the ones a user does not undo.
 */
export function judge(
  args: string[],
  catalogue: CommandCatalogue,
  writesAllowed: boolean
): Verdict {
  const info = catalogue.lookup(args);
  const qualified = args.length > 1 ? `${args[0]?.toLowerCase()}|${args[1].toLowerCase()}` : '';
  const destructive = DESTRUCTIVE.has(info.name) || DESTRUCTIVE.has(qualified) ||
    DESTRUCTIVE.has((args[0] ?? '').toLowerCase());

  if (info.kind === 'read' && !destructive) {
    return {
      allowed: true,
      needsConfirmation: info.blocking,
      info,
      // A blocking read is allowed but still worth a word: the dialog is the
      // only place the user learns why a plain KEYS is being questioned.
      reason: info.blocking ? sweepWarning(info.name) : undefined,
    };
  }

  if (!writesAllowed) {
    return {
      allowed: false,
      needsConfirmation: false,
      info,
      reason:
        info.kind === 'unknown'
          ? `"${info.name}" ist dieser Redis-Version unbekannt und wird im Lesemodus nicht ausgeführt.`
          : `"${info.name.toUpperCase()}" verändert Daten. Schreibzugriff ist ausgeschaltet.`,
    };
  }

  return {
    allowed: true,
    needsConfirmation: destructive || info.blocking,
    info,
    reason: destructive
      ? `"${info.name.toUpperCase()}" kann Daten unwiederbringlich löschen.`
      : info.blocking
        ? sweepWarning(info.name)
        : undefined,
  };
}
