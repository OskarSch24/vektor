import React, { useMemo, useState } from 'react';
import { Check, Copy, Eye, Layers, PanelTopOpen, Search, Table, X } from 'lucide-react';
import { DatabaseMetadata, TableInfo } from '../types/sqlite';
import { ContextMenu } from '../../components/ContextMenu';

interface SidebarProps {
  metadata: DatabaseMetadata;
  selectedTable: string | null;
  onSelectTable: (tableName: string) => void;
  onOpenTableInNewTab?: (table: TableInfo) => void;
}

interface ObjectListProps {
  title: string;
  icon: React.ReactNode;
  items: TableInfo[];
  totalCount: number;
  emptyLabel: string;
  iconClass: string;
  selectedTable: string | null;
  copiedName: string | null;
  onSelect: (name: string) => void;
  onCopy: (event: React.MouseEvent, name: string) => void;
  onOpenInNewTab?: (table: TableInfo) => void;
}

const ObjectList: React.FC<ObjectListProps> = ({
  title,
  icon,
  items,
  totalCount,
  emptyLabel,
  iconClass,
  selectedTable,
  copiedName,
  onSelect,
  onCopy,
  onOpenInNewTab,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    item: TableInfo;
    x: number;
    y: number;
    anchor: HTMLElement;
  } | null>(null);

  const openContextMenu = (
    event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>,
    item: TableInfo
  ) => {
    if (!onOpenInNewTab) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    const pointerEvent = 'clientX' in event ? event : null;
    const hasPointerPosition = pointerEvent !== null && (pointerEvent.clientX !== 0 || pointerEvent.clientY !== 0);
    setContextMenu({
      item,
      x: hasPointerPosition ? pointerEvent.clientX : rect.left + 18,
      y: hasPointerPosition ? pointerEvent.clientY : rect.top + Math.min(rect.height, 24),
      anchor,
    });
  };

  return (
  <div>
    <div className="mb-1 flex h-5 items-center justify-between px-1.5 text-[9px] font-semibold uppercase tracking-[0.11em] text-[#8d8d8d]">
      <span className="flex items-center gap-1">
        {icon}
        <span>{title}</span>
      </span>
      <span className="font-mono text-[9px] font-normal text-[#696969]">
        {totalCount}
      </span>
    </div>

    <div className="space-y-0.5">
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-[10.5px] text-[#777]">{emptyLabel}</p>
      ) : (
        items.map((item) => {
          const isSelected = selectedTable === item.name;
          return (
            <div
              key={item.name}
              data-table-name={item.name}
              data-table-kind={item.type}
              role="button"
              tabIndex={0}
              aria-current={isSelected}
              onClick={() => onSelect(item.name)}
              onContextMenu={onOpenInNewTab ? (event) => openContextMenu(event, item) : undefined}
              aria-haspopup={onOpenInNewTab ? 'menu' : undefined}
              aria-expanded={onOpenInNewTab ? contextMenu?.item.name === item.name : undefined}
              onKeyDown={(e) => {
                if (onOpenInNewTab && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
                  openContextMenu(e, item);
                  return;
                }
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(item.name);
                }
              }}
              className={`group flex h-[23px] items-center justify-between gap-1.5 rounded-[2px] px-1.5 text-[11px] cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#6688a8] ${
                isSelected
                  ? 'bg-[#2a2d2e] text-[#f0f0f0]'
                  : 'text-[#b7b7b7] hover:bg-white/[0.045] hover:text-[#eeeeee]'
              }`}
            >
              <span className="flex items-center gap-2 truncate min-w-0">
                <span className={`shrink-0 ${isSelected ? 'text-white' : iconClass}`}>{icon}</span>
                <span className="truncate">{item.name}</span>
              </span>

              <span className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={(e) => onCopy(e, item.name)}
                  title="Namen kopieren"
                  aria-label={`Namen von ${item.name} kopieren`}
                  className={`grid h-[17px] w-[17px] place-items-center rounded-[2px] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:bg-white/[0.08] ${
                    isSelected ? 'text-white' : 'text-apple-text-tertiary'
                  }`}
                >
                  {copiedName === item.name ? (
                    <Check className="w-3 h-3 text-apple-green" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
                <span
                  className={`min-w-[22px] text-right font-mono text-[9px] ${
                    isSelected ? 'text-[#cfcfcf]' : 'text-[#686868]'
                  }`}
                >
                  {item.rowCount === null ? 'View' : item.rowCount.toLocaleString('de-DE')}
                </span>
              </span>
            </div>
          );
        })
      )}
    </div>

    {contextMenu && onOpenInNewTab && (
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        anchor={contextMenu.anchor}
        ariaLabel={`Aktionen für ${contextMenu.item.name}`}
        onClose={() => setContextMenu(null)}
        items={[
          {
            label: 'In neuem Tab öffnen',
            icon: <PanelTopOpen className="w-3.5 h-3.5" strokeWidth={1.6} />,
            onSelect: () => onOpenInNewTab(contextMenu.item),
          },
        ]}
      />
    )}
  </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  metadata,
  selectedTable,
  onSelectTable,
  onOpenTableInNewTab,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedName, setCopiedName] = useState<string | null>(null);

  const { tables, views, matchingTables, matchingViews } = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    const matches = (item: TableInfo) => item.name.toLowerCase().includes(needle);
    const allTables = metadata.tables.filter((t) => t.type === 'table');
    const allViews = metadata.tables.filter((t) => t.type === 'view');
    return {
      tables: allTables,
      views: allViews,
      matchingTables: needle ? allTables.filter(matches) : allTables,
      matchingViews: needle ? allViews.filter(matches) : allViews,
    };
  }, [metadata, searchTerm]);

  const handleCopyName = (event: React.MouseEvent, name: string) => {
    event.stopPropagation();
    void navigator.clipboard.writeText(name);
    setCopiedName(name);
    setTimeout(() => setCopiedName(null), 1500);
  };

  return (
    <aside className="h-full w-[232px] shrink-0 select-none overflow-hidden border-r border-[#2a2a2a] bg-[#141414] flex flex-col">
      <div className="h-[37px] shrink-0 border-b border-white/[0.055] p-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#707070]" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Tabellen & Views filtern…"
            aria-label="Tabellen und Views filtern"
            className="h-[25px] w-full rounded-[3px] border border-[#303030] bg-[#1b1b1b] py-1 pl-6 pr-6 text-[10.5px] text-[#d8d8d8] placeholder:text-[#6d6d6d] transition-colors focus:border-[#555] focus:outline-none"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              aria-label="Filter zurücksetzen"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-apple-text-muted hover:text-white"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-1.5 py-2">
        <ObjectList
          title="Tabellen"
          icon={<Table className="w-3 h-3" />}
          items={matchingTables}
          totalCount={tables.length}
          emptyLabel="Keine Tabellen gefunden"
          iconClass="text-apple-blue/80"
          selectedTable={selectedTable}
          copiedName={copiedName}
          onSelect={onSelectTable}
          onCopy={handleCopyName}
          onOpenInNewTab={onOpenTableInNewTab}
        />

        {views.length > 0 && (
          <ObjectList
            title="Views"
            icon={<Eye className="w-3 h-3" />}
            items={matchingViews}
            totalCount={views.length}
            emptyLabel="Keine Views gefunden"
            iconClass="text-apple-purple/80"
            selectedTable={selectedTable}
            copiedName={copiedName}
            onSelect={onSelectTable}
            onCopy={handleCopyName}
            onOpenInNewTab={onOpenTableInNewTab}
          />
        )}
      </div>

      <div className="space-y-1 border-t border-white/[0.055] bg-[#141414] px-2.5 py-2 text-[10px] text-[#777]">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Layers className="w-3 h-3 text-[#7f9eae]" />
            <span>SQLite Engine</span>
          </span>
          <span className="font-mono text-[#999]">v{metadata.sqliteVersion}</span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span>Zeilen gesamt</span>
          <span className="font-mono text-[#999]">
            {metadata.totalRows.toLocaleString('de-DE')}
          </span>
        </div>
      </div>
    </aside>
  );
};
