import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeImportedTables,
  unionColumns,
  type MergeTableSource,
} from '../src/sqlite/services/importers/mergeTables.ts';

function sources(): MergeTableSource[] {
  return [
    {
      filename: 'ag_01.json',
      table: {
        name: 'ag_01',
        columns: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'TEXT' },
        ],
        rows: [
          [1, 'Ada'],
          [2, 'Bob'],
        ],
      },
    },
    {
      filename: 'ag_02.csv',
      table: {
        name: 'ag_02',
        columns: [
          { name: 'ID', type: 'REAL' },
          { name: 'status', type: 'TEXT' },
        ],
        rows: [
          [2, 'aktiv'],
          [3.5, 'offen'],
        ],
      },
    },
  ];
}

test('unions columns in first-seen order and promotes compatible number types', () => {
  assert.deepEqual(unionColumns(sources()), [
    { name: 'id', type: 'REAL' },
    { name: 'name', type: 'TEXT' },
    { name: 'status', type: 'TEXT' },
  ]);
});

test('projects ragged source schemas onto the union and pads absent cells', () => {
  const result = mergeImportedTables(sources(), { targetName: 'Alle AGs.sqlite' });

  assert.equal(result.tables[0].name, 'Alle_AGs');
  assert.deepEqual(result.tables[0].rows, [
    [1, 'Ada', null],
    [2, 'Bob', null],
    [2, null, 'aktiv'],
    [3.5, null, 'offen'],
  ]);
  assert.equal(result.inputRows, 4);
  assert.equal(result.outputRows, 4);
  assert.equal(result.sourceFiles, 2);
});

test('removes duplicates by selected columns while retaining the first row', () => {
  const result = mergeImportedTables(sources(), {
    targetName: 'AG',
    deduplicateBy: ['ID'],
  });

  assert.deepEqual(result.tables[0].rows, [
    [1, 'Ada', null],
    [2, 'Bob', null],
    [3.5, null, 'offen'],
  ]);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.outputRows, 3);
});

test('promotes conflicting values to text without losing numeric data', () => {
  const input: MergeTableSource[] = [
    {
      filename: 'one.csv',
      table: {
        name: 'one',
        columns: [{ name: 'code', type: 'INTEGER' }],
        rows: [[42]],
      },
    },
    {
      filename: 'two.csv',
      table: {
        name: 'two',
        columns: [{ name: 'code', type: 'TEXT' }],
        rows: [['A-42']],
      },
    },
  ];

  const result = mergeImportedTables(input, { targetName: 'codes' });
  assert.deepEqual(result.tables[0].columns, [{ name: 'code', type: 'TEXT' }]);
  assert.deepEqual(result.tables[0].rows, [['42'], ['A-42']]);
});

test('rejects an unknown duplicate key instead of silently keeping bad results', () => {
  assert.throws(
    () => mergeImportedTables(sources(), { targetName: 'AG', deduplicateBy: ['missing'] }),
    /nicht im gemeinsamen Schema/
  );
});

