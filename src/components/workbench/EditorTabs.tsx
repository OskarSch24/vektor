import type { FC } from 'react';
import { HardDrive, House, Network, Plus, Rows3, X } from 'lucide-react';
import type { EditorTab } from '../../workbench/model';

interface EditorTabsProps {
  tabs: EditorTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
}

export const EditorTabs: FC<EditorTabsProps> = ({ tabs, activeId, onSelect, onClose, onAdd }) => {
  return (
    <nav className="cursor-editor-tabs h-[35px] shrink-0 flex items-stretch border-b border-white/[0.075] bg-[#141414] select-none" aria-label="Offene Tabs">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden" role="tablist">
      {tabs.map((tab) => {
        const Icon = tab.source.kind === 'home'
          ? House
          : tab.source.kind === 'table'
            ? Rows3
            : tab.source.kind === 'graph'
              ? Network
              : HardDrive;
        const label = tab.tableName ?? tab.source.name;
        const isActive = activeId === tab.id;
        return (
          <div
            key={tab.id}
            className={`cursor-editor-tab cursor-editor-tab-${tab.source.kind} group relative flex min-w-[128px] max-w-[230px] items-stretch border-r border-white/[0.075] transition-colors ${
              isActive
                ? 'is-active bg-[#181818] text-white'
                : 'bg-[#141414] text-apple-text-muted hover:bg-white/[0.035] hover:text-apple-text-secondary'
            }`}
          >
            <button
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
              title={`${tab.tableName ? `${tab.tableName} · ` : ''}${tab.source.path ?? tab.source.name}`}
              className="flex min-w-0 flex-1 items-center gap-2 py-0 pl-3 pr-8 text-left text-[11px] focus-visible:z-10"
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 tab-icon-${tab.source.kind}`} strokeWidth={1.65} />
              <span className="truncate">{label}</span>
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              aria-label={`Tab „${label}“ schließen${tab.dirty ? ' · Ungesicherte Änderungen' : ''}`}
              title={tab.dirty ? 'Ungesicherte Änderungen – schließen' : 'Schließen'}
              className={`cursor-tab-close absolute right-1.5 top-1/2 grid h-[18px] w-[18px] -translate-y-1/2 place-items-center rounded-[3px] transition-colors hover:bg-white/[0.09] hover:text-white ${isActive || tab.dirty ? 'text-apple-text-tertiary' : 'text-transparent group-hover:text-apple-text-tertiary focus:text-apple-text-tertiary'}`}
            >
              {tab.dirty ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-current group-hover:hidden" aria-hidden="true" />
                  <X className="hidden h-3 w-3 group-hover:block" strokeWidth={1.8} />
                </>
              ) : (
                <X className="h-3 w-3" strokeWidth={1.8} />
              )}
            </button>
          </div>
        );
      })}
      <div className="min-w-3 flex-1 bg-[#141414]" />
      </div>
      <button
        onClick={onAdd}
        data-testid="new-tab"
        aria-label="Neuen Tab öffnen"
        title="Neuer Tab"
        className="cursor-new-tab grid h-[34px] w-[36px] shrink-0 place-items-center border-l border-white/[0.06] bg-[#141414] text-apple-text-muted transition-colors hover:bg-white/[0.045] hover:text-white"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={1.7} />
      </button>
    </nav>
  );
};
