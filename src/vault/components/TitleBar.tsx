import React from 'react';
import { Database, GitBranch, KeyRound, Lock, RefreshCw, Server, SquareTerminal } from 'lucide-react';
import type { ActiveTab } from '../types/app';
import type { Connection } from '../services/redis/connection';

interface TitleBarProps {
  connection: Connection | null;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onSelectDatabase: (index: number) => void;
  onRefresh: () => void;
  busy: boolean;
}

const TABS: { id: Exclude<ActiveTab, 'api'>; label: string; icon: React.ReactNode }[] = [
  { id: 'keys', label: 'Schlüssel', icon: <KeyRound className="h-3.5 w-3.5" /> },
  { id: 'phasex', label: 'Phase X', icon: <GitBranch className="h-3.5 w-3.5" /> },
  { id: 'console', label: 'Konsole', icon: <SquareTerminal className="h-3.5 w-3.5" /> },
  { id: 'server', label: 'Server', icon: <Server className="h-3.5 w-3.5" /> },
];

/** Controls for the selected RDB/AOF source, never a source picker. */
export const TitleBar: React.FC<TitleBarProps> = ({
  connection,
  activeTab,
  onTabChange,
  onSelectDatabase,
  onRefresh,
  busy,
}) => (
  <header className="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-[#2a2a2a] bg-[#181818] px-1.5 select-none [box-shadow:inset_0_1px_0_rgba(255,255,255,0.018)]">
    <div className="flex min-w-0 shrink items-center border-r border-[#2a2a2a]">
      {connection && (
        <>
          <span className="mx-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#5fbd76] ring-2 ring-[#213125]" />
          <span
            className="hidden max-w-[150px] truncate pr-1 text-[10.5px] font-medium text-[#b8b8b8] xl:inline"
            title={connection.displayName ?? `${connection.host}:${connection.port}`}
          >
            {connection.displayName ?? `${connection.host}:${connection.port}`}
          </span>
          <label className="flex shrink-0 items-center gap-1 text-[10.5px] text-[#858585]" title={`Datenbereich ${connection.database}`}>
            <Database className="h-3.5 w-3.5" />
            <select
              value={connection.database}
              onChange={(event) => onSelectDatabase(Number(event.target.value))}
              className="h-6 w-[60px] rounded-[4px] border border-[#343434] bg-[#202020] px-1.5 text-[10.5px] text-[#d4d4d4] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] focus:border-[#6688a8] focus:outline-none xl:w-[72px]"
            >
              {connection.availableDatabases.map((index) => (
                <option key={index} value={index}>DB {index}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={onRefresh}
            className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-[#8f8f8f] transition-colors hover:bg-[#252525] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8]"
            title="Neu laden (⌘R)"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </>
      )}
    </div>

    <nav
      className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Ansichten des Redis-Speicherstands"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onTabChange(tab.id)}
          disabled={!connection}
          title={tab.label}
          aria-current={activeTab === tab.id ? 'page' : undefined}
          className={`flex h-full shrink-0 items-center gap-1.5 border-b px-2.5 text-[11.5px] font-medium transition-[background-color,color,border-color] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#6688a8] disabled:cursor-not-allowed disabled:opacity-30 xl:px-3 ${
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

    {connection && (
      <div className="ml-auto flex shrink-0 items-center border-l border-[#2a2a2a] bg-[#181818] pl-1">
        <span
          className="flex h-7 items-center gap-1.5 px-2 text-[10.5px] font-medium text-[#91b598]"
          title="Geschützte Arbeitskopie — der Originalordner bleibt unverändert"
        >
          <Lock className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Original geschützt</span>
        </span>
      </div>
    )}
  </header>
);
