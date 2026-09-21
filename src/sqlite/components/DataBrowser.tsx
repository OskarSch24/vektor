import React, { useEffect, useMemo, useState } from 'react';
import type { SqlValue } from 'sql.js';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Search,
  X,
  Zap,
} from 'lucide-react';
import { dbEngine, TablePage } from '../services/dbEngine';
import {
  countActiveTableFilters,
  type FilteredTablePageOptions,
  type TableFilterCondition,
  type TablePageLoader,
} from '../services/tableFilters';
import { DatabaseMetadata } from '../types/sqlite';
import { CellDetailModal } from './CellDetailModal';
import {
  RelationalDataGrid,
  type ForeignKeyNavigationTarget,
} from './RelationalDataGrid';
import { TableFilterBuilder } from './TableFilterBuilder';

export interface DataBrowserProps {
  metadata: DatabaseMetadata;
  activeTableName: string | null;
  /** Changes whenever the underlying data changed and the page must be re-read. */
  schemaVersion: number;
  onOpenExport: () => void;
  /**
   * Optional native page loader for advanced filters. Without it the legacy
   * DBEngine loader stays active and the filter control remains disabled.
   */
  loadPage?: TablePageLoader;
  /** Opens the referenced record in the host's current/new table context. */
  onNavigateForeignKey?: (target: ForeignKeyNavigationTarget) => void;
  /**
   * One-shot filter supplied by the host after following a foreign key. A new
   * token replaces the current filter set with an equality filter.
   */
  navigationFilter?: DataBrowserNavigationFilter;
}

export interface DataBrowserNavigationFilter {
  token: number;
  column: string;
  value: SqlValue;
}

interface InspectedCell {
  column: string;
  value: SqlValue;
  rowIndex: number;
}

const PAGE_SIZES = [25, 50, 100, 250];
const EMPTY_PAGE: TablePage = { columns: [], values: [], totalCount: 0, executionTimeMs: 0 };

