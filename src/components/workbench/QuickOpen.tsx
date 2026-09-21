import {
  Braces,
  Database,
  FileJson2,
  FileSpreadsheet,
  FolderSearch2,
  HardDrive,
  Network,
  Search,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Project, ProjectFileNode, ProjectNode } from '../../types/projects';
import type { OpenDisposition } from '../../workbench/model';

const MAX_VISIBLE_RESULTS = 80;
const EMPTY_PROJECTS: readonly Project[] = [];
const EMPTY_SOURCES: readonly QuickOpenSource[] = [];

/**
 * A flat source can carry the project context that would otherwise be inferred
 * while walking `projects`. The extra fields are presentation-only; `onOpen`
 * still receives an ordinary ProjectFileNode that can be passed directly to
 * the workbench controller.
 */
export interface QuickOpenSource extends ProjectFileNode {
  projectId?: string;
  projectName?: string;
  relativePath?: string;
}

export interface QuickOpenProps {
  visible: boolean;
  projects?: readonly Project[];
  sources?: readonly QuickOpenSource[];
  onClose: () => void;
  onOpen: (file: ProjectFileNode, disposition: OpenDisposition) => void;
}

export interface QuickOpenIndexedSource {
  file: ProjectFileNode;
  projectName: string | null;
  relativePath: string;
  searchName: string;
  searchPath: string;
  order: number;
}

export interface QuickOpenRankedSource extends QuickOpenIndexedSource {
  score: number;
}

const FILE_TYPE_LABELS: Partial<Record<NonNullable<ProjectFileNode['fileType']>, string>> = {
  graph: 'GRAPH',
  'phase-x-run': 'PHASE X',
  sqlite: 'SQLITE',
  csv: 'CSV',
  'json-table': 'JSON',
  excel: 'EXCEL',
  document: 'DOKUMENT',
  parquet: 'PARQUET',
  arrow: 'ARROW',
  duckdb: 'DUCKDB',
  connection: 'VERBINDUNG',
  'redis-rdb': 'RDB',
  'redis-aof': 'AOF',
};

/** Exposed for focused tests and future command-palette reuse. */
export function flattenQuickOpenSources(
  projects: readonly Project[] = [],
  sources: readonly QuickOpenSource[] = []
): QuickOpenIndexedSource[] {
  const indexed: QuickOpenIndexedSource[] = [];
  const seen = new Set<string>();

  const append = (
    file: ProjectFileNode,
    projectName: string | null,
    relativePath: string
  ) => {
    const key = file.path || file.id;
    if (seen.has(key)) return;
    seen.add(key);

    const cleanPath = normalizeDisplayPath(relativePath || file.name);
    indexed.push({
      file,
      projectName,
      relativePath: cleanPath,
      searchName: normalizeForSearch(file.name),
      searchPath: normalizeForSearch(`${projectName ?? ''} ${cleanPath}`),
      order: indexed.length,
    });
  };

  for (const project of projects) {
    walkProjectFiles(project.children, (file) => {
      append(file, project.name, relativePathFromProject(project.path, file.path));
    });
  }

  for (const source of sources) {
    append(
      source,
      source.projectName ?? null,
      source.relativePath ?? source.path ?? source.name
    );
  }

  return indexed;
}

/** Exposed so ranking can be regression-tested without mounting React. */
export function rankQuickOpenSources(
  sources: readonly QuickOpenIndexedSource[],
  query: string
): QuickOpenRankedSource[] {
  const tokens = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return sources
      .slice(0, MAX_VISIBLE_RESULTS)
      .map((source) => ({ ...source, score: 0 }));
  }

  const ranked: QuickOpenRankedSource[] = [];
  for (const source of sources) {
    let score = 0;
    let matches = true;

    for (const token of tokens) {
      const nameScore = fuzzyFieldScore(source.searchName, token, true);
      const pathScore = fuzzyFieldScore(source.searchPath, token, false);
      const tokenScore = Math.max(nameScore, pathScore);
      if (tokenScore < 0) {
        matches = false;
        break;
      }
      score += tokenScore;
    }

    if (matches) ranked.push({ ...source, score });
  }

  ranked.sort((left, right) => (
    right.score - left.score
      || left.file.name.localeCompare(right.file.name, undefined, { numeric: true })
      || left.order - right.order
  ));
  return ranked.slice(0, MAX_VISIBLE_RESULTS);
}

