#!/usr/bin/env node
/**
 * Runs the coordination reader over a real folder of records and checks what it
 * made of them.
 *
 * The app's own module is bundled and executed here rather than reimplemented,
 * so this exercises the code that ships. Point it at any project that has a
 * `Coordination/Items` folder:
 *
 *   node tools/coordination/verify.mjs /path/to/project
 *
 * Without an argument it builds a throwaway workspace with the tracker itself,
 * drives it through a claim, a breaking change and a handoff, and asserts the
 * graph that comes out — including the one derived fact the records do not
 * state anywhere: which workstream now stands on an overtaken revision.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : `\n        erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`);
};

/**
 * Bundles part of the app so the test runs the shipped code, not a copy of it.
 *
 * Everything needed goes into *one* bundle on purpose: `graphEngine` is a
 * module-level singleton, and two bundles would each get their own instance —
 * the query engine would then read an empty graph while the test filled the
 * other one.
 */
async function loadBundle(exports, name) {
  const outfile = join(mkdtempSync(join(tmpdir(), 'gs-coord-')), name);
  await build({
    stdin: { contents: exports, resolveDir: root, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}

function readItems(folder) {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name, contents: readFileSync(join(folder, name), 'utf8') }));
}

/**
 * A workspace with the shape the derived checks need: a dependency that has
 * been overtaken, one that has not, an unacknowledged handoff, and a target
 * that a workstream owns and a change touched — the case where two record
 * types have to land on the same target node.
 */
function buildFixture(toolkit) {
  const dir = mkdtempSync(join(tmpdir(), 'gs-fixture-'));
  const tracker = join(dir, 'Coordination/project_tracker.py');
  const run = (...args) => execFileSync('python3', [tracker, ...args], { cwd: dir, encoding: 'utf8' });

  execFileSync(
    'python3',
    [
      join(toolkit, 'scripts/setup_workspace.py'), dir,
      '--mode', 'bootstrap', '--collaboration-mode', 'shared-folder',
      '--actor', 'oskar-claude-mbp', '--initiated-by', 'Oskar', '--agent', 'Claude',
      '--purpose', 'Fixture',
    ],
    { encoding: 'utf8' }
  );

  run('claim', '--work-id', 'ARCH-001', '--title', 'Datenmodell', '--actor', 'oskar-claude-mbp',
      '--owner', 'Oskar', '--agent', 'Claude', '--initiated-by', 'Oskar',
      '--target', 'src/types/graph.ts', '--objective', 'Form festlegen',
      '--acceptance', 'Typen dokumentiert', '--acceptance', 'Beispiel lädt', '--next-action', 'Entwurf');

  run('claim', '--work-id', 'UI-002', '--title', 'Inspektor', '--actor', 'mara-codex-air',
      '--owner', 'Mara', '--agent', 'Codex', '--initiated-by', 'Oskar',
      '--target', 'src/components/NodeInspector.tsx', '--depends-on', 'ARCH-001',
      '--objective', 'Gruppen', '--acceptance', 'Klappt auf', '--next-action', 'Layout');

  // Claimed *after* the change below would make it current; claimed before, its
  // baseline is the revision that the change then overtakes.
  run('change', '--actor', 'oskar-claude-mbp', '--work-id', 'ARCH-001',
      '--summary', 'Kantenrichtung umgedreht', '--changed-target', 'src/types/graph.ts',
      '--change-kind', 'interface', '--impact', 'breaking', '--affects', 'UI-002',
      '--evidence', 'src/types/graph.ts', '--validation', 'npm run typecheck',
      '--next-action', 'Abhängige informieren', '--status', 'in_progress', '--pass-criterion', '1');

  run('handoff', '--actor', 'oskar-claude-mbp', '--work-id', 'ARCH-001',
      '--to-actor', 'mara-codex-air', '--to-owner', 'Mara', '--to-agent', 'Codex',
      '--last-verified', 'Typen kompilieren', '--next-action', 'Beispiel anpassen');

  // Claimed last, so its baseline is ARCH-001's current revision. It has to be
  // claimed after the handoff, not merely after the change: a handoff bumps the
  // revision too, and the schema's staleness rule compares revisions rather
  // than asking what kind of change caused the bump.
  //
  // Its target also has to differ from ARCH-001's — the tracker refuses a
  // second claim on a target someone already owns, which is the point of it.
  run('claim', '--work-id', 'API-003', '--title', 'Schreibpfad', '--actor', 'mara-codex-air',
      '--owner', 'Mara', '--agent', 'Codex', '--initiated-by', 'Oskar',
      '--target', 'src/services/targets/index.ts', '--depends-on', 'ARCH-001',
      '--objective', 'Versionsprüfung', '--acceptance', 'Konflikt erkannt', '--next-action', 'Hash');

  return dir;
}

