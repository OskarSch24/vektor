import { CommandCatalogue, judge, type Verdict } from './commands';
import {
  activeTransport,
  type ConnectConfig,
  type Transport,
} from './transport';
import { asItems, asText, asTextList, parseInfo, unwrap, type WireValue } from './wire';

/**
 * One open connection, and everything the app knows about the server behind it.
 *
 * Two things happen at connect time and nowhere else: the command catalogue is
 * read from the server, and the available data structures are detected. Both
 * are per-server facts — a Homebrew `redis-server` and a Redis Stack container
 * differ in what they can do, and an app that assumed either one would be
 * confidently wrong against the other.
 */

export interface Capability {
  id: 'json' | 'search' | 'timeseries' | 'bloom' | 'vectorset';
  label: string;
  available: boolean;
  /** The command whose presence was tested — shown when it is missing. */
  probe: string;
}

export interface ServerFacts {
  version: string;
  mode: string;
  role: string;
  /** Bytes in use, as reported by INFO memory. */
  memoryUsed: number;
  memoryHuman: string;
  uptimeSeconds: number;
  /** Databases the server was configured with, so the picker can offer them. */
  databaseCount: number;
  modules: { name: string; version: string }[];
  capabilities: Capability[];
  persistence: {
    aofEnabled: boolean;
    rdbLastSave: number;
    rdbChangesSinceSave: number;
  };
}

const CAPABILITY_PROBES: { id: Capability['id']; label: string; probe: string }[] = [
  { id: 'json', label: 'JSON-Dokumente', probe: 'json.get' },
  { id: 'search', label: 'Volltext- und Feldsuche', probe: 'ft.search' },
  { id: 'timeseries', label: 'Zeitreihen', probe: 'ts.range' },
  { id: 'bloom', label: 'Bloom- und Cuckoo-Filter', probe: 'bf.exists' },
  { id: 'vectorset', label: 'Vektor-Ähnlichkeit', probe: 'vsim' },
];

export class Connection {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly transport: Transport;

  private constructor(
    transport: Transport,
    result: { connectionId: string; host: string; port: number; db: number },
    public database: number,
    public readonly catalogue: CommandCatalogue,
    public readonly facts: ServerFacts,
    public readonly immutable: boolean,
    public readonly displayName?: string,
    public readonly availableDatabases: number[] = []
  ) {
    this.transport = transport;
    this.id = result.connectionId;
    this.host = result.host;
    this.port = result.port;
  }

  /**
   * Writing is off after every connect, deliberately: the setting is about this
   * session and this server, and carrying it over from the last one is how a
   * viewer turns into an accident.
   */
  writesAllowed = false;

  static async open(config: ConnectConfig): Promise<Connection> {
    const transport = activeTransport();
    const result = await transport.connect(config);

    // `COMMAND` is answered before anything else needs it, and an ACL that
    // hides it must not prevent connecting — the catalogue then falls back to
    // its conservative built-in list.
    let catalogue: CommandCatalogue;
    try {
      const reply = await transport.command(result.connectionId, ['COMMAND']);
      catalogue = new CommandCatalogue(reply.t === 'error' ? undefined : reply);
    } catch {
      catalogue = new CommandCatalogue();
    }

    const facts = await Connection.readFacts(transport, result.connectionId, catalogue);
    return new Connection(
      transport,
      result,
      config.db ?? 0,
      catalogue,
      facts,
      config.immutable ?? false,
      config.displayName,
      config.availableDatabases?.length
        ? config.availableDatabases
        : Array.from({ length: facts.databaseCount }, (_, index) => index)
    );
  }