export const QuickOpen: FC<QuickOpenProps> = ({
  visible,
  projects = EMPTY_PROJECTS,
  sources = EMPTY_SOURCES,
  onClose,
  onOpen,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);
  const dialogTitleId = useId();
  const listboxId = useId();
  const optionIdPrefix = useId();
  const indexedSources = useMemo(
    () => flattenQuickOpenSources(projects, sources),
    [projects, sources]
  );
  const results = useMemo(
    () => rankQuickOpenSources(indexedSources, query),
    [indexedSources, query]
  );
  const selectedResult = results[selectedIndex] ?? null;

  useEffect(() => {
    if (!visible) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    restoreFocusRef.current = true;
    setQuery('');
    setSelectedIndex(0);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      if (restoreFocusRef.current && previous?.isConnected) {
        window.requestAnimationFrame(() => previous.focus());
      }
    };
  }, [visible]);

  useEffect(() => {
    if (selectedIndex < results.length) return;
    setSelectedIndex(Math.max(0, results.length - 1));
  }, [results.length, selectedIndex]);

  useLayoutEffect(() => {
    if (!visible || !selectedResult) return;
    const option = document.getElementById(optionId(optionIdPrefix, selectedIndex));
    option?.scrollIntoView({ block: 'nearest' });
  }, [optionIdPrefix, selectedIndex, selectedResult, visible]);

  if (!visible || typeof document === 'undefined') return null;

  const open = (result: QuickOpenIndexedSource, disposition: OpenDisposition) => {
    restoreFocusRef.current = false;
    onClose();
    onOpen(result.file, disposition);
  };

  const moveSelection = (delta: 1 | -1) => {
    if (results.length === 0) return;
    setSelectedIndex((current) => (current + delta + results.length) % results.length);
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === 'p') {
      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'Enter':
        if (!selectedResult) break;
        event.preventDefault();
        open(selectedResult, event.metaKey || event.ctrlKey ? 'new-tab' : 'current');
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case 'Tab':
        // The palette has one focus target; keep keyboard focus in the dialog.
        event.preventDefault();
        inputRef.current?.focus();
        break;
    }
  };

  const palette = (
    <div
      className="fixed inset-0 z-[160] flex justify-center bg-black/25 px-4 pt-[54px] sm:pt-[68px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        className="flex h-fit max-h-[min(560px,calc(100vh-92px))] w-full max-w-[700px] flex-col overflow-hidden rounded-[7px] border border-white/[0.15] bg-[#202122] text-[12px] text-[var(--cursor-text)] shadow-[0_18px_52px_rgba(0,0,0,0.58),0_1px_0_rgba(255,255,255,0.025)_inset]"
        onKeyDown={handleKeyDown}
      >
        <h2 id={dialogTitleId} className="sr-only">Datei schnell öffnen</h2>

        <div className="relative shrink-0 border-b border-white/[0.09] bg-[#1b1c1d] p-[6px]">
          <Search
            className="pointer-events-none absolute left-[17px] top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-[var(--cursor-text-muted)]"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={selectedResult ? optionId(optionIdPrefix, selectedIndex) : undefined}
            aria-label="Datei schnell öffnen"
            autoComplete="off"
            spellCheck={false}
            placeholder="Dateiname oder Pfad eingeben"
            className="h-[35px] w-full rounded-[4px] border border-[var(--cursor-focus)] bg-[#252729] pl-[34px] pr-16 text-[12.5px] text-[var(--cursor-text)] caret-[var(--cursor-blue)] shadow-[0_0_0_1px_rgba(130,172,211,0.08),0_1px_2px_rgba(0,0,0,0.3)_inset] outline-none placeholder:text-[var(--cursor-text-faint)]"
          />
          <kbd className="pointer-events-none absolute right-[14px] top-1/2 -translate-y-1/2 rounded-[3px] border border-white/[0.08] bg-white/[0.025] px-1.5 font-mono text-[9px] leading-[17px] text-[var(--cursor-text-faint)]">
            ⌘P
          </kbd>
        </div>

        <div className="flex h-[26px] shrink-0 items-center border-b border-white/[0.055] px-3 text-[9px] font-semibold uppercase tracking-[0.11em] text-[var(--cursor-text-faint)]">
          <span className="flex-1">Dateien</span>
          <span className="font-mono font-normal tracking-normal">
            {results.length}{indexedSources.length > MAX_VISIBLE_RESULTS && query === '' ? '+' : ''}
          </span>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Gefundene Dateien"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {results.map((result, index) => {
            const selected = index === selectedIndex;
            const Icon = iconForFile(result.file);
            const directory = directoryLabel(result.relativePath, result.file.name);
            const typeLabel = fileTypeLabel(result.file);

            return (
              <div
                key={`${result.file.id}:${result.file.path}`}
                id={optionId(optionIdPrefix, index)}
                role="option"
                aria-selected={selected}
                data-quick-open-path={result.file.path}
                className={`mx-1 flex h-[39px] cursor-default items-center gap-2 rounded-[3px] px-2 transition-colors ${
                  selected
                    ? 'bg-[rgba(130,172,211,0.18)] text-[var(--cursor-text)]'
                    : 'text-[var(--cursor-text-secondary)] hover:bg-white/[0.045]'
                }`}
                onPointerMove={() => setSelectedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => open(result, event.metaKey || event.ctrlKey ? 'new-tab' : 'current')}
              >
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-[4px] border border-white/[0.065] bg-black/[0.13] ${iconColor(result.file)}`}
                  aria-hidden="true"
                >
                  <Icon className="h-[13px] w-[13px]" strokeWidth={1.65} />
                </span>

                <span className="min-w-0 flex-1 leading-[15px]">
                  <span className="block truncate text-[11.5px]">
                    <HighlightedText text={result.file.name} query={query} />
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-[9.5px] text-[var(--cursor-text-faint)]">
                    {result.projectName && (
                      <span className="shrink-0 text-[var(--cursor-text-muted)]">{result.projectName}</span>
                    )}
                    {result.projectName && directory && <span aria-hidden="true">·</span>}
                    {directory && <span className="truncate font-mono">{directory}</span>}
                  </span>
                </span>

                <span className="shrink-0 rounded-[3px] border border-white/[0.055] bg-black/[0.08] px-1.5 font-mono text-[8px] leading-[16px] tracking-[0.035em] text-[var(--cursor-text-faint)]">
                  {typeLabel}
                </span>
              </div>
            );
          })}

          {results.length === 0 && (
            <div className="grid min-h-[150px] place-items-center px-5 py-8 text-center">
              <div>
                <FolderSearch2
                  className="mx-auto mb-2 h-5 w-5 text-[var(--cursor-text-faint)]"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <p className="text-[11.5px] text-[var(--cursor-text-muted)]">
                  {indexedSources.length === 0
                    ? 'Keine Datenquellen in den Projekten'
                    : `Keine Treffer für „${query}“`}
                </p>
                <p className="mt-1 text-[9.5px] text-[var(--cursor-text-faint)]">
                  Suche nach Dateiname, Projekt oder relativem Pfad.
                </p>
              </div>
            </div>
          )}
        </div>

        <footer className="flex h-[27px] shrink-0 items-center justify-end gap-3 border-t border-white/[0.065] bg-[#1b1c1d] px-2.5 text-[9px] text-[var(--cursor-text-faint)]">
          <ShortcutHint keys="↑↓" label="Auswählen" />
          <ShortcutHint keys="↵" label="Öffnen" />
          <ShortcutHint keys="⌘↵" label="Neuer Tab" />
          <ShortcutHint keys="Esc" label="Schließen" />
        </footer>
      </section>
    </div>
  );

  return createPortal(palette, document.body);
};

const ShortcutHint: FC<{ keys: string; label: string }> = ({ keys, label }) => (
  <span className="inline-flex items-center gap-1">
    <kbd className="rounded-[2px] border border-white/[0.075] bg-white/[0.025] px-1 font-mono leading-[15px] text-[var(--cursor-text-muted)]">
      {keys}
    </kbd>
    <span>{label}</span>
  </span>
);

const HighlightedText: FC<{ text: string; query: string }> = ({ text, query }) => {
  const ranges = substringMatchRanges(text, query);
  if (ranges.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={`${start}:${end}`} className="bg-transparent font-semibold text-[#aed0eb]">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};

function walkProjectFiles(nodes: readonly ProjectNode[], visit: (file: ProjectFileNode) => void): void {
  for (const node of nodes) {
    if (node.kind === 'file') visit(node);
    else walkProjectFiles(node.children, visit);
  }
}

function fuzzyFieldScore(haystack: string, needle: string, isName: boolean): number {
  if (needle.length === 0) return 0;
  const exactIndex = haystack.indexOf(needle);
  if (exactIndex >= 0) {
    const boundary = exactIndex === 0 || isBoundary(haystack[exactIndex - 1]);
    return (isName ? 620 : 310) + (boundary ? 90 : 0) - Math.min(exactIndex, 80);
  }

  let searchAt = 0;
  let first = -1;
  let previous = -2;
  let gaps = 0;
  let consecutive = 0;
  let boundaryHits = 0;

  for (const character of needle) {
    const index = haystack.indexOf(character, searchAt);
    if (index < 0) return -1;
    if (first < 0) first = index;
    if (index === previous + 1) consecutive += 1;
    else if (previous >= 0) gaps += index - previous - 1;
    if (index === 0 || isBoundary(haystack[index - 1])) boundaryHits += 1;
    previous = index;
    searchAt = index + 1;
  }

  return (isName ? 255 : 115)
    + consecutive * 16
    + boundaryHits * 22
    - gaps * 4
    - Math.min(first, 60);
}

function substringMatchRanges(text: string, query: string): Array<[number, number]> {
  const lowerText = text.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of query.toLocaleLowerCase().split(/\s+/).filter(Boolean)) {
    const start = lowerText.indexOf(token);
    if (start >= 0) ranges.push([start, start + token.length]);
  }
  ranges.sort((left, right) => left[0] - right[0]);

  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/\\/g, '/');
}

function normalizeDisplayPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function relativePathFromProject(projectPath: string, filePath: string): string {
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = filePath.replace(/\\/g, '/');
  if (path === root) return path.split('/').pop() ?? path;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return normalizeDisplayPath(path);
}

function directoryLabel(relativePath: string, filename: string): string {
  const path = normalizeDisplayPath(relativePath);
  if (path === filename || !path.includes('/')) return '';
  return path.slice(0, path.lastIndexOf('/'));
}

function optionId(prefix: string, index: number): string {
  return `${prefix.replace(/:/g, '')}-option-${index}`;
}

function isBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s/_.-]/.test(character);
}

function fileTypeLabel(file: ProjectFileNode): string {
  if (file.fileType === 'json-table') return (file.name.split('.').pop() || 'JSON').toUpperCase();
  if (file.fileType) return FILE_TYPE_LABELS[file.fileType] ?? file.fileType.toLocaleUpperCase();
  const extension = file.name.includes('.') ? file.name.split('.').pop() : null;
  return extension?.toLocaleUpperCase() ?? 'DATEI';
}

function iconForFile(file: ProjectFileNode) {
  switch (file.fileType) {
    case 'graph':
    case 'phase-x-run':
      return Network;
    case 'sqlite':
      return Database;
    case 'csv':
    case 'excel':
      return FileSpreadsheet;
    case 'json-table':
      return FileJson2;
    case 'redis-rdb':
    case 'redis-aof':
      return HardDrive;
    default:
      return Braces;
  }
}

function iconColor(file: ProjectFileNode): string {
  switch (file.fileType) {
    case 'graph':
    case 'phase-x-run':
      return 'text-[var(--cursor-purple)]';
    case 'redis-rdb':
    case 'redis-aof':
      return 'text-[var(--cursor-amber)]';
    default:
      return 'text-[var(--cursor-cyan)]';
  }
}
