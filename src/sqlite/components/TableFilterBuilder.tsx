import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Filter, Plus, RotateCcw, X } from 'lucide-react';
import type { TableColumn } from '../types/sqlite';
import {
  FILTER_OPERATORS,
  countActiveTableFilters,
  filterOperatorNeedsValue,
  type TableFilterCondition,
  type TableFilterOperator,
} from '../services/tableFilters';

interface TableFilterBuilderProps {
  columns: TableColumn[];
  filters: TableFilterCondition[];
  onChange: (filters: TableFilterCondition[]) => void;
  disabled?: boolean;
}

let filterSequence = 0;

function nextFilterId(): string {
  filterSequence += 1;
  return `table-filter-${Date.now()}-${filterSequence}`;
}

function isNumericType(type: string): boolean {
  return /INT|REAL|FLOA|DOUB|NUM|DEC|BOOL/i.test(type);
}

function defaultOperator(column: TableColumn | undefined): TableFilterOperator {
  return column && isNumericType(column.type) ? 'equals' : 'contains';
}

export const TableFilterBuilder: React.FC<TableFilterBuilderProps> = ({
  columns,
  filters,
  onChange,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const columnNames = useMemo(() => columns.map((column) => column.name), [columns]);
  const activeCount = countActiveTableFilters(filters, columnNames);

  useEffect(() => {
    if (!isOpen) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target)
        && !popoverRef.current?.contains(target)
      ) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const position = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12;
      const width = Math.min(680, window.innerWidth - margin * 2);
      const left = Math.max(
        margin,
        Math.min(rect.right - width, window.innerWidth - width - margin)
      );
      const top = rect.bottom + 7;
      setPopoverPosition({
        left,
        top,
        width,
        maxHeight: Math.max(180, window.innerHeight - top - margin),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const addFilter = () => {
    const column = columns[0];
    if (!column) return;
    onChange([
      ...filters,
      {
        id: nextFilterId(),
        column: column.name,
        operator: defaultOperator(column),
        value: '',
      },
    ]);
  };

  const updateFilter = (id: string, patch: Partial<TableFilterCondition>) => {
    onChange(filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)));
  };

  const removeFilter = (id: string) => {
    onChange(filters.filter((filter) => filter.id !== id));
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        disabled={disabled || columns.length === 0}
        aria-label="Erweiterte Filter"
        aria-expanded={isOpen}
        title={
          disabled
            ? 'Erweiterte Filter benötigen die Filter-Engine.'
            : 'Mehrere Bedingungen kombinieren'
        }
        className={`relative flex h-7 items-center gap-1.5 rounded-[4px] border px-2 text-[11px] transition-colors disabled:pointer-events-none disabled:opacity-35 ${
          activeCount > 0 || isOpen
            ? 'border-apple-blue/45 bg-apple-blue/[0.12] text-white'
            : 'border-white/[0.08] bg-white/[0.035] text-apple-text-secondary hover:bg-white/[0.08] hover:text-white'
        }`}
      >
        <Filter className="h-3.5 w-3.5" />
        <span className="hidden 2xl:inline">Filter</span>
        {activeCount > 0 && (
          <span className="grid min-w-[16px] place-items-center rounded-[3px] bg-apple-blue px-1 font-mono text-[9px] font-semibold leading-4 text-white">
            {activeCount}
          </span>
        )}
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={popoverPosition ?? { visibility: 'hidden' }}
          className="fixed z-[170] flex flex-col overflow-hidden rounded-[6px] border border-white/[0.11] bg-[#181818] shadow-[0_18px_60px_rgba(0,0,0,0.55)]"
        >
          <div className="flex h-9 items-center justify-between border-b border-white/[0.08] px-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-semibold text-white">Tabellenfilter</span>
              <span className="text-[9.5px] text-apple-text-tertiary">
                Alle Bedingungen müssen zutreffen
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Filter schließen"
              className="grid h-6 w-6 place-items-center rounded-[3px] text-apple-text-tertiary transition-colors hover:bg-white/[0.07] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {filters.length === 0 ? (
              <button
                type="button"
                onClick={addFilter}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-[4px] border border-dashed border-white/[0.1] text-[11px] text-apple-text-tertiary transition-colors hover:border-white/[0.18] hover:bg-white/[0.035] hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" />
                Erste Bedingung hinzufügen
              </button>
            ) : (
              <div className="space-y-1.5">
                {filters.map((filter, index) => {
                  const needsValue = filterOperatorNeedsValue(filter.operator);
                  const column = columns.find((candidate) => candidate.name === filter.column);
                  const numericInput = column ? isNumericType(column.type) : false;

                  return (
                    <React.Fragment key={filter.id}>
                      {index > 0 && (
                        <div className="flex h-3 items-center gap-2 px-1">
                          <span className="h-px flex-1 bg-white/[0.06]" />
                          <span className="font-mono text-[8.5px] font-semibold tracking-[0.12em] text-apple-blue">
                            UND
                          </span>
                          <span className="h-px flex-1 bg-white/[0.06]" />
                        </div>
                      )}

                      <div className="grid grid-cols-[minmax(90px,1fr)_minmax(100px,1fr)_minmax(90px,1.2fr)_28px] items-center gap-1.5 rounded-[4px] border border-white/[0.07] bg-[#1f1f1f] p-1.5">
                        <select
                          value={filter.column}
                          onChange={(event) => {
                            const nextColumn = columns.find(
                              (candidate) => candidate.name === event.target.value
                            );
                            updateFilter(filter.id, {
                              column: event.target.value,
                              operator: defaultOperator(nextColumn),
                            });
                          }}
                          aria-label={`Spalte für Bedingung ${index + 1}`}
                          className="h-7 min-w-0 rounded-[3px] border border-white/[0.09] bg-[#141414] px-2 text-[10.5px] text-white outline-none focus:border-apple-blue/70"
                        >
                          {columns.map((candidate) => (
                            <option key={candidate.name} value={candidate.name}>
                              {candidate.name}
                            </option>
                          ))}
                        </select>

                        <select
                          value={filter.operator}
                          onChange={(event) =>
                            updateFilter(filter.id, {
                              operator: event.target.value as TableFilterOperator,
                            })
                          }
                          aria-label={`Operator für Bedingung ${index + 1}`}
                          className="h-7 min-w-0 rounded-[3px] border border-white/[0.09] bg-[#141414] px-2 text-[10.5px] text-apple-text-primary outline-none focus:border-apple-blue/70"
                        >
                          {FILTER_OPERATORS.map((operator) => (
                            <option key={operator.value} value={operator.value}>
                              {operator.label}
                            </option>
                          ))}
                        </select>

                        {needsValue ? (
                          <input
                            type={numericInput ? 'number' : 'text'}
                            value={
                              filter.value === null || filter.value === undefined
                                ? ''
                                : String(filter.value)
                            }
                            onChange={(event) => updateFilter(filter.id, { value: event.target.value })}
                            placeholder="Wert eingeben…"
                            aria-label={`Wert für Bedingung ${index + 1}`}
                            className="h-7 min-w-0 rounded-[3px] border border-white/[0.09] bg-[#141414] px-2 text-[10.5px] text-white placeholder:text-apple-text-muted outline-none focus:border-apple-blue/70"
                          />
                        ) : (
                          <div className="flex h-7 items-center gap-1.5 rounded-[3px] border border-white/[0.055] bg-[#171717] px-2 text-[9.5px] text-apple-text-tertiary">
                            <Check className="h-3 w-3 text-apple-green" />
                            Kein Wert nötig
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => removeFilter(filter.id)}
                          aria-label={`Bedingung ${index + 1} entfernen`}
                          className="grid h-7 w-7 place-items-center rounded-[3px] text-apple-text-tertiary transition-colors hover:bg-apple-red/[0.12] hover:text-apple-red"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex h-10 items-center justify-between border-t border-white/[0.08] bg-[#151515] px-2.5">
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={filters.length === 0}
              className="flex h-7 items-center gap-1.5 rounded-[3px] px-2 text-[10.5px] text-apple-text-tertiary transition-colors hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-35"
            >
              <RotateCcw className="h-3 w-3" />
              Zurücksetzen
            </button>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={addFilter}
                className="flex h-7 items-center gap-1.5 rounded-[3px] border border-white/[0.09] px-2 text-[10.5px] text-apple-text-secondary transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                <Plus className="h-3 w-3" />
                Bedingung
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="h-7 rounded-[3px] bg-apple-blue px-3 text-[10.5px] font-medium text-white transition-colors hover:bg-apple-blue/85"
              >
                Fertig
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
