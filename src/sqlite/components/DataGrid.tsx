import React from 'react';
import type { SqlValue } from 'sql.js';
import { ArrowDown, ArrowUp, ArrowUpDown, KeyRound, Maximize2 } from 'lucide-react';
import { TableColumn } from '../types/sqlite';
import { CellValue } from './CellValue';

export interface GridSort {
  by?: string;
  order: 'ASC' | 'DESC';
  onSort: (column: string) => void;
}

interface DataGridProps {
  columns: string[];
  rows: SqlValue[][];
  /** Row number of the first row, so paged views keep counting up. */
  rowOffset?: number;
  columnMeta?: (column: string) => TableColumn | undefined;
  sort?: GridSort;
  onInspect?: (cell: { column: string; value: SqlValue; rowIndex: number }) => void;
}

const headerCell =
  'px-3 py-2 font-medium text-apple-text-secondary border-r border-white/[0.06] whitespace-nowrap';

/** The scrollable result grid shared by the data browser and the SQL editor. */
export const DataGrid: React.FC<DataGridProps> = ({
  columns,
  rows,
  rowOffset = 0,
  columnMeta,
  sort,
  onInspect,
}) => (
  <table className="w-full border-collapse text-left text-xs">
    <thead className="sticky top-0 z-10 bg-[#141722]/95 backdrop-blur-md border-b border-white/[0.08] shadow-sm select-none">
      <tr>
        <th className="w-12 px-3 py-2 text-[10px] font-mono font-medium text-apple-text-tertiary text-center border-r border-white/[0.06] bg-[#11131C]">
          #
        </th>
        {columns.map((column, index) => {
          const meta = columnMeta?.(column);
          const isSorted = sort?.by === column;
          return (
            <th
              key={`${column}-${index}`}
              scope="col"
              aria-sort={isSorted ? (sort.order === 'ASC' ? 'ascending' : 'descending') : undefined}
              onClick={sort ? () => sort.onSort(column) : undefined}
              className={`${headerCell} ${
                sort ? 'cursor-pointer hover:bg-white/[0.04] transition-colors group' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {meta?.pk === 1 && (
                    <KeyRound
                      aria-label="Primärschlüssel"
                      className="w-3 h-3 text-apple-amber shrink-0"
                    />
                  )}
                  <span className="text-white font-semibold truncate">{column}</span>
                  {meta?.type && (
                    <span className="text-[9px] font-mono px-1 rounded bg-white/[0.06] text-apple-text-tertiary shrink-0">
                      {meta.type}
                    </span>
                  )}
                </div>

                {sort && (
                  <span className="text-apple-text-muted shrink-0">
                    {isSorted ? (
                      sort.order === 'ASC' ? (
                        <ArrowUp className="w-3 h-3 text-apple-blue" />
                      ) : (
                        <ArrowDown className="w-3 h-3 text-apple-blue" />
                      )
                    ) : (
                      <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-60" />
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
        <tr key={rowIndex} className="hover:bg-white/[0.03] transition-colors">
          <td className="px-3 py-2 text-[10px] font-mono text-apple-text-tertiary text-center border-r border-white/[0.04] bg-[#0E1018]/50 select-none">
            {rowOffset + rowIndex + 1}
          </td>

          {row.map((value, columnIndex) => {
            const column = columns[columnIndex] ?? `col_${columnIndex}`;
            return (
              <td
                key={columnIndex}
                onClick={
                  onInspect
                    ? () => onInspect({ column, value, rowIndex: rowOffset + rowIndex })
                    : undefined
                }
                className={`px-3 py-2 text-apple-text-primary border-r border-white/[0.04] whitespace-nowrap max-w-xs select-text ${
                  onInspect
                    ? 'cursor-pointer hover:bg-apple-blue/[0.08] transition-colors group/cell'
                    : ''
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="overflow-hidden">
                    <CellValue value={value} />
                  </div>
                  {onInspect && (
                    <Maximize2 className="w-2.5 h-2.5 text-apple-blue opacity-0 group-hover/cell:opacity-100 shrink-0 transition-opacity" />
                  )}
                </div>
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  </table>
);
