import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Database,
  FileJson,
  FileSpreadsheet,
  FolderOpen,
  FolderPlus,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Project, ProjectFileNode, ProjectNode } from '../types/projects';
import { FileFormat } from '../services/importers';
import { formatBytes } from '../lib/sql';

/** One icon and label per supported format, so the tree says what a file is. */
const FORMAT_STYLE: Record<FileFormat, { icon: React.ReactNode; label: string; tint: string }> = {
  document: { icon: <FileJson className="w-3.5 h-3.5" />, label: 'Dokument', tint: 'text-apple-cyan/80' },
  parquet: { icon: <Database className="w-3.5 h-3.5" />, label: 'Parquet', tint: 'text-apple-blue/80' },
  arrow: { icon: <Database className="w-3.5 h-3.5" />, label: 'Arrow', tint: 'text-apple-blue/80' },
  duckdb: { icon: <Database className="w-3.5 h-3.5" />, label: 'DuckDB', tint: 'text-apple-blue/80' },
  connection: { icon: <Database className="w-3.5 h-3.5" />, label: 'Verbindung', tint: 'text-apple-green/80' },
  sqlite: { icon: <Database className="w-3.5 h-3.5" />, label: 'SQLite', tint: 'text-apple-blue/80' },
  csv: { icon: <FileSpreadsheet className="w-3.5 h-3.5" />, label: 'CSV', tint: 'text-apple-green/80' },
  json: { icon: <FileJson className="w-3.5 h-3.5" />, label: 'JSON', tint: 'text-apple-amber/80' },
  xlsx: { icon: <FileSpreadsheet className="w-3.5 h-3.5" />, label: 'Excel', tint: 'text-apple-cyan/80' },
};

interface ProjectSidebarProps {
  projects: Project[];
  enabledFormats: Set<FileFormat>;
  onToggleFormat: (format: FileFormat) => void;
  activeFileId: string | null;
  isCollapsed: boolean;
  isBusy: boolean;
  /** False in the browser fallback, where projects live only for this session. */
  isPersistent: boolean;
  onToggleCollapsed: () => void;
  onAddProject: () => void;
  onRemoveProject: (projectId: string) => void;
  onRefreshProject: (projectId: string) => void;
  onOpenFile: (file: ProjectFileNode) => void;
}

const INDENT_PER_LEVEL = 12;

/** How many files of each format a project contributes, for the filter chips. */
function countFormats(nodes: ProjectNode[], into: Map<FileFormat, number>): Map<FileFormat, number> {
  for (const node of nodes) {
    if (node.kind === 'file') {
      into.set(node.format, (into.get(node.format) ?? 0) + 1);
    } else {
      countFormats(node.children, into);
    }
  }
  return into;
}

/** Drops files of disabled formats and any folder left empty by that. */
function filterFormats(nodes: ProjectNode[], enabled: Set<FileFormat>): ProjectNode[] {
  const result: ProjectNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (enabled.has(node.format)) result.push(node);
      continue;
    }
    const children = filterFormats(node.children, enabled);
    if (children.length > 0) result.push({ ...node, children });
  }
  return result;
}

/** Keeps only the nodes whose name — or a descendant's name — matches. */
function filterTree(nodes: ProjectNode[], needle: string): ProjectNode[] {
  if (!needle) return nodes;
  const result: ProjectNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (node.name.toLowerCase().includes(needle)) result.push(node);
      continue;
    }
    const children = filterTree(node.children, needle);
    if (children.length > 0 || node.name.toLowerCase().includes(needle)) {
      result.push({ ...node, children });
    }
  }
  return result;
}

function collectFolderIds(nodes: ProjectNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      into.add(node.id);
      collectFolderIds(node.children, into);
    }
  }
  return into;
}

interface TreeProps {
  nodes: ProjectNode[];
  level: number;
  expanded: Set<string>;
  activeFileId: string | null;
  onToggleFolder: (id: string) => void;
  onOpenFile: (file: ProjectFileNode) => void;
}

