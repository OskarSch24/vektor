import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quote = (name) => '"' + String(name).replaceAll('"', '""') + '"';
const mysqlQuote = (name) => "`" + String(name).replaceAll("`", "``") + "`";
const clean = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)),
  );

/** Only fixed, quoted SELECTs are issued. Credentials never reach logs or disk. */
export async function readSource(params) {
  const config = params.config ?? {};
  const limit = Math.min(
    100000,
    Math.max(1, Number.isInteger(config.limit) ? config.limit : 10000),
  );
  const tables = [];
  let omitted = 0;
  const add = (name, rows, columns) => {
    tables.push({
      name,
      records: clean(rows.slice(0, limit)),
      columns,
      truncated: rows.length > limit,
    });
  };
  const selectTables = (entries) => {
    const selected = config.tables
      ? entries.filter((entry) => config.tables.includes(entry.name))
      : entries;
    omitted = Math.max(0, selected.length - 50);
    return selected.slice(0, 50);
  };
  const password = config.passwordEnv
    ? process.env[config.passwordEnv]
    : config.password;
  if (config.passwordEnv && password === undefined)
    throw new Error(
      `Umgebungsvariable ${config.passwordEnv} ist nicht gesetzt.`,
    );
  if (params.format === "duckdb") {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const temp = await mkdtemp(join(tmpdir(), "vektor-duckdb-"));
    let instance, connection;
    try {
      const path = params.path || join(temp, "source.duckdb");
      if (!params.path) {
        if (!params.base64) throw new Error("DuckDB-Datei fehlt.");
        await writeFile(path, Buffer.from(params.base64, "base64"), {
          mode: 0o600,
        });
      }
      instance = await DuckDBInstance.create(path, {
        access_mode: "READ_ONLY",
        enable_external_access: "false",
        threads: "2",
      });
      connection = await instance.connect();
      const catalog = (
        await connection.runAndReadAll(
          "SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog') ORDER BY table_schema, table_name",
        )
      ).getRowObjectsJson();
      for (const entry of selectTables(catalog)) {
        const reader = await connection.runAndReadAll(
          `SELECT * FROM ${quote(entry.schema)}.${quote(entry.name)} LIMIT ${limit + 1}`,
        );
        add(
          `${entry.schema}.${entry.name}`,
          reader.getRowObjectsJson(),
          reader.columnNames(),
        );
      }
    } finally {
      connection?.closeSync();
      instance?.closeSync();
      await rm(temp, { recursive: true, force: true });
    }
  } else if (
    config.provider === "postgresql" ||
    config.provider === "postgres"
  ) {
    const { Client } = await import("pg");
    const client = new Client({
      host: config.host || "localhost",
      port: config.port || 5432,
      database: config.database,
      user: config.user,
      password,
      ssl: config.tls ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
      query_timeout: 20000,
    });
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      const catalog = await client.query(
        "SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog') ORDER BY table_schema, table_name",
      );
      for (const entry of selectTables(catalog.rows)) {
        const result = await client.query(
          `SELECT * FROM ${quote(entry.schema)}.${quote(entry.name)} LIMIT $1`,
          [limit + 1],
        );
        add(
          `${entry.schema}.${entry.name}`,
          result.rows,
          result.fields.map((field) => field.name),
        );
      }
      await client.query("ROLLBACK");
    } finally {
      await client.end().catch(() => {});
    }
  } else if (config.provider === "mysql" || config.provider === "mariadb") {
    const { createConnection } = await import("mysql2/promise");
    const client = await createConnection({
      host: config.host || "localhost",
      port: config.port || 3306,
      database: config.database,
      user: config.user,
      password,
      ssl: config.tls ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      multipleStatements: false,
    });
    try {
      await client.query({
        sql: "START TRANSACTION READ ONLY",
        timeout: 15000,
      });
      const [catalog] = await client.query({
        sql: "SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
        timeout: 15000,
      });
      for (const entry of selectTables(catalog)) {
        const [rows, fields] = await client.query({
          sql: `SELECT * FROM ${mysqlQuote(entry.db)}.${mysqlQuote(entry.name)} LIMIT ${limit + 1}`,
          timeout: 15000,
        });
        add(
          entry.name,
          rows,
          fields.map((field) => field.name),
        );
      }
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  } else if (config.provider === "mongodb") {
    const { MongoClient, BSON } = await import("mongodb");
    const uri =
      config.uri ||
      `mongodb://${config.host || "localhost"}:${config.port || 27017}`;
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri))
      throw new Error("Ungültige MongoDB-Adresse.");
    const client = new MongoClient(uri, {
      ...(config.user
        ? { auth: { username: config.user, password: password || "" } }
        : {}),
      ...(config.tls ? { tls: true } : {}),
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 20000,
      maxPoolSize: 1,
    });
    try {
      await client.connect();
      const db = client.db(config.database);
      const catalog = await db
        .listCollections({}, { nameOnly: true })
        .toArray();
      for (const entry of selectTables(catalog)) {
        const rows = await db
          .collection(entry.name)
          .find({})
          .limit(limit + 1)
          .maxTimeMS(15000)
          .toArray();
        add(
          entry.name,
          rows.map((row) =>
            JSON.parse(BSON.EJSON.stringify(row, { relaxed: false })),
          ),
        );
      }
    } finally {
      await client.close();
    }
  } else
    throw new Error(
      "provider muss postgresql, mysql, mariadb oder mongodb sein.",
    );
  return { tables, limit, omitted, readAt: new Date().toISOString() };
}
