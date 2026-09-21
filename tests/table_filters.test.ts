import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileTableFilters,
  countActiveTableFilters,
  type TableFilterCondition,
} from '../src/sqlite/services/tableFilters.ts';

test('compiles multiple conditions as parameter-bound AND expressions', () => {
  const filters: TableFilterCondition[] = [
    { id: 'one', column: 'customer_id', operator: 'equals', value: '42' },
    { id: 'two', column: 'name', operator: 'contains', value: '50%_off' },
    { id: 'three', column: 'deleted_at', operator: 'isNull' },
  ];

  const compiled = compileTableFilters(filters, ['customer_id', 'name', 'deleted_at']);

  assert.equal(
    compiled.expression,
    '"customer_id" = ? AND CAST("name" AS TEXT) LIKE ? ESCAPE \'\\\' AND "deleted_at" IS NULL'
  );
  assert.deepEqual(compiled.params, ['42', '%50\\%\\_off%']);
  assert.equal(compiled.activeFilters.length, 3);
});

test('drops incomplete filters and rejects columns outside the metadata whitelist', () => {
  const filters: TableFilterCondition[] = [
    { id: 'blank', column: 'name', operator: 'equals', value: '   ' },
    { id: 'unknown', column: 'name" OR 1=1 --', operator: 'equals', value: 'x' },
    { id: 'valid', column: 'name', operator: 'isNotEmpty' },
  ];

  const compiled = compileTableFilters(filters, ['name']);

  assert.equal(compiled.expression, 'CAST("name" AS TEXT) <> \'\'');
  assert.deepEqual(compiled.params, []);
  assert.equal(countActiveTableFilters(filters, ['name']), 1);
});

test('quotes metadata-backed identifiers and never interpolates values', () => {
  const compiled = compileTableFilters(
    [{ id: 'quote', column: 'odd"column', operator: 'startsWith', value: "x' OR 1=1 --" }],
    ['odd"column']
  );

  assert.equal(compiled.expression, 'CAST("odd""column" AS TEXT) LIKE ? ESCAPE \'\\\'');
  assert.deepEqual(compiled.params, ["x' OR 1=1 --%"]);
  assert.equal(compiled.expression.includes("x' OR 1=1"), false);
});