const main = async () => {
  const { readRecords, buildCoordinationGraph, graphEngine, runQuery } = await loadBundle(
    [
      "export { readRecords, buildCoordinationGraph } from './src/services/coordination/graph';",
      "export { graphEngine } from './src/services/graphEngine';",
      "export { runQuery } from './src/services/query';",
    ].join('\n'),
    'app.mjs'
  );

  const given = process.argv[2];
  const toolkit = process.env.TOOLKIT_PATH;
  let folder;
  let temporary = null;

  if (given) {
    folder = given.endsWith('Coordination/Items') ? given : join(given, 'Coordination/Items');
  } else {
    if (!toolkit) {
      console.error(
        'Ohne Ordner-Argument wird die Fixture mit dem Toolkit gebaut.\n' +
          'Dafür TOOLKIT_PATH auf skills/setup-shared-project-workspace setzen,\n' +
          'oder einen echten Projektordner als Argument übergeben.'
      );
      process.exit(2);
    }
    temporary = buildFixture(toolkit);
    folder = join(temporary, 'Coordination/Items');
  }

  const files = readItems(folder);
  console.log(`\n${files.length} Record-Dateien aus ${folder}\n`);

  const set = readRecords(files);
  const graph = buildCoordinationGraph(set, new Date('2026-09-04T21:30:00Z'));

  const labels = {};
  for (const node of graph.nodes) labels[node.labels[0]] = (labels[node.labels[0]] ?? 0) + 1;
  const types = {};
  for (const edge of graph.edges) types[edge.type] = (types[edge.type] ?? 0) + 1;

  console.log('Knoten:', labels);
  console.log('Kanten:', types);
  if (graph.problems.length > 0) console.log('Hinweise:', graph.problems);
  console.log('');

  if (given) {
    // Against a real project there is no expected answer — the run is a smoke
    // test, and the numbers above are the result.
    check('keine unlesbaren Records', set.problems, []);
    process.exit(failures === 0 ? 0 : 1);
  }

  const workstream = (id) => graph.nodes.find((node) => node.properties.workId === id);
  const dependsOn = (from, to) =>
    graph.edges.find(
      (edge) => edge.type === 'DEPENDS_ON' && edge.from === workstream(from).id && edge.to === workstream(to).id
    );

  console.log('Abgeleitete Aussagen:');
  check('UI-002 hängt an einer überholten Revision', dependsOn('UI-002', 'ARCH-001').properties.state, 'stale');
  check('UI-002 ist als prüfbedürftig markiert', workstream('UI-002').properties.needsReview, true);
  check('API-003 steht auf der aktuellen Revision', dependsOn('API-003', 'ARCH-001').properties.state, 'current');
  check('API-003 braucht keine Prüfung', workstream('API-003').properties.needsReview, false);
  check('ARCH-001 hängt an nichts', workstream('ARCH-001').properties.staleDependencies, 0);

  console.log('\nStruktur:');
  check('drei Workstreams', labels.Workstream, 3);
  check('zwei Akteure', labels.Actor, 2);
  check('ein Handoff', labels.Handoff, 1);
  check('offener Handoff', graph.nodes.find((n) => n.labels[0] === 'Handoff').properties.acknowledged, false);
  check('drei Targets', labels.Target, 3);
  check(
    'Änderung und Workstream teilen den Target-Knoten',
    graph.edges.find((edge) => edge.type === 'CHANGED').to,
    graph.edges.find((edge) => edge.type === 'TOUCHES' && edge.from === workstream('ARCH-001').id).to
  );
  check('die breaking-Änderung nennt UI-002', types.AFFECTS, 1);
  check('keine Hinweise', graph.problems, []);

  // The point of drawing the records is that the app's own query language can
  // then walk them. Asking it here proves that claim against the real engine,
  // which a screenshot of the canvas would not.
  console.log('\nAbfragen über die Engine der App:');
  graphEngine.load(
    {
      version: 1,
      metadata: { name: 'fixture', createdAt: '', updatedAt: '', sources: [] },
      nodes: graph.nodes,
      edges: graph.edges,
    },
    'fixture'
  );

  const rows = (source) => runQuery(source).rows;
  check(
    'überholte Workstreams sind abfragbar',
    rows('MATCH (w:Workstream) WHERE w.needsReview = true RETURN w.workId, w.owner'),
    [['UI-002', 'Mara']]
  );
  check(
    'die betroffenen Abhängigkeiten einer breaking-Änderung',
    rows("MATCH (c:Change)-[:AFFECTS]->(w) WHERE c.impact = 'breaking' RETURN w.workId, w.status"),
    [['UI-002', 'claimed']]
  );
  check(
    'was ein Akteur gerade besitzt',
    rows("MATCH (a:Actor)-[:OWNS]->(w) WHERE a.human = 'Mara' RETURN w.workId ORDER BY w.workId"),
    [['API-003'], ['ARCH-001'], ['UI-002']]
  );
  check(
    'offene Übergaben',
    rows('MATCH (h:Handoff) WHERE h.acknowledged = false RETURN h.workId, h.toActor'),
    [['ARCH-001', 'MARA-CODEX-AIR']]
  );

  console.log('\nFehlertoleranz:');
  const broken = readRecords([
    { name: 'WORK-KAPUTT.md', contents: 'kein frontmatter' },
    { name: 'WORK-OHNE-TYP.md', contents: '---\ntitle: "x"\n---\n' },
    ...files,
  ]);
  check('zwei defekte Dateien gemeldet', broken.problems.length, 2);
  check('die übrigen Records bleiben lesbar', broken.work.length, set.work.length);

  if (temporary) rmSync(temporary, { recursive: true, force: true });

  console.log(failures === 0 ? '\nAlles bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
