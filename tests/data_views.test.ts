import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSourceDocument,
  documentTables,
} from "../src/sqlite/services/importers/documents";
import { importColumnar } from "../src/sqlite/services/importers/columnar";
import {
  compareDatasets,
  cosine,
  dateValue,
  histogram,
  pivot,
  profile,
  vectorValue,
} from "../src/sqlite/services/dataViews";
import { tableFromArrays, tableToIPC } from "apache-arrow";

const bytes = (text: string) => new TextEncoder().encode(text);
test("structured formats preserve nested values and their original source", () => {
  const fixtures = [
    [
      "nested.json",
      '{"person":{"name":"Ada","flags":[true,null,"001"]},"empty":{}}',
    ],
    [
      "nested.yaml",
      'person:\n  name: Ada\n  flags: [true, null, "001"]\nempty: {}',
    ],
    ["nested.toml", '[person]\nname = "Ada"\nflags = [true, "001"]'],
    ["nested.xml", '<root><person id="001"><name>Ada</name></person></root>'],
  ];
  for (const [filename, text] of fixtures) {
    const doc = parseSourceDocument(bytes(text), filename)!;
    assert.equal(doc.text, text);
    assert.ok(doc.value);
    assert.ok(documentTables(doc, filename).length);
  }
  const doc = parseSourceDocument(bytes(fixtures[0][1]), "nested.json")!;
  assert.deepEqual((doc.value as any).person.flags, [true, null, "001"]);
});
test("empty objects, arrays and scalar JSON open as valid tables", () => {
  for (const text of ["{}", "[]", "[{}]", "null", "false", "42", '"text"']) {
    const doc = parseSourceDocument(bytes(text), "empty.json")!;
    const tables = documentTables(doc, "empty.json");
    assert.ok(tables.every((table) => table.columns.length > 0));
  }
});
test("XML opens with SYSTEM and PUBLIC DTD references while preserving its source", () => {
  for (const declaration of [
    '<!DOCTYPE DOCUMENT SYSTEM "MDB_STAMMDATEN.DTD">',
    '<!DOCTYPE DOCUMENT PUBLIC "-//Example//DTD Document//EN" "https://invalid.example/document.dtd">',
  ]) {
    const text = `<?xml version="1.0"?>${declaration}<DOCUMENT><MDB><ID>001</ID></MDB><MDB><ID>002</ID></MDB></DOCUMENT>`;
    const doc = parseSourceDocument(bytes(text), "MDB_STAMMDATEN.XML")!;
    assert.equal(doc.text, text);
    assert.deepEqual((doc.value as any).DOCUMENT.MDB, [{ ID: "001" }, { ID: "002" }]);
    assert.ok(documentTables(doc, "MDB_STAMMDATEN.XML").length);
  }
});
test("XML declaration-like text in comments and CDATA is document content", () => {
  const doc = parseSourceDocument(bytes('<root><!-- <!DOCTYPE example> --><text><![CDATA[<!ENTITY example>]]></text></root>'), "content.xml")!;
  assert.equal((doc.value as any).root.text, "<!ENTITY example>");
});
test("bad syntax, duplicate YAML keys and external XML entities fail visibly", () => {
  assert.throws(() => parseSourceDocument(bytes("{invalid"), "bad.json"));
  assert.throws(() => parseSourceDocument(bytes("a: 1\na: 2"), "bad.yaml"));
  assert.throws(() => parseSourceDocument(bytes("<a><b></a>"), "bad.xml"));
  assert.throws(() =>
    parseSourceDocument(
      bytes('<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><r>&e;</r>'),
      "bad.xml",
    ),
  );
});
test("histogram counts signed values and ignores absent numbers", () => {
  const bins = histogram([-10, -10, 0, 10, null, "", false, "bad"], 2);
  assert.deepEqual(
    bins.map((bin) => bin.count),
    [2, 2],
  );
  assert.equal(histogram([5, 5, 5])[0].count, 3);
});
test("pivot averages use valid values only and keep missing groups", () => {
  const result = pivot(
    [
      ["A", "x", 2],
      ["A", "x", null],
      ["A", "x", 6],
      [null, "y", 4],
    ],
    0,
    1,
    2,
    "avg",
  );
  assert.equal(result.rows[0].values[0], 4);
  assert.equal(result.rows[1].group, "NULL");
});
test("comparison matches by identity despite reordered rows and columns", () => {
  const before = {
    columns: ["id", "value"],
    values: [
      [1, "A"],
      [2, null],
      [3, "gone"],
    ],
    totalCount: 3,
  };
  const after = {
    columns: ["value", "id"],
    values: [
      ["A", 1],
      ["new", 2],
      ["added", 4],
    ],
    totalCount: 3,
  };
  assert.deepEqual(
    compareDatasets(before, after, "id").map((row) => row.status),
    ["Geändert", "Gelöscht", "Neu"],
  );
  assert.throws(
    () =>
      compareDatasets(
        before,
        {
          ...after,
          values: [
            ["A", 1],
            ["B", 1],
          ],
        },
        "id",
      ),
    /eindeutig/,
  );
  assert.throws(
    () => compareDatasets(before, { ...after, columns: ["other"] }, "id"),
    /fehlt/,
  );
});
test("quality, dates and vectors do not silently turn missing values into zero", () => {
  assert.equal(
    profile({
      columns: ["v"],
      values: [[null], [""], [1], [1], [2]],
      totalCount: 5,
    })[0].missing,
    2,
  );
  assert.equal(dateValue("123"), null);
  assert.equal(dateValue("2026-02-30"), null);
  assert.equal(dateValue(1e30), null);
  assert.equal(
    dateValue("2026-09-13")?.toISOString(),
    "2026-09-13T00:00:00.000Z",
  );
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([0, 0], [1, 0]), null);
  assert.equal(cosine([1], [1, 2]), null);
  assert.deepEqual(vectorValue("[1, 2, 3]"), [1, 2, 3]);
  assert.equal(vectorValue('[1, "x"]'), null);
});
test("Arrow IPC streams and files open with accurate values", async () => {
  const table = tableFromArrays({
    name: ["Ada", "Bob"],
    value: new Int32Array([7, -3]),
  });
  for (const mode of ["stream", "file"] as const) {
    const result = await importColumnar(
      tableToIPC(table, mode),
      "source.arrow",
      "arrow",
    );
    assert.deepEqual(result[0].rows, [
      ["Ada", 7],
      ["Bob", -3],
    ]);
  }
});
test("compressed Parquet and a real DuckDB file open without modifying the source", async () => {
  const { DuckDBInstance } =
    await import("../tools/data-runtime/node_modules/@duckdb/node-api/lib/index.js");
  const { readSource } = await import("../tools/data-runtime/runtime.mjs");
  const dir = await mkdtemp(join(tmpdir(), "vektor-formats-"));
  try {
    const path = join(dir, "source.duckdb");
    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();
    await connection.run(
      "CREATE TABLE measurements (id INTEGER, name VARCHAR, value DOUBLE); INSERT INTO measurements VALUES (1,'Ada',7.5),(2,'Bob',-3.0); CREATE TABLE empty_table(id INTEGER)",
    );
    await connection.run(
      `COPY measurements TO '${join(dir, "source.parquet")}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    await connection.run(`COPY empty_table TO '${join(dir, "empty.parquet")}' (FORMAT PARQUET)`);
    connection.closeSync();
    instance.closeSync();
    const before = await readFile(path);
    const result = await readSource({
      format: "duckdb",
      path,
      config: { limit: 1 },
    });
    assert.equal(
      result.tables.find((t: any) => t.name === "main.measurements").truncated,
      true,
    );
    assert.deepEqual(
      result.tables.find((t: any) => t.name === "main.empty_table").columns,
      ["id"],
    );
    assert.deepEqual(await readFile(path), before);
    const parquet = await importColumnar(
      await readFile(join(dir, "source.parquet")),
      "source.parquet",
      "parquet",
    );
    const empty = await importColumnar(await readFile(join(dir, "empty.parquet")), "empty.parquet", "parquet");
    assert.deepEqual(empty[0].columns.map(c => c.name), ["id"]);
    assert.deepEqual(parquet[0].rows, [
      [1, "Ada", 7.5],
      [2, "Bob", -3],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pivot bounds a matrix with many unique keys before allocating cells", () => {
  const result = pivot(Array.from({length:2000},(_,i)=>[String(i),String(i),1]),0,1,2,"sum");
  assert.equal(result.totalGroups,2000);
  assert.equal(result.totalCategories,2000);
  assert.ok(result.rows.length<=500);
  assert.ok(result.categories.length<=100);
});
