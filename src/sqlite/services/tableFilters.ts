import type { SqlValue } from 'sql.js';
import { escapeLikeTerm, quoteIdent } from '../lib/sql.ts';
import type { TablePage, TablePageOptions } from './dbEngine.ts';

export type TableFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'isNull'
  | 'isNotNull'
  | 'isEmpty'
  | 'isNotEmpty';

export interface TableFilterCondition {
  /** Stable UI identity. It is deliberately ignored by the SQL compiler. */
  id: string;
  column: string;
  operator: TableFilterOperator;
  value?: SqlValue;
}

/**
 * Drop-in extension for DBEngine.TablePageOptions. The search term is combined
 * with every active filter via AND; individual filters are ANDed as well.
 */
export interface FilteredTablePageOptions extends TablePageOptions {
  filters?: TableFilterCondition[];
  filterLogic?: 'AND';
}

/**
 * Injection point used by DataBrowser. Keeping this callback independent of
 * DBEngine makes the UI backwards compatible while the engine can add native,
 * parameter-bound filtering without coupling the component to SQL internals.
 */
export type TablePageLoader = (
  tableName: string,
  options: FilteredTablePageOptions
) => TablePage | Promise<TablePage>;

export interface CompiledTableFilters {
  /** SQL expression without the leading WHERE keyword. */
  expression: string;
  /** Values in placeholder order. These must be passed to a prepared statement. */
  params: SqlValue[];
  /** Only complete, whitelisted filters contribute to the expression. */
  activeFilters: TableFilterCondition[];
}

export const FILTER_OPERATORS: ReadonlyArray<{
  value: TableFilterOperator;
  label: string;
  needsValue: boolean;
}> = [
  { value: 'equals', label: 'ist gleich', needsValue: true },
  { value: 'notEquals', label: 'ist nicht gleich', needsValue: true },
  { value: 'contains', label: 'enthält', needsValue: true },
  { value: 'notContains', label: 'enthält nicht', needsValue: true },
  { value: 'startsWith', label: 'beginnt mit', needsValue: true },
  { value: 'endsWith', label: 'endet mit', needsValue: true },
  { value: 'greaterThan', label: 'ist größer als', needsValue: true },
  { value: 'greaterThanOrEqual', label: 'ist mindestens', needsValue: true },
  { value: 'lessThan', label: 'ist kleiner als', needsValue: true },
  { value: 'lessThanOrEqual', label: 'ist höchstens', needsValue: true },
  { value: 'isNull', label: 'ist NULL', needsValue: false },
  { value: 'isNotNull', label: 'ist nicht NULL', needsValue: false },
  { value: 'isEmpty', label: 'ist leer', needsValue: false },
  { value: 'isNotEmpty', label: 'ist nicht leer', needsValue: false },
];

const VALUELESS_OPERATORS = new Set<TableFilterOperator>([
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
]);

export function filterOperatorNeedsValue(operator: TableFilterOperator): boolean {
  return !VALUELESS_OPERATORS.has(operator);
}

export function isCompleteTableFilter(
  filter: TableFilterCondition,
  availableColumns?: readonly string[]
): boolean {
  if (!filter.column || (availableColumns && !availableColumns.includes(filter.column))) {
    return false;
  }
  if (!filterOperatorNeedsValue(filter.operator)) return true;
  if (filter.value === null || filter.value === undefined) return false;
  return typeof filter.value !== 'string' || filter.value.trim().length > 0;
}

export function countActiveTableFilters(
  filters: readonly TableFilterCondition[],
  availableColumns?: readonly string[]
): number {
  return filters.filter((filter) => isCompleteTableFilter(filter, availableColumns)).length;
}

/**
 * Builds a safe, parameterised filter expression for DBEngine integration.
 * Column identifiers are accepted only from the supplied metadata whitelist;
 * user values never become part of the SQL string.
 */
export function compileTableFilters(
  filters: readonly TableFilterCondition[],
  availableColumns: readonly string[]
): CompiledTableFilters {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  const activeFilters: TableFilterCondition[] = [];

  for (const filter of filters) {
    if (!isCompleteTableFilter(filter, availableColumns)) continue;

    const column = quoteIdent(filter.column);
    const value = filter.value as SqlValue;
    let condition = '';

    switch (filter.operator) {
      case 'equals':
        condition = `${column} = ?`;
        params.push(value);
        break;
      case 'notEquals':
        condition = `${column} <> ?`;
        params.push(value);
        break;
      case 'contains':
        condition = `CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`;
        params.push(`%${escapeLikeTerm(String(value))}%`);
        break;
      case 'notContains':
        condition = `CAST(${column} AS TEXT) NOT LIKE ? ESCAPE '\\'`;
        params.push(`%${escapeLikeTerm(String(value))}%`);
        break;
      case 'startsWith':
        condition = `CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`;
        params.push(`${escapeLikeTerm(String(value))}%`);
        break;
      case 'endsWith':
        condition = `CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`;
        params.push(`%${escapeLikeTerm(String(value))}`);
        break;
      case 'greaterThan':
        condition = `${column} > ?`;
        params.push(value);
        break;
      case 'greaterThanOrEqual':
        condition = `${column} >= ?`;
        params.push(value);
        break;
      case 'lessThan':
        condition = `${column} < ?`;
        params.push(value);
        break;
      case 'lessThanOrEqual':
        condition = `${column} <= ?`;
        params.push(value);
        break;
      case 'isNull':
        condition = `${column} IS NULL`;
        break;
      case 'isNotNull':
        condition = `${column} IS NOT NULL`;
        break;
      case 'isEmpty':
        condition = `CAST(${column} AS TEXT) = ''`;
        break;
      case 'isNotEmpty':
        condition = `CAST(${column} AS TEXT) <> ''`;
        break;
    }

    conditions.push(condition);
    activeFilters.push(filter);
  }

  return {
    expression: conditions.join(' AND '),
    params,
    activeFilters,
  };
}
