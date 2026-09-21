import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Folder,
  FolderOpen,
  FolderPlus,
  FileJson2,
  FileSpreadsheet,
  Braces,
  Database,
  HardDrive,
  Layers3,
  Network,
  PanelTopOpen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { Project, ProjectFileNode, ProjectNode, walkFiles } from '../types/projects';
import { formatCount, formatRelativeTime } from '../lib/graph';
import { ContextMenu } from './ContextMenu';
import { useSidebarWidth } from '../hooks/useSidebarWidth';

export type OpenDisposition = 'current' | 'new-tab';

interface ProjectSidebarProps {
  projects: Project[];
  isCollapsed: boolean;
  hideCollapsedRail?: boolean;
  isBusy: boolean;
  isSupported: boolean;
  /** Path of the graph currently open, so it can be marked in the tree. */
  activePath: string | null;
  onToggleCollapsed: () => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onRefreshProject: (id: string) => void;
  onOpenFile: (file: ProjectFileNode, disposition?: OpenDisposition) => void;
}

/**
 * The project overview: folders the user added, scanned for graphs and complete
 * Phase-X runs below them, so a result can be opened by name instead of through
 * a file dialog.
 */
export const ProjectSidebar: React.FC<ProjectSidebarProps> = ({
  projects,
  isCollapsed,
  hideCollapsedRail = false,
  isBusy,
  isSupported,
  activePath,
  onToggleCollapsed,
  onAddProject,
  onRemoveProject,
  onRefreshProject,
  onOpenFile,
}) => {
  const [filter, setFilter] = useState('');
  const { width, isDragging, handleProps } = useSidebarWidth();

  const totalFiles = useMemo(
    () => projects.reduce((sum, project) => sum + project.fileCount, 0),
    [projects]
  );

  if (isCollapsed) {
    if (hideCollapsedRail) return null;

    return (
      <aside className="w-10 shrink-0 h-full flex flex-col items-center gap-1 py-2 bg-apple-panel border-r border-apple-border select-none">
        <button
          onClick={onToggleCollapsed}
          title="Projekte einblenden (⌘B)"
          className="p-1.5 rounded-lg text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        {totalFiles > 0 && (
          <span className="text-[10px] font-mono text-apple-text-muted tabular-nums">
            {totalFiles}
          </span>
        )}
      </aside>
    );
  }

  return (
    <aside
      className="project-sidebar relative shrink-0 h-full flex flex-col bg-[#141414] border-r border-[#2a2a2a] select-none"
      style={{ width }}
    >
      <div
        {...handleProps}
        role="separator"
        aria-orientation="vertical"
        title="Breite ziehen — Doppelklick setzt zurueck"
        className={`absolute top-0 right-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize transition-colors ${
          isDragging ? 'bg-white/20' : 'hover:bg-white/10'
        }`}
      />
      <header className="project-sidebar-header h-[35px] flex items-center gap-0.5 px-3 border-b border-white/[0.055] shrink-0">
        <h2 className="flex-1 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-[#c4c4c4]">
          Explorer
        </h2>

        {totalFiles > 0 && (
          <span className="project-sidebar-total mr-1 font-mono text-[9px] tabular-nums text-[#777777]" title={`${totalFiles} Datenquellen`}>
            {formatCount(totalFiles)}
          </span>
        )}

        <button
          onClick={onAddProject}
          disabled={isBusy || !isSupported}
          title="Ordner mit Graphen oder Phase-X-Läufen hinzufügen"
          className="h-6 w-6 grid place-items-center rounded-[3px] text-[#8f8f8f] hover:text-[#e7e7e7] hover:bg-white/[0.07] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        >
          <FolderPlus className="w-3.5 h-3.5" strokeWidth={1.7} />
        </button>

        <button
          onClick={onToggleCollapsed}
          title="Projekte ausblenden (⌘B)"
          className="h-6 w-6 grid place-items-center rounded-[3px] text-[#8f8f8f] hover:text-[#e7e7e7] hover:bg-white/[0.07] transition-colors"
        >
          <PanelLeftClose className="w-3.5 h-3.5" strokeWidth={1.7} />
        </button>
      </header>

      <div className="project-section-heading h-7 flex items-center gap-1 px-2 shrink-0">
        <ChevronDown className="w-3 h-3 text-[#858585]" strokeWidth={1.8} />
        <span className="flex-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#9b9b9b]">
          Projekte
        </span>
        <span className="font-mono text-[8.5px] tabular-nums text-[#696969]">{projects.length}</span>
      </div>

      {isSupported && (
        <div className="project-filter px-2 pb-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#777777] pointer-events-none" strokeWidth={1.8} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Datei filtern"
              aria-label="Projektdateien filtern"
              className="w-full h-[25px] bg-[#1b1b1b] border border-[#303030] rounded-[4px] pl-6 pr-2 text-[10.5px] text-[#d8d8d8] placeholder:text-[#707070] focus:outline-none focus:border-[#555555] transition-colors"
            />
          </div>
        </div>
      )}

      <div className="project-tree-scroll flex-1 overflow-y-auto min-h-0 pb-1">
        {!isSupported && (
          <p className="px-3 py-3 text-[11px] text-[#858585] leading-relaxed">
            Projektordner liest nur die App vom Dateisystem — im Browser-Entwicklungsmodus steht
            die Übersicht nicht zur Verfügung.
          </p>
        )}

        {isSupported && projects.length === 0 && (
          <div className="px-3 py-3">
            <p className="text-[11px] text-[#858585]">Noch kein Ordner.</p>
            <button
              onClick={onAddProject}
              disabled={isBusy}
              title="Ordner mit Graphen oder Phase-X-Läufen hinzufügen"
              className="mt-2 inline-flex h-6 items-center gap-1.5 px-2 rounded-[3px] text-[11px] text-[#c8c8c8] bg-white/[0.035] hover:bg-white/[0.075] border border-white/[0.07] disabled:opacity-40 transition-colors"
            >
              <FolderPlus className="w-3 h-3 text-[#9d9d9d]" strokeWidth={1.8} />
              Ordner hinzufügen
            </button>
          </div>
        )}

        {projects.map((project) => (
          <ProjectTree
            key={project.id}
            project={project}
            filter={filter.trim().toLowerCase()}
            activePath={activePath}
            onRemove={onRemoveProject}
            onRefresh={onRefreshProject}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </aside>
  );
};

const ProjectTree: React.FC<{
  project: Project;
  filter: string;
  activePath: string | null;
  onRemove: (id: string) => void;
  onRefresh: (id: string) => void;
  onOpenFile: (file: ProjectFileNode, disposition?: OpenDisposition) => void;
}> = ({ project, filter, activePath, onRemove, onRefresh, onOpenFile }) => {
  const rootExpansionKey = `project:${project.id}`;
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const displayChildren = useMemo(
    () => groupNumberedTableShards(project.children),
    [project.children]
  );
  const phaseXRunCount = useMemo(
    () => [...walkFiles(project.children)].filter(isPhaseXRunFile).length,
    [project.children]
  );
  const subtreeKeys = useMemo(
    () => [rootExpansionKey, ...collectFolderExpansionKeys(displayChildren)],
    [displayChildren, rootExpansionKey]
  );

  // Reloads and explicit refreshes both replace the project snapshot. Every
  // new snapshot starts compact, including paths containing Phase-X results.
  useEffect(() => {
    setExpandedFolders(new Set());
  }, [project]);

  const setSubtreeExpanded = (keys: readonly string[], shouldExpand: boolean) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (shouldExpand) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const isRootOpen = expandedFolders.has(rootExpansionKey);
  const isRootVisible = isRootOpen || filter !== '';
  const isEntireTreeOpen = subtreeKeys.every((key) => expandedFolders.has(key));

  // Filtering flattens the tree: with a search term the folder a file sits in
  // matters far less than finding the file at all.
  const matches = useMemo(() => {
    if (filter === '') return null;
    return [...walkFiles(project.children)].filter((file) =>
      file.name.toLowerCase().includes(filter)
    );
  }, [project.children, filter]);

  return (
    <section className="project-tree-section">
      <div
        className="project-tree-root group h-[25px] flex items-center gap-0.5 px-2 hover:bg-white/[0.04] transition-colors"
        data-project-path={project.path}
      >
        <button
          onClick={() => setSubtreeExpanded([rootExpansionKey], !isRootOpen)}
          className="flex-1 flex items-center gap-1.5 min-w-0 text-left"
          title={project.path}
          aria-label={`${project.name} ${isRootOpen ? 'einklappen' : 'ausklappen'}`}
          aria-expanded={isRootVisible}
          data-project-disclosure
        >
          {isRootVisible ? (
            <ChevronDown className="w-3 h-3 shrink-0 text-[#888888]" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0 text-[#888888]" strokeWidth={1.8} />
          )}
          {project.error ? (
            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-[#c9a26a]" strokeWidth={1.7} />
          ) : (
            isRootVisible ? (
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[#a2a2a2]" strokeWidth={1.6} />
            ) : (
              <Folder className="w-3.5 h-3.5 shrink-0 text-[#929292]" strokeWidth={1.6} />
            )
          )}
          <span className="flex-1 text-[10.8px] font-medium text-[#d0d0d0] truncate">
            {project.name}
          </span>
          {phaseXRunCount > 0 && (
            <span
              className="rounded-[2px] border border-white/[0.08] bg-white/[0.035] px-1 py-px text-[8px] font-medium uppercase tracking-[0.06em] text-[#898989]"
              title={`${phaseXRunCount} Phase-X-${phaseXRunCount === 1 ? 'Lauf' : 'Läufe'} in diesem Projekt`}
            >
              PX
            </span>
          )}
          <span className="text-[9px] font-mono text-[#6f6f6f] tabular-nums shrink-0">
            {matches ? matches.length : project.fileCount}
          </span>
        </button>

        <button
          onClick={() => setSubtreeExpanded(subtreeKeys, !isEntireTreeOpen)}
          title={isEntireTreeOpen ? 'Gesamtes Projekt einklappen' : 'Gesamtes Projekt ausklappen'}
          aria-label={`${project.name}: alles ${isEntireTreeOpen ? 'einklappen' : 'ausklappen'}`}
          className="h-[18px] w-[18px] grid place-items-center rounded-[2px] text-[#737373] opacity-60 hover:opacity-100 hover:text-[#dddddd] hover:bg-white/[0.07] focus-visible:opacity-100 transition-all shrink-0"
          data-project-subtree-toggle
        >
          {isEntireTreeOpen ? (
            <ChevronsUp className="w-3 h-3" strokeWidth={1.7} />
          ) : (
            <ChevronsDown className="w-3 h-3" strokeWidth={1.7} />
          )}
        </button>

        <button
          onClick={() => onRefresh(project.id)}
          title="Ordner neu einlesen"
          className="h-[18px] w-[18px] grid place-items-center rounded-[2px] text-[#777777] opacity-0 group-hover:opacity-100 hover:text-[#dddddd] hover:bg-white/[0.07] transition-all shrink-0"
        >
          <RefreshCw className="w-3 h-3" strokeWidth={1.7} />
        </button>
        <button
          onClick={() => onRemove(project.id)}
          title="Projekt entfernen (löscht keine Dateien)"
          className="h-[18px] w-[18px] grid place-items-center rounded-[2px] text-[#777777] opacity-0 group-hover:opacity-100 hover:text-[#d38c8c] hover:bg-white/[0.07] transition-all shrink-0"
        >
          <X className="w-3 h-3" strokeWidth={1.7} />
        </button>
      </div>

      {project.error && (
        <p className="px-3 pb-1.5 pl-7 text-[10px] text-[#c9a26a]">{project.error}</p>
      )}

      {isRootVisible &&
        (matches ? (
          matches.length === 0 ? (
            <p className="h-[22px] flex items-center px-3 pl-7 text-[10px] text-[#757575]">Kein Treffer.</p>
          ) : (
            matches.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                depth={1}
                isActive={file.path === activePath}
                onOpen={onOpenFile}
              />
            ))
          )
        ) : (
          <NodeList
            nodes={displayChildren}
            depth={1}
            activePath={activePath}
            onOpenFile={onOpenFile}
            expandedFolders={expandedFolders}
            onSetSubtreeExpanded={setSubtreeExpanded}
          />
        ))}
    </section>
  );
};

const NodeList: React.FC<{
  nodes: ProjectNode[];
  depth: number;
  activePath: string | null;
  onOpenFile: (file: ProjectFileNode, disposition?: OpenDisposition) => void;
  expandedFolders: ReadonlySet<string>;
  onSetSubtreeExpanded: (keys: readonly string[], shouldExpand: boolean) => void;
}> = ({ nodes, depth, activePath, onOpenFile, expandedFolders, onSetSubtreeExpanded }) => (
  <>
    {nodes.map((node) =>
      node.kind === 'file' ? (
        <FileRow
          key={node.id}
          file={node}
          depth={depth}
          isActive={node.path === activePath}
          onOpen={onOpenFile}
        />
      ) : (
        <FolderRow
          key={node.id}
          node={node}
          depth={depth}
          activePath={activePath}
          onOpenFile={onOpenFile}
          expandedFolders={expandedFolders}
          onSetSubtreeExpanded={onSetSubtreeExpanded}
        />
      )
    )}
  </>
);

const FolderRow: React.FC<{
  node: Extract<ProjectNode, { kind: 'folder' }>;
  depth: number;
  activePath: string | null;
  onOpenFile: (file: ProjectFileNode, disposition?: OpenDisposition) => void;
  expandedFolders: ReadonlySet<string>;
  onSetSubtreeExpanded: (keys: readonly string[], shouldExpand: boolean) => void;
}> = ({ node, depth, activePath, onOpenFile, expandedFolders, onSetSubtreeExpanded }) => {
  const expansionKey = folderExpansionKey(node);
  const subtreeKeys = useMemo(
    () => [expansionKey, ...collectFolderExpansionKeys(node.children)],
    [expansionKey, node.children]
  );
  const isOpen = expandedFolders.has(expansionKey);
  const isEntireSubtreeOpen = subtreeKeys.every((key) => expandedFolders.has(key));

  return (
    <>
      <div
        style={{ paddingLeft: 8 + depth * 12 }}
        className="sidebar-folder-row w-full h-[22px] flex items-center gap-0.5 pr-2 hover:bg-white/[0.04] transition-colors"
        title={node.path}
        data-folder-path={node.path}
        data-collection-pattern={node.collection?.pattern}
      >
        <button
          onClick={() => onSetSubtreeExpanded([expansionKey], !isOpen)}
          className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left"
          aria-label={`${node.name} ${isOpen ? 'einklappen' : 'ausklappen'}`}
          aria-expanded={isOpen}
          data-folder-disclosure
        >
          {isOpen ? (
            <ChevronDown className="w-3 h-3 shrink-0 text-[#777777]" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0 text-[#777777]" strokeWidth={1.8} />
          )}
          {node.collection ? (
            <Layers3 className="w-3 h-3 shrink-0 text-[#8caeae]" strokeWidth={1.6} />
          ) : isOpen ? (
            <FolderOpen className="w-3 h-3 shrink-0 text-[#909090]" strokeWidth={1.6} />
          ) : (
            <Folder className="w-3 h-3 shrink-0 text-[#858585]" strokeWidth={1.6} />
          )}
          <span className="flex-1 text-[11px] text-[#b8b8b8] truncate">{node.name}</span>
          {node.collection && (
            <span
              className="shrink-0 font-mono text-[9px] tabular-nums text-[#727f7f]"
              title={`${node.collection.partCount} Dateien · ${node.collection.pattern}`}
            >
              {node.collection.partCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onSetSubtreeExpanded(subtreeKeys, !isEntireSubtreeOpen)}
          title={isEntireSubtreeOpen ? 'Unterordner einklappen' : 'Unterordner ausklappen'}
          aria-label={`${node.name}: alles ${isEntireSubtreeOpen ? 'einklappen' : 'ausklappen'}`}
          className="h-[18px] w-[18px] grid place-items-center rounded-[2px] text-[#6f6f6f] opacity-60 hover:opacity-100 hover:text-[#d6d6d6] hover:bg-white/[0.07] focus-visible:opacity-100 transition-all shrink-0"
          data-folder-subtree-toggle
        >
          {isEntireSubtreeOpen ? (
            <ChevronsUp className="w-3 h-3" strokeWidth={1.7} />
          ) : (
            <ChevronsDown className="w-3 h-3" strokeWidth={1.7} />
          )}
        </button>
      </div>

      {isOpen && (
        <NodeList
          nodes={node.children}
          depth={depth + 1}
          activePath={activePath}
          onOpenFile={onOpenFile}
          expandedFolders={expandedFolders}
          onSetSubtreeExpanded={onSetSubtreeExpanded}
        />
      )}
    </>
  );
};

function folderExpansionKey(node: Extract<ProjectNode, { kind: 'folder' }>): string {
  return `folder:${node.id}`;
}

function collectFolderExpansionKeys(nodes: ProjectNode[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    keys.push(folderExpansionKey(node), ...collectFolderExpansionKeys(node.children));
  }
  return keys;
}

const MIN_NUMBERED_SHARDS = 4;

/**
 * Collapses sibling JSON-array shards into logical Explorer collections while
 * preserving every real file node for opening, filtering and context menus.
 * Nothing is renamed or rewritten on disk.
 */
function groupNumberedTableShards(nodes: ProjectNode[]): ProjectNode[] {
  const nested = nodes.map((node): ProjectNode => (
    node.kind === 'folder'
      ? { ...node, children: groupNumberedTableShards(node.children) }
      : node
  ));

  const candidates = new Map<string, ProjectFileNode[]>();
  for (const node of nested) {
    if (node.kind !== 'file' || node.fileType !== 'json-table') continue;
    const match = /^(.+?)[_-](\d{2,})\.json$/i.exec(node.name);
    if (!match) continue;
    const key = match[1].toLocaleLowerCase();
    const group = candidates.get(key) ?? [];
    group.push(node);
    candidates.set(key, group);
  }

  const groupedKeys = new Set(
    [...candidates.entries()]
      .filter(([, files]) => files.length >= MIN_NUMBERED_SHARDS)
      .map(([key]) => key)
  );
  if (groupedKeys.size === 0) return nested;

  const emitted = new Set<string>();
  const result: ProjectNode[] = [];
  for (const node of nested) {
    if (node.kind !== 'file' || node.fileType !== 'json-table') {
      result.push(node);
      continue;
    }
    const match = /^(.+?)[_-](\d{2,})\.json$/i.exec(node.name);
    const key = match?.[1].toLocaleLowerCase();
    if (!key || !groupedKeys.has(key)) {
      result.push(node);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);

    const parts = candidates.get(key) ?? [];
    const label = match?.[1] ?? key;
    const parentPath = node.path.slice(0, Math.max(0, node.path.lastIndexOf('/')));
    result.push({
      kind: 'folder',
      id: `collection:${parentPath}:${key}`,
      name: label,
      path: `${parentPath}/${label}_*.json`,
      children: parts,
      collection: {
        partCount: parts.length,
        pattern: `${label}_*.json`,
      },
    });
  }
  return result;
}

const FileRow: React.FC<{
  file: ProjectFileNode;
  depth: number;
  isActive: boolean;
  onOpen: (file: ProjectFileNode, disposition?: OpenDisposition) => void;
}> = ({ file, depth, isActive, onOpen }) => {
  const Icon = iconForFile(file);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    anchor: HTMLButtonElement;
  } | null>(null);

  const openContextMenu = (
    event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    const pointerEvent = 'clientX' in event ? event : null;
    const hasPointerPosition = pointerEvent !== null && (pointerEvent.clientX !== 0 || pointerEvent.clientY !== 0);
    setContextMenu({
      x: hasPointerPosition ? pointerEvent.clientX : rect.left + 18,
      y: hasPointerPosition ? pointerEvent.clientY : rect.top + Math.min(rect.height, 20),
      anchor,
    });
  };

  return (
    <>
      <button
        data-source-path={file.path}
        onClick={() => onOpen(file, 'current')}
        onContextMenu={openContextMenu}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            openContextMenu(event);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={contextMenu !== null}
        style={{ paddingLeft: 8 + depth * 12 + 12 }}
        title={`${file.path}\n${formatBytes(file.size)}${
          file.modified ? ` · geändert ${formatRelativeTime(new Date(file.modified).toISOString())}` : ''
        }`}
        className={`sidebar-file-row w-full h-[22px] flex items-center gap-1.5 pr-2 transition-colors text-left ${
          isActive ? 'is-active bg-[#2a2d2e] text-[#f0f0f0]' : 'hover:bg-white/[0.04]'
        }`}
      >
        <Icon
          className={`w-3 h-3 shrink-0 ${isActive ? 'text-[#c5c5c5]' : colourForFile(file)}`}
          strokeWidth={1.7}
        />
        <span
          className={`flex-1 text-[11px] truncate ${
            isActive ? 'text-[#f0f0f0]' : 'text-[#c6c6c6]'
          }`}
        >
          {file.name}
        </span>
      </button>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          anchor={contextMenu.anchor}
          ariaLabel={`Aktionen für ${file.name}`}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'In neuem Tab öffnen',
              icon: <PanelTopOpen className="w-3.5 h-3.5" strokeWidth={1.6} />,
              onSelect: () => onOpen(file, 'new-tab'),
            },
          ]}
        />
      )}
    </>
  );
};

