import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { DuckDBInstance } from "../tools/data-runtime/node_modules/@duckdb/node-api/lib/index.js";
const dir = process.argv[2];
const instance = await DuckDBInstance.create(join(dir, "measurements.duckdb"));
const connection = await instance.connect();
await connection.run(
  "CREATE TABLE measurements AS SELECT 1 AS id, 'Ada' AS name, 7.5 AS value UNION ALL SELECT 2,'Bob',-3.0",
);
await connection.run(
  `COPY measurements TO '${join(dir, "measurements.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
);
connection.closeSync();
instance.closeSync();
const table = tableFromArrays({
  id: new Int32Array([1, 2]),
  name: ["Ada", "Bob"],
  value: new Float64Array([7.5, -3]),
});
await writeFile(join(dir, "measurements.arrow"), tableToIPC(table, "file"));
