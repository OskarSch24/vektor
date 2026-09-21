import React from 'react';
import { CheckCircle2, Combine, Database, Download, FolderOpen, Table, Terminal, FileCode2, BarChart3, Plug, Info } from 'lucide-react';
import { ActiveTab, DatabaseMetadata } from '../types/sqlite';
import { formatBytes } from '../lib/sql';

interface TitleBarProps {
  embedded?: boolean;
  metadata: DatabaseMetadata | null;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onOpenFile: () => void;
  onExport: () => void;
  warningMessage?: string | null;
  statusMessage?: string | null;
  onMergeFiles?: () => void;
  mergeDisabled?: boolean;
}

const TABS: Array<{ id: ActiveTab; label: string; icon: React.ReactNode }> = [
  { id: 'data', label: 'Daten', icon: <Table className="h-3.5 w-3.5" /> },
  { id: 'query', label: 'SQL', icon: <Terminal className="h-3.5 w-3.5" /> },
  { id: 'schema', label: 'Schema', icon: <FileCode2 className="h-3.5 w-3.5" /> },
  { id: 'stats', label: 'Statistiken', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: 'api', label: 'API', icon: <Plug className="h-3.5 w-3.5" /> },
];

export const TitleBar: React.FC<TitleBarProps> = ({
  embedded = false,
  metadata,
  activeTab,
  onTabChange,
  onOpenFile,
  onExport,
  warningMessage = null,
  statusMessage = null,
  onMergeFiles,
  mergeDisabled = false,
}) => {
  return (
    <header
      data-drag-region
      className="relative z-20 flex h-9 w-full shrink-0 items-stretch overflow-hidden border-b border-[#2a2a2a] bg-[#181818] px-1.5 select-none [box-shadow:inset_0_1px_0_rgba(255,255,255,0.018)]"
    >
      <div className="flex min-w-0 max-w-[220px] shrink items-center xl:max-w-[270px] 2xl:max-w-[340px]">
        {/* Native traffic light margin (72px). Marked no-drag so a click can
            never be swallowed by the drag strip, whatever the z-order. */}
        {!embedded && <div data-no-drag className="w-[68px] shrink-0 h-4" />}

        {metadata && (
          <div className="flex h-full min-w-0 items-center gap-2 border-r border-[#2a2a2a] px-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border border-[#344750] bg-[#1d272b] text-[#92bec9]">
              <Database className="h-3 w-3" />
            </span>
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="truncate text-[11.5px] font-medium tracking-[-0.005em] text-[#dedede]">
                {metadata.filename}
              </span>
              <span className="hidden whitespace-nowrap font-mono text-[9.5px] text-[#737373] 2xl:inline">
                {formatBytes(metadata.fileSize)}
              </span>
            </div>
          </div>
        )}
      </div>

      {metadata && (
        <nav
          data-no-drag
          aria-label="Datenbank-Ansichten"
          className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              title={tab.label}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`flex h-full shrink-0 items-center gap-1.5 border-b px-2.5 text-[11.5px] font-medium transition-[background-color,color,border-color] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#6688a8] xl:px-3 ${
                activeTab === tab.id
                  ? 'border-[#82a3c2] bg-[#212121] text-[#f0f0f0]'
                  : 'border-transparent text-[#929292] hover:bg-[#1f1f1f] hover:text-[#d6d6d6]'
              }`}
            >
              {tab.icon}
              <span className="hidden xl:inline">{tab.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div data-no-drag className="z-30 ml-auto flex shrink-0 items-center gap-px border-l border-[#2a2a2a] bg-[#181818] pl-1">
        {warningMessage && (
          <span
            role="status"
            aria-label={warningMessage}
            title={warningMessage}
            className="mx-1 flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-[4px] text-[#d7a04a] transition-colors hover:bg-[#2a241b] hover:text-[#efb85e] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d7a04a]"
            tabIndex={0}
          >
            <Info className="h-3.5 w-3.5" />
          </span>
        )}

        {statusMessage && (
          <span
            role="status"
            aria-label={statusMessage}
            title={statusMessage}
            className="mx-1 flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-[4px] text-[#72b78b] transition-colors hover:bg-[#1d2a22] hover:text-[#91cea5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#72b78b]"
            tabIndex={0}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
          </span>
        )}

        {!metadata && (
          <button
            type="button"
            onClick={() => onTabChange('api')}
            title="Lokale API und MCP-Zugang"
            aria-pressed={activeTab === 'api'}
            className={`flex h-7 items-center gap-1.5 rounded-[4px] border border-transparent px-2 text-[10.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8] ${
              activeTab === 'api'
                ? 'bg-[#252525] text-white'
                : 'text-[#9a9a9a] hover:bg-[#252525] hover:text-white'
            }`}
          >
            <Plug className="w-3.5 h-3.5 text-apple-cyan" />
            <span className="hidden 2xl:inline">API</span>
          </button>
        )}

        <button
          type="button"
          onClick={onOpenFile}
          title="Datenbank oder Datendatei öffnen"
          className="flex h-7 items-center gap-1.5 rounded-[4px] border border-transparent px-2 text-[10.5px] font-medium text-[#a9a9a9] transition-colors hover:bg-[#252525] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8]"
        >
          <FolderOpen className="w-3.5 h-3.5 text-apple-blue" />
          <span className="hidden xl:inline">Öffnen</span>
        </button>

        {onMergeFiles && (
          <button
            type="button"
            onClick={onMergeFiles}
            disabled={mergeDisabled}
            title={mergeDisabled ? 'Arbeitskopie zuerst sichern oder verwerfen' : 'Mehrere JSON-, CSV- oder Excel-Dateien zusammenführen'}
            className="flex h-7 items-center gap-1.5 rounded-[4px] border border-transparent px-2 text-[10.5px] font-medium text-[#a9a9a9] transition-colors hover:bg-[#252525] hover:text-white disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8]"
          >
            <Combine className="h-3.5 w-3.5 text-apple-cyan" />
            <span className="hidden 2xl:inline">Zusammenführen</span>
          </button>
        )}

        {metadata && (
          <button
            type="button"
            onClick={onExport}
            title="Datenbank als Datei sichern (.sqlite)"
            className="flex h-7 items-center gap-1.5 rounded-[4px] border border-transparent px-2 text-[10.5px] font-medium text-[#a9a9a9] transition-colors hover:bg-[#252525] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8]"
          >
            <Download className="w-3.5 h-3.5 text-apple-green" />
            <span className="hidden xl:inline">Export</span>
          </button>
        )}
      </div>
    </header>
  );
};