const Tree: React.FC<TreeProps> = ({
  nodes,
  level,
  expanded,
  activeFileId,
  onToggleFolder,
  onOpenFile,
}) => (
  <ul role="group" className="space-y-px">
    {nodes.map((node) => {
      const indent = { paddingLeft: `${8 + level * INDENT_PER_LEVEL}px` };

      if (node.kind === 'folder') {
        const isOpen = expanded.has(node.id);
        return (
          <li key={node.id} role="treeitem" aria-expanded={isOpen}>
            <button
              onClick={() => onToggleFolder(node.id)}
              style={indent}
              className="w-full flex items-center gap-1.5 pr-2 py-1 rounded-md text-xs text-apple-text-secondary hover:text-white hover:bg-white/[0.05] transition-colors"
            >
              <ChevronRight
                className={`w-3 h-3 shrink-0 text-apple-text-tertiary transition-transform ${
                  isOpen ? 'rotate-90' : ''
                }`}
              />
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-apple-amber/80" />
              <span className="truncate">{node.name}</span>
            </button>
            {isOpen && (
              <Tree
                nodes={node.children}
                level={level + 1}
                expanded={expanded}
                activeFileId={activeFileId}
                onToggleFolder={onToggleFolder}
                onOpenFile={onOpenFile}
              />
            )}
          </li>
        );
      }

      const isActive = activeFileId === node.id;
      const style = FORMAT_STYLE[node.format] ?? FORMAT_STYLE.sqlite;
      return (
        <li key={node.id} role="treeitem" aria-selected={isActive}>
          <button
            onClick={() => onOpenFile(node)}
            title={
              `${node.path}\n${style.label} · ${formatBytes(node.size)}` +
              (node.pendingWal
                ? '\n\nAchtung: Es liegt eine gefüllte -wal-Datei daneben. Die Ansicht zeigt den Stand ohne diese noch nicht eingearbeiteten Änderungen.'
                : '')
            }
            style={indent}
            className={`w-full flex items-center gap-1.5 pr-2 py-1 rounded-md text-xs transition-colors ${
              isActive
                ? 'bg-apple-blue text-white font-medium shadow-sm'
                : 'text-apple-text-secondary hover:text-white hover:bg-white/[0.05]'
            }`}
          >
            <span className="w-3 shrink-0" />
            <span className={`shrink-0 ${isActive ? 'text-white' : style.tint}`}>{style.icon}</span>
            <span className="truncate flex-1 text-left">{node.name}</span>
            {node.pendingWal && (
              <AlertTriangle
                aria-label="Nicht eingearbeitete WAL-Änderungen"
                className={`w-3 h-3 shrink-0 ${isActive ? 'text-white' : 'text-apple-amber'}`}
              />
            )}
            <span
              className={`text-[10px] font-mono shrink-0 ${
                isActive ? 'text-white/70' : 'text-apple-text-muted'
              }`}
            >
              {formatBytes(node.size)}
            </span>
          </button>
        </li>
      );
    })}
  </ul>
);

