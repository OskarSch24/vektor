import React from 'react';
import { BarChart3, Download, FilePlus2, FolderOpen, Inbox, ListTree, Network, Plug, Settings, Share2, Terminal, Users, Waypoints } from 'lucide-react';
import { ActiveTab } from '../types/graph';
import { formatCount } from '../lib/graph';

interface TitleBarProps {
  embedded?: boolean;
  graphName: string | null;
  nodeCount: number;
  edgeCount: number;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onNewGraph: () => void;
  onOpenGraph: () => void;
  onOpenCoordination: () => void;
  onExport: () => void;
  onOpenSettings: () => void;
  /** Number of jobs that are queued or running, for the tab badge. */
  activeJobs: number;
  hasHierarchy: boolean;
}

const TABS: Array<{ id: ActiveTab; label: string; icon: React.ReactNode }> = [
  { id: 'graph', label: 'Graph', icon: <Share2 className="w-3.5 h-3.5" /> },
  { id: 'hierarchy', label: 'Hierarchie', icon: <ListTree className="w-3.5 h-3.5" /> },
  { id: 'query', label: 'Abfrage', icon: <Terminal className="w-3.5 h-3.5" /> },
  { id: 'ontology', label: 'Ontologie', icon: <Waypoints className="w-3.5 h-3.5" /> },
  { id: 'ingest', label: 'Import', icon: <Inbox className="w-3.5 h-3.5" /> },
  { id: 'stats', label: 'Statistiken', icon: <BarChart3 className="w-3.5 h-3.5" /> },
  { id: 'api', label: 'API', icon: <Plug className="w-3.5 h-3.5" /> },
];

export const TitleBar: React.FC<TitleBarProps> = ({
  embedded = false,
  graphName,
  nodeCount,
  edgeCount,
  activeTab,
  onTabChange,
  onNewGraph,
  onOpenGraph,
  onOpenCoordination,
  onExport,
  onOpenSettings,
  activeJobs,
  hasHierarchy,
}) => {
  return (
    <header
      data-drag-region
      className="relative z-20 flex h-9 w-full shrink-0 items-stretch overflow-hidden border-b border-[#2a2a2a] bg-[#181818] px-1.5 select-none [box-shadow:inset_0_1px_0_rgba(255,255,255,0.018)]"
    >
      <div className="flex min-w-0 max-w-[220px] shrink items-center xl:max-w-[270px] 2xl:max-w-[340px]">
        {/* Room for the native traffic lights. Marked no-drag so a click can
            never be swallowed by the drag strip, whatever the z-order. */}
        {!embedded && <div data-no-drag className="w-[68px] shrink-0 h-4" />}

        {graphName && (
          <div className="flex h-full min-w-0 items-center gap-2 border-r border-[#2a2a2a] px-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border border-[#493d49] bg-[#251f25] text-[#c69abe]">
              <Network className="h-3 w-3" />
            </span>
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="truncate text-[11.5px] font-medium tracking-[-0.005em] text-[#dedede]">
                {graphName}
              </span>
              <span className="hidden whitespace-nowrap font-mono text-[9.5px] text-[#737373] 2xl:inline">
                {formatCount(nodeCount)} K · {formatCount(edgeCount)} B
              </span>
            </div>
          </div>
        )}
      </div>

      {graphName && (
        <nav
          data-no-drag
          aria-label="Graph-Ansichten"
          className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.filter((tab) => {
            if (tab.id === 'hierarchy') return hasHierarchy;
            if (hasHierarchy && (tab.id === 'ingest' || tab.id === 'api')) return false;
            return true;
          }).map((tab) => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              title={tab.label}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`relative flex h-full shrink-0 items-center gap-1.5 border-b px-2.5 text-[11.5px] font-medium transition-[background-color,color,border-color] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#6688a8] xl:px-3 ${
                activeTab === tab.id
                  ? 'border-[#82a3c2] bg-[#212121] text-[#f0f0f0]'
                  : 'border-transparent text-[#929292] hover:bg-[#1f1f1f] hover:text-[#d6d6d6]'
              }`}
            >
              {tab.icon}
              <span className="hidden xl:inline">{tab.label}</span>
              {tab.id === 'ingest' && activeJobs > 0 && (
                <span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-[4px] bg-[#315b7d] px-1 text-[9.5px] font-semibold tabular-nums text-[#edf6ff] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                  {activeJobs}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}

      <div
        data-no-drag
        className="z-30 ml-auto flex shrink-0 items-center gap-px border-l border-[#2a2a2a] bg-[#181818] pl-1"
      >
        <IconButton onClick={onNewGraph} title="Neuen Graphen anlegen">
          <FilePlus2 className="w-3.5 h-3.5 text-apple-purple" />
        </IconButton>

        <IconButton onClick={onOpenGraph} title="Graph oder Phase-X-Lauf öffnen">
          <FolderOpen className="w-3.5 h-3.5 text-apple-blue" />
        </IconButton>

        <IconButton onClick={onOpenCoordination} title="Koordinations-Records lesen (Coordination/Items)">
          <Users className="w-3.5 h-3.5 text-apple-indigo" />
        </IconButton>

        {graphName && (
          <IconButton onClick={onExport} title="Graph exportieren">
            <Download className="w-3.5 h-3.5 text-apple-green" />
          </IconButton>
        )}

        <IconButton onClick={onOpenSettings} title="Einstellungen">
          <Settings className="w-3.5 h-3.5 text-apple-text-secondary" />
        </IconButton>
      </div>
    </header>
  );
};

const IconButton: React.FC<{ onClick: () => void; title: string; children: React.ReactNode }> = ({
  onClick,
  title,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className="flex h-7 w-7 items-center justify-center rounded-[4px] border border-transparent text-[#a0a0a0] transition-colors hover:bg-[#252525] hover:text-[#eeeeee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8]"
  >
    {children}
  </button>
);