  private static async readFacts(
    transport: Transport,
    connectionId: string,
    catalogue: CommandCatalogue
  ): Promise<ServerFacts> {
    const [infoReply, modulesReply, databasesReply] = await transport.pipeline(connectionId, [
      ['INFO'],
      ['MODULE', 'LIST'],
      ['CONFIG', 'GET', 'databases'],
    ]);

    const info = parseInfo(asText(infoReply) ?? '');

    // Every module row is a flat field list: name, <value>, ver, <value>, …
    const modules = asItems(modulesReply).map((entry) => {
      const fields = asTextList(entry);
      const nameIndex = fields.indexOf('name');
      const versionIndex = fields.indexOf('ver');
      return {
        name: nameIndex >= 0 ? fields[nameIndex + 1] ?? '' : '',
        version: versionIndex >= 0 ? fields[versionIndex + 1] ?? '' : '',
      };
    }).filter((module) => module.name);

    // A capability is present when its command is, not when a module name looks
    // right: in Redis 8 several of these are built in and list no module at all.
    const capabilities = CAPABILITY_PROBES.map((probe) => ({
      ...probe,
      available: catalogue.has(probe.probe),
    }));

    const databaseFields = asTextList(databasesReply);
    const databaseCount = Number(databaseFields[1] ?? '16');

    return {
      version: info.redis_version ?? 'unbekannt',
      mode: info.redis_mode ?? 'standalone',
      role: info.role ?? 'unbekannt',
      memoryUsed: Number(info.used_memory ?? 0),
      memoryHuman: info.used_memory_human ?? '—',
      uptimeSeconds: Number(info.uptime_in_seconds ?? 0),
      databaseCount: Number.isFinite(databaseCount) && databaseCount > 0 ? databaseCount : 16,
      modules,
      capabilities,
      persistence: {
        aofEnabled: info.aof_enabled === '1',
        rdbLastSave: Number(info.rdb_last_save_time ?? 0),
        rdbChangesSinceSave: Number(info.rdb_changes_since_last_save ?? 0),
      },
    };
  }

  /** What would happen if this command ran — without running it. */
  inspect(args: string[]): Verdict {
    return judge(args, this.catalogue, this.writesAllowed);
  }

  /**
   * Runs a command through the read/write gate.
   *
   * `confirmed` is how the UI reports that the user answered the dialog for a
   * destructive command. It cannot be defaulted to true anywhere: the point of
   * the flag is that it originates from a click, not from a call site.
   */
  async run(args: string[], options: { confirmed?: boolean } = {}): Promise<WireValue> {
    const verdict = this.inspect(args);
    if (!verdict.allowed) {
      throw new Error(verdict.reason ?? 'Dieser Befehl ist im Lesemodus gesperrt.');
    }
    if (verdict.needsConfirmation && !options.confirmed) {
      throw new Error(verdict.reason ?? 'Dieser Befehl muss bestätigt werden.');
    }
    return this.transport.command(this.id, args);
  }

  /**
   * A read the app issues on its own behalf — listing keys, reading a value,
   * refreshing the server tab. Still gated: everything here is a read, so the
   * gate never rejects it, but routing it through the same check means a new
   * call site cannot quietly become an ungated write.
   */
  async read(args: string[]): Promise<WireValue> {
    const verdict = judge(args, this.catalogue, false);
    if (!verdict.allowed) {
      throw new Error(verdict.reason ?? 'Nur lesende Befehle sind hier erlaubt.');
    }
    return unwrap(await this.transport.command(this.id, args));
  }

  /** Many reads in one round trip. Same gate, applied to each command. */
  async readMany(commands: string[][]): Promise<WireValue[]> {
    for (const args of commands) {
      const verdict = judge(args, this.catalogue, false);
      if (!verdict.allowed) {
        throw new Error(verdict.reason ?? 'Nur lesende Befehle sind hier erlaubt.');
      }
    }
    return this.transport.pipeline(this.id, commands);
  }

  /** Switches the database index this connection reads from. */
  async selectDatabase(index: number): Promise<void> {
    unwrap(await this.transport.command(this.id, ['SELECT', String(index)]));
    this.database = index;
  }

  async close(): Promise<void> {
    await this.transport.close(this.id).catch(() => {
      /* Closing a connection the host already dropped is not an error. */
    });
  }
}