function isPhaseXRunFile(file: ProjectFileNode): boolean {
  return file.fileType === 'phase-x-run' || /\.amqrun(?:\.json)?$/i.test(file.name);
}

function iconForFile(file: ProjectFileNode) {
  switch (file.fileType) {
    case 'sqlite': return Database;
    case 'csv':
    case 'excel': return FileSpreadsheet;
    case 'json-table':
    case 'document':
    case 'connection': return Braces;
    case 'parquet':
    case 'arrow':
    case 'duckdb': return FileSpreadsheet;
    case 'redis-rdb':
    case 'redis-aof': return HardDrive;
    case 'phase-x-run': return FileJson2;
    default: return Network;
  }
}

function colourForFile(file: ProjectFileNode): string {
  switch (file.fileType) {
    case 'sqlite': return 'text-[#86a8ca]';
    case 'csv':
    case 'excel': return 'text-[#7fa98b]';
    case 'json-table':
    case 'document':
    case 'connection': return 'text-[#8caeae]';
    case 'parquet':
    case 'arrow':
    case 'duckdb': return 'text-[#7fa98b]';
    case 'redis-rdb':
    case 'redis-aof': return 'text-[#b5a078]';
    case 'phase-x-run': return 'text-[#91a68e]';
    default: return 'text-[#9d91ad]';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
