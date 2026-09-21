import React from 'react';
import type { SqlValue } from 'sql.js';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  KeyRound,
  Link2,
  Maximize2,
} from 'lucide-react';
import type { ForeignKey, TableColumn } from '../types/sqlite';
import { CellValue } from './CellValue';
import type { GridSort } from './DataGrid';

export interface ForeignKeyNavigationTarget {
  table: string;
  column: string;
  value: SqlValue;
}

interface RelationalDataGridProps {
  columns: string[];
  rows: SqlValue[][];
  rowOffset?: number;
  columnMeta?: (column: string) => TableColumn | undefined;
  foreignKeyMeta?: (column: string) => ForeignKey | undefined;
  sort?: GridSort;
  onInspect?: (cell: { column: string; value: SqlValue; rowIndex: number }) => void;
  onNavigateForeignKey?: (target: ForeignKeyNavigationTarget) => void;
}

const headerCell =
  'px-3 py-2 font-medium text-apple-text-secondary border-r border-white/[0.06] whitespace-nowrap';

/** Data grid variant that makes metadata-backed foreign-key cells navigable. */
export const RelationalDataGrid: React.FC<RelationalDataGridProps> = ({
  columns,
  rows,
  rowOffset = 0,
  columnMeta,
  foreignKeyMeta,
  sort,
  onInspect,
  onNavigateForeignKey,
}) => (
  <table className="w-full border-collapse text-left text-xs">
    <thead className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#141722]/95 shadow-sm backdrop-blur-md select-none">
      <tr>
        <th className="w-12 border-r border-white/[0.06] bg-[#11131C] px-3 py-2 text-center font-mono text-[10px] font-medium text-apple-text-tertiary">
          #
        </th>
        {columns.map((column, index) => {
          const meta = columnMeta?.(column);
          const foreignKey = foreignKeyMeta?.(column);
          const isSorted = sort?.by === column;
          return (
            <th
              key={`${column}-${index}`}
              scope="col"
              aria-sort={
                isSorted ? (sort?.order === 'ASC' ? 'ascending' : 'descending') : undefined
              }
              onClick={sort ? () => sort.onSort(column) : undefined}
              className={`${headerCell} ${
                sort ? 'group cursor-pointer transition-colors hover:bg-white/[0.04]' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {meta?.pk === 1 && (
                    <KeyRound
                      aria-label="Primärschlüssel"
                      className="h-3 w-3 shrink-0 text-apple-amber"
                    />
                  )}
                  {foreignKey && (
                    <Link2
                      aria-label={`Fremdschlüssel zu ${foreignKey.table}.${foreignKey.to}`}
                      className="h-3 w-3 shrink-0 text-apple-blue"
                    />
                  )}
                  <span className="truncate font-semibold text-white">{column}</span>
                  {meta?.type && (
                    <span className="shrink-0 rounded bg-white/[0.06] px-1 font-mono text-[9px] text-apple-text-tertiary">
                      {meta.type}
                    </span>
                  )}
                </div>

                {sort && (
                  <span className="shrink-0 text-apple-text-muted">
                    {isSorted ? (
                      sort.order === 'ASC' ? (
                        <ArrowUp className="h-3 w-3 text-apple-blue" />
                      ) : (
                        <ArrowDown className="h-3 w-3 text-apple-blue" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                    )}
                  </span>
                )}
              </div>
            </th>
          );
        })}
      </tr>
    </thead>

    <tbody className="divide-y divide-white/[0.04]">
      {rows.map((row, rowIndex) => (
        <tr key={rowIndex} className="transition-colors hover:bg-white/[0.03]">
          <td className="border-r border-white/[0.04] bg-[#0E1018]/50 px-3 py-2 text-center font-mono text-[10px] text-apple-text-tertiary select-none">
            {rowOffset + rowIndex + 1}
          </td>

          {row.map((value, columnIndex) => {
            const column = columns[columnIndex] ?? `col_${columnIndex}`;
            const foreignKey = foreignKeyMeta?.(column);
            const canNavigate = Boolean(foreignKey && value !== null && onNavigateForeignKey);
            const inspectCell = () =>
              onInspect?.({ column, value, rowIndex: rowOffset + rowIndex });

            return (
              <td
                key={columnIndex}
                onClick={canNavigate ? undefined : onInspect ? inspectCell : undefined}
                className={`max-w-xs whitespace-nowrap border-r border-white/[0.04] px-3 py-2 text-apple-text-primary select-text ${
                  !canNavigate && onInspect
                    ? 'group/cell cursor-pointer transition-colors hover:bg-apple-blue/[0.08]'
                    : ''
                }`}
              >
                {canNavigate && foreignKey ? (
                  <button
                    type="button"
                    onClick={() =>
                      onNavigateForeignKey?.({
                        table: foreignKey.table,
                        column: foreignKey.to,
                        value,
                      })
                    }
                    title={`Öffne ${foreignKey.table}.${foreignKey.to}`}
                    className="group/link flex w-full items-center justify-between gap-2 overflow-hidden text-left text-apple-blue transition-colors hover:text-[#8fc8ff]"
                  >
                    <span className="overflow-hidden underline decoration-apple-blue/25 underline-offset-2 group-hover/link:decoration-apple-blue/70">
                      <CellValue value={value} />
                    </span>
                    <ArrowUpRight className="h-3 w-3 shrink-0 opacity-45 transition-opacity group-hover/link:opacity-100" />
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-1">
                    <div className="overflow-hidden">
                      <CellValue value={value} />
                    </div>
                    {onInspect && (
                      <Maximize2 className="h-2.5 w-2.5 shrink-0 text-apple-blue opacity-0 transition-opacity group-hover/cell:opacity-100" />
                    )}
                  </div>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  </table>
);
