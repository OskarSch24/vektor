import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseGraphExchange } from '../src/services/graphFormats';
import { gunzip } from '../src/sqlite/services/importers/compression';
import { detectFormat, importTables } from '../src/sqlite/services/importers';
import { fileTypeForName, workspaceFor } from '../src/workbench/model';

test('new formats route to the right workspace', () => {
  const cases: Array<[string, string, string]> = [
    ['alt.xls', 'excel', 'table'],
    ['libre.ods', 'excel', 'table'],
    ['apple.numbers', 'excel', 'table'],
    ['daten.csv.gz', 'csv', 'table'],
    ['log.jsonl.gz', 'json-table', 'table'],
    ['werte.json.gz', 'json-table', 'table'],
    ['netz.graphml', 'graph', 'graph'],
    ['gephi.gexf', 'graph', 'graph'],
    ['plan.dot', 'graph', 'graph'],
    ['plan.gv', 'graph', 'graph'],
  ];
  for (const [name, fileType, workspace] of cases) {
    assert.equal(fileTypeForName(name), fileType, name);
    assert.equal(workspaceFor({ name, fileType: fileTypeForName(name) }), workspace, name);
  }
  assert.equal(detectFormat('daten.csv.gz'), 'csv');
  assert.equal(detectFormat('alt.xls'), 'xlsx');
});

test('GraphML with Neo4j-style labels and typed keys', () => {
  const doc = parseGraphExchange(`<?xml version="1.0"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="l" for="node" attr.name="labels" attr.type="string"/>
  <key id="n" for="node" attr.name="name" attr.type="string"/>
  <key id="a" for="node" attr.name="alter" attr.type="int"/>
  <key id="t" for="edge" attr.name="label" attr.type="string"/>
  <graph edgedefault="directed">
    <node id="p1"><data key="l">:Person:Autor</data><data key="n">Ada</data><data key="a">36</data></node>
    <node id="b1"><data key="n">Notizen</data></node>
    <edge id="e1" source="p1" target="b1"><data key="t">hat geschrieben</data></edge>
  </graph>
</graphml>`, 'netz.graphml');
  assert.equal(doc.nodes.length, 2);
  const ada = doc.nodes.find((node) => node.id === 'p1')!;
  assert.deepEqual(ada.labels, ['Person', 'Autor']);
  assert.equal(ada.properties.alter, 36);
  assert.equal(doc.edges[0].type, 'HAT_GESCHRIEBEN');
  assert.equal(doc.metadata.name, 'netz');
});

test('GEXF with attributes and weights', () => {
  const doc = parseGraphExchange(`<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.3" version="1.3">
  <graph defaultedgetype="undirected">
    <attributes class="node"><attribute id="0" title="type" type="string"/><attribute id="1" title="score" type="float"/></attributes>
    <nodes>
      <node id="a" label="Alpha"><attvalues><attvalue for="0" value="Stadt"/><attvalue for="1" value="0.5"/></attvalues></node>
      <node id="b" label="Beta"/>
    </nodes>
    <edges><edge id="0" source="a" target="b" weight="2.5"/></edges>
  </graph>
</gexf>`, 'gephi.gexf');
  const alpha = doc.nodes.find((node) => node.id === 'a')!;
  assert.deepEqual(alpha.labels, ['Stadt']);
  assert.equal(alpha.properties.name, 'Alpha');
  assert.equal(alpha.properties.score, 0.5);
  assert.equal(doc.edges[0].properties.gewicht, 2.5);
  assert.equal(doc.edges[0].properties.gerichtet, false);
});

test('Graphviz DOT with chains, groups, attributes and comments', () => {
  const doc = parseGraphExchange(`// Ablauf
digraph Ablauf {
  rankdir = LR;
  node [shape=box];
  start [label="Start", type=Schritt];
  start -> pruefen -> { ok fehler } [label="führt zu"];
  /* Unterbau */
  subgraph cluster_a { ok; "mit Leerzeichen" }
  "mit Leerzeichen" -> start:n;
}`, 'plan.dot');
  const ids = doc.nodes.map((node) => node.id).sort();
  assert.deepEqual(ids, ['fehler', 'mit Leerzeichen', 'ok', 'pruefen', 'start']);
  assert.deepEqual(doc.nodes.find((node) => node.id === 'start')!.labels, ['Schritt']);
  assert.equal(doc.nodes.find((node) => node.id === 'start')!.properties.name, 'Start');
  assert.equal(doc.edges.length, 4);
  assert.ok(doc.edges.some((edge) => edge.from === 'pruefen' && edge.to === 'fehler' && edge.type === 'FUHRT_ZU'));
});

test('broken graph files fail with a readable message', () => {
  assert.throws(() => parseGraphExchange('digraph { a -> ', 'kaputt.dot'), /kaputt\.dot/);
  assert.throws(() => parseGraphExchange('<graphml><graph>', 'kaputt.graphml'), /kaputt\.graphml/);
});

for (const bookType of ['xls', 'ods'] as const) {
  test(`${bookType} workbooks import every sheet`, async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Betrag'], ['Ada', 12.5], ['Linus', 3]]), 'Kunden');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Stadt'], ['Hamburg']]), 'Orte');
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType }));
    const tables = await importTables(bytes, `test.${bookType}`, 'xlsx');
    assert.deepEqual(tables.map((table) => table.name), ['Kunden', 'Orte']);
    assert.equal(tables[0].rows.length, 2);
    assert.equal(tables[0].columns.find((column) => column.name === 'Betrag')?.type, 'REAL');
  });
}

test('gzip files unpack before import', async () => {
  const csv = 'id,name\n1,Ada\n2,Linus\n';
  const packed = new Uint8Array(await new Response(
    new Blob([csv]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer());
  const unpacked = await gunzip(packed, 'daten.csv.gz');
  assert.equal(new TextDecoder().decode(unpacked), csv);
  const tables = await importTables(unpacked, 'daten.csv', 'csv');
  assert.equal(tables[0].rows.length, 2);
  await assert.rejects(gunzip(new TextEncoder().encode(csv), 'falsch.csv.gz'), /keine gzip-Datei/);
});