export const ProjectSidebar: React.FC<ProjectSidebarProps> = ({
  projects,
  enabledFormats,
  onToggleFormat,
  activeFileId,
  isCollapsed,
  isBusy,
  isPersistent,
  onToggleCollapsed,
  onAddProject,
  onRemoveProject,
  onRefreshProject,
  onOpenFile,
}) => {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const needle = filter.trim().toLowerCase();

  const formatCounts = useMemo(
    () => countFormats(projects.flatMap((project) => project.children), new Map()),
    [projects]
  );

  const visibleProjects = useMemo(
    () =>
      projects.map((project) => {
        const byFormat = filterFormats(project.children, enabledFormats);
        return {
          ...project,
          children: filterTree(byFormat, needle),
          visibleCount: [...countFormats(byFormat, new Map()).values()].reduce(
            (total, count) => total + count,
            0
          ),
        };
      }),
    [projects, enabledFormats, needle]
  );

  // While filtering, every remaining folder is opened so matches are visible
  // without clicking through the hierarchy.
  const effectiveExpanded = useMemo(() => {
    if (!needle) return expanded;
    return collectFolderIds(
      visibleProjects.flatMap((project) => project.children),
      new Set(expanded)
    );
  }, [needle, expanded, visibleProjects]);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const toggleProject = useCallback((id: string) => {
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  // Newly added projects start expanded down to their first level.
  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const project of projects) {
        for (const child of project.children) {
          if (child.kind === 'folder' && !previous.has(child.id)) next.add(child.id);
        }
      }
      return next;
    });
  }, [projects]);

  if (isCollapsed) {
    return (
      <div className="w-11 h-full shrink-0 border-r border-white/[0.08] bg-[#0D0F16] flex flex-col items-center py-3 gap-2 select-none">
        <button
          onClick={onToggleCollapsed}
          title="Projekte einblenden (⌘B)"
          aria-label="Projekte einblenden"
          className="p-1.5 rounded-lg text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button
          onClick={onAddProject}
          title="Projektordner hinzufügen"
          aria-label="Projektordner hinzufügen"
          className="p-1.5 rounded-lg text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <FolderPlus className="w-4 h-4" />
        </button>
        {projects.length > 0 && (
          <span className="mt-1 text-[10px] font-mono text-apple-text-muted" title="Projekte">
            {projects.length}
          </span>
        )}
      </div>
    );
  }

  return (
    <aside className="w-60 h-full shrink-0 border-r border-white/[0.08] bg-[#0D0F16] flex flex-col overflow-hidden select-none">
      <div className="h-10 px-2 pl-3 flex items-center justify-between border-b border-white/[0.06] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary">
          Projekte
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onAddProject}
            disabled={isBusy}
            title="Projektordner hinzufügen"
            aria-label="Projektordner hinzufügen"
            className="p-1.5 rounded-md text-apple-text-secondary hover:text-white hover:bg-white/[0.08] disabled:opacity-40 transition-colors"
          >
            {isBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FolderPlus className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={onToggleCollapsed}
            title="Projekte ausblenden (⌘B)"
            aria-label="Projekte ausblenden"
            className="p-1.5 rounded-md text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {projects.length > 0 && formatCounts.size > 0 && (
        <div className="px-2 pt-2 flex flex-wrap gap-1 shrink-0">
          {(Object.keys(FORMAT_STYLE) as FileFormat[])
            .filter((format) => formatCounts.has(format))
            .map((format) => {
              const isOn = enabledFormats.has(format);
              return (
                <button
                  key={format}
                  onClick={() => onToggleFormat(format)}
                  aria-pressed={isOn}
                  title={`${FORMAT_STYLE[format].label}-Dateien ${isOn ? 'ausblenden' : 'einblenden'}`}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] border transition-colors ${
                    isOn
                      ? 'bg-white/[0.08] border-white/[0.14] text-white'
                      : 'bg-transparent border-white/[0.06] text-apple-text-muted hover:text-apple-text-secondary'
                  }`}
                >
                  <span>{FORMAT_STYLE[format].label}</span>
                  <span className="font-mono opacity-70">{formatCounts.get(format)}</span>
                </button>
              );
            })}
        </div>
      )}

      {projects.length > 0 && (
        <div className="p-2 border-b border-white/[0.06] shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-apple-text-tertiary pointer-events-none" />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Dateien filtern…"
              aria-label="Dateien filtern"
              className="w-full bg-[#161822] text-xs text-apple-text-primary pl-8 pr-7 py-1.5 rounded-lg border border-white/[0.08] focus:border-apple-blue/60 focus:outline-none placeholder:text-apple-text-muted transition-colors"
            />
            {filter && (
              <button
                onClick={() => setFilter('')}
                aria-label="Filter zurücksetzen"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-apple-text-muted hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 space-y-3" role="tree" aria-label="Projekte">
        {projects.length === 0 ? (
          <div className="px-2 py-8 text-center space-y-3">
            <FolderPlus className="w-7 h-7 mx-auto text-white/15" />
            <p className="text-xs text-apple-text-tertiary leading-relaxed">
              Füge einen Ordner hinzu – Vektor zeigt daraus nur die Datendateien
              (SQLite, CSV, JSON, Excel), in der Ordnerstruktur des Originals.
            </p>
            <button
              onClick={onAddProject}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs text-white transition-colors disabled:opacity-40"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Ordner hinzufügen</span>
            </button>
          </div>
        ) : (
          visibleProjects.map((project) => {
            const isProjectOpen = !collapsedProjects.has(project.id);
            const hasMatches = project.children.length > 0;
            return (
              <div key={project.id}>
                <div className="group flex items-center gap-1 pr-1 rounded-md hover:bg-white/[0.04] transition-colors">
                  <button
                    onClick={() => toggleProject(project.id)}
                    title={project.path}
                    className="flex-1 flex items-center gap-1.5 px-1.5 py-1 min-w-0 text-left"
                  >
                    <ChevronRight
                      className={`w-3 h-3 shrink-0 text-apple-text-tertiary transition-transform ${
                        isProjectOpen ? 'rotate-90' : ''
                      }`}
                    />
                    <span className="text-xs font-semibold text-white truncate">{project.name}</span>
                    <span className="text-[10px] font-mono text-apple-text-muted shrink-0">
                      {project.visibleCount}
                    </span>
                  </button>

                  <button
                    onClick={() => onRefreshProject(project.id)}
                    title="Ordner neu einlesen"
                    aria-label={`${project.name} neu einlesen`}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-apple-text-tertiary hover:text-white transition-opacity"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => onRemoveProject(project.id)}
                    title="Projekt aus der Liste entfernen (Dateien bleiben erhalten)"
                    aria-label={`${project.name} entfernen`}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-apple-text-tertiary hover:text-apple-red transition-opacity"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {project.error && (
                  <p className="px-2 py-1 text-[11px] text-apple-red leading-relaxed">
                    {project.error}
                  </p>
                )}

                {isProjectOpen &&
                  (hasMatches ? (
                    <Tree
                      nodes={project.children}
                      level={1}
                      expanded={effectiveExpanded}
                      activeFileId={activeFileId}
                      onToggleFolder={toggleFolder}
                      onOpenFile={onOpenFile}
                    />
                  ) : (
                    <p className="px-3 py-1.5 text-[11px] text-apple-text-muted italic">
                      {needle ? 'Kein Treffer' : 'Keine Datendateien gefunden'}
                    </p>
                  ))}
              </div>
            );
          })
        )}
      </div>

      {!isPersistent && projects.length > 0 && (
        <p className="px-3 py-2 border-t border-white/[0.06] text-[10px] text-apple-text-muted leading-relaxed shrink-0">
          Im Browser gelten Projekte nur für diese Sitzung. In der macOS-App bleiben sie erhalten.
        </p>
      )}
    </aside>
  );
};
