import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { readSource } from "../tools/data-runtime/runtime.mjs";

test("PostgreSQL: real connection, quoted identifiers, empty schemas, precision, limit and no writes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vektor-postgres-"));
  const data = join(folder, "data");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  let started = false;
  try {
    execFileSync(
      "/opt/homebrew/bin/initdb",
      [
        "-D",
        data,
        "--username=vektor_test",
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "/opt/homebrew/bin/pg_ctl",
      [
        "-D",
        data,
        "-l",
        join(folder, "server.log"),
        "-o",
        `-p ${port} -h 127.0.0.1 -k ${folder}`,
        "-w",
        "start",
      ],
      { stdio: "pipe" },
    );
    started = true;
    const sql =
      'CREATE TABLE "odd""table" (id INTEGER, value BIGINT); INSERT INTO "odd""table" VALUES (1,9223372036854775807),(2,-3); CREATE TABLE empty_table (id INTEGER, name TEXT);';
    execFileSync(
      "/opt/homebrew/bin/psql",
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "vektor_test",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { stdio: "pipe" },
    );
    const result = await readSource({
      format: "connection",
      config: {
        provider: "postgresql",
        host: "127.0.0.1",
        port,
        user: "vektor_test",
        database: "postgres",
        limit: 1,
      },
    });
    const table = result.tables.find((t) => t.name === 'public.odd"table');
    assert.equal(table.records[0].value, "9223372036854775807");
    assert.equal(table.truncated, true);
    assert.deepEqual(
      result.tables.find((t) => t.name === "public.empty_table").columns,
      ["id", "name"],
    );
    const count = execFileSync(
      "/opt/homebrew/bin/psql",
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "vektor_test",
        "-d",
        "postgres",
        "-Atc",
        'SELECT COUNT(*) FROM "odd""table"',
      ],
      { encoding: "utf8" },
    );
    assert.equal(count.trim(), "2");
  } finally {
    if (started)
      execFileSync(
        "/opt/homebrew/bin/pg_ctl",
        ["-D", data, "-m", "fast", "-w", "stop"],
        { stdio: "pipe" },
      );
    await rm(folder, { recursive: true, force: true });
  }
});