export const DataBrowser: React.FC<DataBrowserProps> = ({
  metadata,
  activeTableName,
  schemaVersion,
  onOpenExport,
  loadPage,
  onNavigateForeignKey,
  navigationFilter,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('ASC');
  const [filters, setFilters] = useState<TableFilterCondition[]>([]);
  const [debouncedFilters, setDebouncedFilters] = useState<TableFilterCondition[]>([]);
  const [page, setPage] = useState<TablePage>(EMPTY_PAGE);
  const [inspectedCell, setInspectedCell] = useState<InspectedCell | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setCurrentPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchTerm]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedFilters(filters);
      setCurrentPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [filters]);

  // Start over whenever a different table is shown.
  useEffect(() => {
    setCurrentPage(1);
    setSearchTerm('');
    setDebouncedSearch('');
    setSortBy(undefined);
    setSortOrder('ASC');
    setFilters([]);
    setDebouncedFilters([]);
  }, [activeTableName]);

  // The token makes repeated navigation to the same key intentional: every
  // host-issued navigation event can replace stale local filters exactly once.
  useEffect(() => {
    if (!navigationFilter) return;

    const nextFilter: TableFilterCondition = {
      id: `foreign-key-navigation-${navigationFilter.token}`,
      column: navigationFilter.column,
      operator: 'equals',
      value: navigationFilter.value,
    };
    setFilters([nextFilter]);
    setDebouncedFilters([nextFilter]);
    setCurrentPage(1);
  }, [navigationFilter?.token]);

  // Reading a page hits the database, so it belongs in an effect rather than in
  // a memo — and it has to re-run when the data behind it changed.
  useEffect(() => {
    let cancelled = false;

    if (!activeTableName) {
      setPage(EMPTY_PAGE);
      return () => {
        cancelled = true;
      };
    }

    const options: FilteredTablePageOptions = {
      page: currentPage,
      pageSize,
      sortBy,
      sortOrder,
      searchTerm: debouncedSearch,
      filters: debouncedFilters,
      filterLogic: 'AND',
    };
    const result = loadPage
      ? loadPage(activeTableName, options)
      : dbEngine.getTableData(activeTableName, options);

    Promise.resolve(result)
      .then((nextPage) => {
        if (!cancelled) setPage(nextPage);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setPage({
          ...EMPTY_PAGE,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTableName,
    currentPage,
    pageSize,
    sortBy,
    sortOrder,
    debouncedSearch,
    debouncedFilters,
    schemaVersion,
    loadPage,
  ]);

  const activeTableInfo = useMemo(
    () => metadata.tables.find((t) => t.name === activeTableName),
    [metadata, activeTableName]
  );

  const { columns, values, totalCount, executionTimeMs, error } = page;
  const tableColumnNames = activeTableInfo?.columns.map((column) => column.name) ?? [];
  const activeFilterCount = countActiveTableFilters(debouncedFilters, tableColumnNames);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // A shrinking result set must not strand the user on a page that no longer exists.
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const handleSort = (column: string) => {
    if (sortBy !== column) {
      setSortBy(column);
      setSortOrder('ASC');
    } else if (sortOrder === 'ASC') {
      setSortOrder('DESC');
    } else {
      // Third click clears the sort and returns to the table's natural order.
      setSortBy(undefined);
      setSortOrder('ASC');
    }
    setCurrentPage(1);
  };

  if (!activeTableName) {
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-[#0C0E14] text-apple-text-tertiary text-sm">
        Diese Datenbank enthält keine Tabellen oder Views.
      </div>
    );
  }

  const firstRowOnPage = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;

  return (
    <div className="flex-1 h-full flex flex-col min-w-0 bg-[#0d1016] overflow-hidden">
      <div className="h-10 px-2.5 border-b border-white/[0.075] glass-toolbar flex items-center justify-between shrink-0 gap-2 select-none">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h2 className="min-w-0 truncate text-[12px] font-semibold tracking-tight text-white">
            {activeTableName}
          </h2>
          <span className="shrink-0 rounded-[3px] border border-white/[0.06] bg-white/[0.045] px-1.5 py-0.5 font-mono text-[9.5px] text-apple-text-secondary">
            {totalCount.toLocaleString('de-DE')} {totalCount === 1 ? 'Zeile' : 'Zeilen'}
          </span>
          {executionTimeMs > 0 && (
            <span className="hidden 2xl:flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[9.5px] text-apple-text-tertiary">
              <Zap className="w-3 h-3 text-apple-green" />
              <span>{executionTimeMs} ms</span>
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div className="relative w-36 xl:w-52 2xl:w-60">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-apple-text-tertiary pointer-events-none" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="In Tabelle suchen…"
              aria-label="In Tabelle suchen"
              className="h-7 w-full rounded-[4px] border border-white/[0.08] bg-[#171923] py-1 pl-8 pr-7 text-[11px] text-apple-text-primary placeholder:text-apple-text-muted transition-colors focus:border-apple-blue focus:outline-none"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                aria-label="Suche zurücksetzen"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-apple-text-muted hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <TableFilterBuilder
            columns={activeTableInfo?.columns ?? []}
            filters={filters}
            onChange={(nextFilters) => {
              setFilters(nextFilters);
              setCurrentPage(1);
            }}
            disabled={!loadPage}
          />

          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setCurrentPage(1);
            }}
            aria-label="Zeilen pro Seite"
            className="h-7 rounded-[4px] border border-white/[0.08] bg-[#171923] px-2 text-[11px] text-apple-text-secondary focus:border-apple-blue focus:outline-none"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} Zeilen
              </option>
            ))}
          </select>

          <button
            onClick={onOpenExport}
            title="Tabelle exportieren"
            aria-label="Tabelle exportieren"
            className="grid h-7 w-7 place-items-center rounded-[4px] border border-white/[0.08] bg-white/[0.035] transition-colors hover:bg-white/[0.08]"
          >
            <FileSpreadsheet className="w-4 h-4 text-apple-green" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 p-8 text-center">
            <AlertCircle className="w-6 h-6 text-apple-red" />
            <p className="text-sm font-medium text-white">Tabelle konnte nicht gelesen werden</p>
            <p className="text-xs font-mono text-apple-red select-text max-w-lg break-words">
              {error}
            </p>
          </div>
        ) : values.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center text-apple-text-tertiary">
            <p className="text-sm font-medium mb-1">Keine Datensätze gefunden</p>
            <p className="text-xs">
              {debouncedSearch || activeFilterCount > 0
                ? 'Versuche einen anderen Suchbegriff oder Filter.'
                : 'Diese Tabelle enthält momentan keine Daten.'}
            </p>
          </div>
        ) : (
          <RelationalDataGrid
            columns={columns}
            rows={values}
            rowOffset={(currentPage - 1) * pageSize}
            columnMeta={(column) => activeTableInfo?.columns.find((c) => c.name === column)}
            foreignKeyMeta={(column) =>
              activeTableInfo?.foreignKeys.find((foreignKey) => foreignKey.from === column)
            }
            sort={{ by: sortBy, order: sortOrder, onSort: handleSort }}
            onInspect={setInspectedCell}
            onNavigateForeignKey={onNavigateForeignKey}
          />
        )}
      </div>

      <div className="h-8 px-3 border-t border-white/[0.075] glass-toolbar flex items-center justify-between shrink-0 text-[11px] text-apple-text-secondary select-none">
        <span>
          Zeige <strong className="text-white">{firstRowOnPage.toLocaleString('de-DE')}</strong> –{' '}
          <strong className="text-white">
            {Math.min(currentPage * pageSize, totalCount).toLocaleString('de-DE')}
          </strong>{' '}
          von <strong className="text-white">{totalCount.toLocaleString('de-DE')}</strong> Zeilen
        </span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            aria-label="Vorherige Seite"
            className="p-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-white">
            Seite {currentPage} von {totalPages}
          </span>

          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            aria-label="Nächste Seite"
            className="p-1 rounded-md bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <CellDetailModal
        cell={inspectedCell}
        columnType={
          activeTableInfo?.columns.find((c) => c.name === inspectedCell?.column)?.type
        }
        onClose={() => setInspectedCell(null)}
      />
    </div>
  );
};
