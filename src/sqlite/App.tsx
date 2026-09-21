import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dbEngine } from './services/dbEngine';
import {
  announceReady,
  onNativeFileOpened,
  requestNativeOpenDialog,
} from './services/nativeHost';
import { ActiveTab, DatabaseMetadata } from './types/sqlite';
import { Notice } from './components/NoticeBanner';
import { TableStudioView } from './components/TableStudioView';
import { useWindowDrag } from './hooks/useWindowDrag';
import type { ProjectFileNode } from './types/projects';
import { detectFormat, FILE_INPUT_ACCEPT, importTables } from './services/importers';
import {
  installApiHandler,
  reportDatabaseChanged,
  setDatabaseChangedHandler,
  setOpenPathHandler,
} from './services/api/host';
import { readFileAtPath } from './services/nativeHost';
import { files as databaseFiles } from '../services/nativeHost';
import type { WorkspaceDisposeEvent } from '../workbench/model';
import type { DataBrowserNavigationFilter } from './components/DataBrowser';
import type { ForeignKeyNavigationTarget } from './components/RelationalDataGrid';
import type { MergeFilesReport } from './components/MergeFilesModal';
import type { ImportedTable } from './services/importers';
import { parseSourceDocument, type SourceDocument } from './services/importers/documents';

const StandaloneTableStudioView = lazy(async () => ({
  default: (await import('./components/StandaloneTableStudioView')).StandaloneTableStudioView,
}));

/**
 * Opens a file by its format: SQLite databases go straight into the engine,
 * everything else is imported into an in-memory database first.
 */
async function openAsDatabase(
  buffer: ArrayBuffer,
  filename: string,
  shouldAdopt: () => boolean = () => true
): Promise<DatabaseMetadata | null> {
  const format = detectFormat(filename);
  if (format === null || format === 'sqlite') {
    return dbEngine.loadDatabase(buffer, filename, shouldAdopt);
  }
  const bytes = new Uint8Array(buffer);
  const document = format === 'json' || format === 'document' ? parseSourceDocument(bytes, filename) : null;
  const tables = await importTables(bytes, filename, format);
  if (!shouldAdopt()) return null;
  const metadata = await dbEngine.loadTables(tables, filename, bytes.byteLength, shouldAdopt);
  if (metadata) dbEngine.sourceDocument = document;
  return metadata;
}

export interface TableStudioProps {
  embedded?: boolean;
  requestedPath?: string | null;
  requestVersion?: number;
  sourceSessionKey?: string;
  editorTabId?: string;
  requestedTableName?: string;
  disposeEvent?: WorkspaceDisposeEvent;
  active?: boolean;
  pendingWal?: boolean;
  onRequestOpen?: () => void;
  onSourceIntent?: () => void;
  onSourceChanged?: (source: { name: string; path: string | null; pendingWal?: boolean }) => void;
  /** Makes an API/MCP-opened database visible in its real root editor tab. */
  onExternalOpen?: () => void;
  onOpenTableInNewTab?: (tableName: string) => void;
  /** Reports when the adapter's API and file-open handlers are live. */
  onReadyChange?: (ready: boolean) => void;
  /** Mirrors unsaved changes into the owning root editor tab. */
  onDirtyChange?: (dirty: boolean) => void;
}

export const TableStudio: React.FC<TableStudioProps> = ({
  embedded = false,
  requestedPath = null,
  requestVersion = 0,
  sourceSessionKey,
  editorTabId,
  requestedTableName,
  disposeEvent,
  active = true,
  pendingWal = false,
  onRequestOpen,
  onSourceIntent,
  onSourceChanged,
  onExternalOpen,
  onOpenTableInNewTab,
  onReadyChange,
  onDirtyChange,
}) => {
  const [metadata, setMetadata] = useState<DatabaseMetadata | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('data');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [navigationFilter, setNavigationFilter] = useState<DataBrowserNavigationFilter>();
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Bumped whenever the data or schema changed, to invalidate cached views. */
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  /** Which project file is currently open, for highlighting it in the tree. */
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Only the newest open intent may replace the shared sql.js database. */
  const loadIntent = useRef(0);
  const tableFocusByTab = useRef(new Map<string, string>());
  const activeSourceSession = useRef<string | null>(null);
  const sourceSessions = useRef(new Map<string, { bytes: Uint8Array; filename: string; document: SourceDocument | null; sourceInfo: Record<string, string> }>());
  const dirtySessions = useRef(new Set<string>());
  // `POST /open` adopts the database before the root tab descriptor catches up.
  // Remember that hand-off so the following prop update cannot save the newly
  // opened database under the previous tab's session key.
  const directSourceAdoption = useRef<{ path: string; filename: string } | null>(null);
  const reportError = useCallback(
    (message: string) => setNotice({ tone: 'error', message }),
    []
  );
  const setCurrentDirty = useCallback((dirty: boolean) => {
    const session = activeSourceSession.current ?? sourceSessionKey;
    if (session) {
      if (dirty) dirtySessions.current.add(session);
      else dirtySessions.current.delete(session);
    }
    setIsDirty(dirty);
  }, [sourceSessionKey]);
  /** The table actually shown — falls back to the first one if the selection is gone. */
  const activeTable = useMemo(() => {
    if (!metadata || metadata.tables.length === 0) return null;
    const stillExists = metadata.tables.some((t) => t.name === selectedTable);
    return stillExists ? selectedTable : metadata.tables[0].name;
  }, [metadata, selectedTable]);

  const adoptMetadata = useCallback((meta: DatabaseMetadata) => {
    setMetadata(meta);
    setSelectedTable(meta.tables[0]?.name ?? null);
    setSchemaVersion((version) => version + 1);
    setActiveTab('data');
  }, []);

  const openDatabase = useCallback(
    async (
      load: (isCurrent: () => boolean) => Promise<DatabaseMetadata | null>,
      expectedIntent?: number
    ): Promise<DatabaseMetadata | null> => {
      const intent = expectedIntent ?? ++loadIntent.current;
      const isCurrent = () => intent === loadIntent.current;
      if (!isCurrent()) return null;
      setIsLoading(true);
      setNotice(null);
      try {
        const opened = await load(isCurrent);
        if (!opened || !isCurrent()) return null;
        adoptMetadata(opened);
        return opened;
      } catch (err: any) {
        if (isCurrent()) reportError(err?.message || String(err));
        return null;
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    },
    [adoptMetadata, reportError]
  );

  const handleFile = useCallback(
    async (file: File) => {
      onSourceIntent?.();
      setActiveFileId(null);
      const opened = await openDatabase(async (isCurrent) =>
        openAsDatabase(await file.arrayBuffer(), file.name, isCurrent)
      );
      if (opened) {
        activeSourceSession.current = null;
        setIsDirty(false);
        onSourceChanged?.({ name: opened.filename, path: null });
      }
    },
    [onSourceChanged, onSourceIntent, openDatabase]
  );

  const handleOpenProjectFile = useCallback(
    async (
      file: ProjectFileNode,
      readProjectFile: (file: ProjectFileNode) => Promise<ArrayBuffer>
    ) => {
      onSourceIntent?.();
      setActiveFileId(file.id);
      const opened = await openDatabase(async (isCurrent) =>
        openAsDatabase(await readProjectFile(file), file.name, isCurrent)
      );
      if (opened) {
        activeSourceSession.current = file.path;
        dirtySessions.current.delete(file.path);
        setIsDirty(false);
        onSourceChanged?.({ name: opened.filename, path: file.path, pendingWal: file.pendingWal });
      }

      // Committed changes in a `-wal` sidecar are invisible to the in-memory
      // reader, so say so instead of quietly showing an older state.
      if (opened && file.pendingWal) {
        setNotice({
          tone: 'warning',
          message:
            `Neben "${file.name}" liegt eine gefüllte -wal-Datei. Diese Ansicht zeigt den Stand ohne die darin noch nicht eingearbeiteten Änderungen. ` +
            'Schließe das schreibende Programm oder führe ein Checkpoint aus, um den aktuellen Stand zu sehen.',
        });
      }
    },
    [onSourceChanged, onSourceIntent, openDatabase]
  );

  useEffect(() => {
    if (!disposeEvent) return;
    tableFocusByTab.current.delete(disposeEvent.tabId);
    if (!disposeEvent.releaseSession) return;
    sourceSessions.current.delete(disposeEvent.sessionKey);
    dirtySessions.current.delete(disposeEvent.sessionKey);
    if (!disposeEvent.unloadActive) return;

    // Closing the owning root tab is a real lifecycle boundary. Cancel any
    // staged import and make the canonical API report no open database.
    loadIntent.current += 1;
    directSourceAdoption.current = null;
    activeSourceSession.current = null;
    dbEngine.close();
    setMetadata(null);
    setSelectedTable(null);
    setActiveFileId(null);
    setIsLoading(false);
    setNotice(null);
    setIsDirty(false);
    setSchemaVersion((version) => version + 1);
    reportDatabaseChanged();
  }, [disposeEvent]);

  useEffect(() => {
    if (!requestedPath) return;
    const intent = ++loadIntent.current;
    let cancelled = false;
    const targetSession = sourceSessionKey ?? requestedPath;
    const directlyAdopted = directSourceAdoption.current;
    if (
      directlyAdopted?.path === requestedPath
      && dbEngine.isLoaded()
      && dbEngine.getFilename() === directlyAdopted.filename
    ) {
      directSourceAdoption.current = null;
      activeSourceSession.current = targetSession;
      setIsDirty(dirtySessions.current.has(targetSession));
      setActiveFileId(requestedPath);
      return;
    }
    // A different root-level source superseded the pending hand-off.
    directSourceAdoption.current = null;
    const previousSession = activeSourceSession.current;
    if (previousSession && previousSession !== targetSession && dbEngine.isLoaded()) {
      sourceSessions.current.set(previousSession, {
        bytes: dbEngine.exportDatabase(),
        filename: dbEngine.getFilename(),
        document: dbEngine.sourceDocument,
        sourceInfo: dbEngine.sourceInfo,
      });
    }

    const restore = previousSession !== targetSession
      ? sourceSessions.current.get(targetSession)
      : undefined;
    const load = restore
      ? openDatabase(
          async (isCurrent) => {
            const meta = await dbEngine.loadDatabase(restore.bytes, restore.filename, isCurrent);
            if (meta) { dbEngine.sourceDocument = restore.document; dbEngine.sourceInfo = restore.sourceInfo; }
            return meta;
          },
          intent
        )
      : databaseFiles.stage(requestedPath).then(async (staged) => {
          const response = await fetch(staged.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          if (cancelled || intent !== loadIntent.current) return null;
          return openDatabase(
            (isCurrent) => openAsDatabase(buffer, staged.name, isCurrent),
            intent
          );
        });

    void load
      .then((opened) => {
        if (!opened || cancelled || intent !== loadIntent.current) return;
        activeSourceSession.current = targetSession;
        setIsDirty(dirtySessions.current.has(targetSession));
        setActiveFileId(requestedPath);
        onSourceChanged?.({ name: opened.filename, path: requestedPath, pendingWal });
        if (pendingWal) {
          setNotice({
            tone: 'warning',
            message:
              `Neben "${opened.filename}" liegt eine gefüllte -wal-Datei. Diese Ansicht zeigt den Stand ohne die darin noch nicht eingearbeiteten Änderungen. ` +
              'Schließe das schreibende Programm oder führe ein Checkpoint aus, um den aktuellen Stand zu sehen.',
          });
        }
      })
      .catch((err) => {
        if (!cancelled && intent === loadIntent.current) {
          reportError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      if (loadIntent.current === intent) loadIntent.current += 1;
    };
  }, [onSourceChanged, openDatabase, pendingWal, reportError, requestedPath, requestVersion, sourceSessionKey]);

  const handleOpenFileClick = useCallback(() => {
    onSourceIntent?.();
    loadIntent.current += 1;
    if (onRequestOpen) {
      onRequestOpen();
      return;
    }
    if (!requestNativeOpenDialog()) {
      fileInputRef.current?.click();
    }
  }, [onRequestOpen, onSourceIntent]);

  /**
   * Re-reads the schema after the SQL editor changed the database, so the
   * sidebar, schema view and statistics never show a stale picture.
   */
  const refreshSchema = useCallback(() => {
    if (!dbEngine.isLoaded()) return;
    try {
      setMetadata(dbEngine.getDatabaseMetadata());
      setSchemaVersion((version) => version + 1);
    } catch (err: any) {
      reportError(err?.message || String(err));
    }
  }, [reportError]);

  const handleDatabaseChanged = useCallback(() => {
    refreshSchema();
    setCurrentDirty(true);
  }, [refreshSchema, setCurrentDirty]);

  const handleNavigateForeignKey = useCallback((target: ForeignKeyNavigationTarget) => {
    if (!metadata?.tables.some((table) => table.name === target.table)) {
      reportError(`Die referenzierte Tabelle „${target.table}“ wurde nicht gefunden.`);
      return;
    }
    setSelectedTable(target.table);
    if (editorTabId) tableFocusByTab.current.set(editorTabId, target.table);
    setActiveTab('data');
    setNavigationFilter({
      token: Date.now() + Math.random(),
      column: target.column,
      value: target.value,
    });
  }, [editorTabId, metadata, reportError]);

  const handleMergedFiles = useCallback(async (
    tables: ImportedTable[],
    report: MergeFilesReport
  ) => {
    onSourceIntent?.();
    const opened = await openDatabase((isCurrent) => (
      dbEngine.loadTables(tables, report.targetFilename, report.totalBytes, isCurrent)
    ));
    if (!opened) return;
    const targetSession = `table\u0000${report.targetFilename}\u0000`;
    activeSourceSession.current = targetSession;
    dirtySessions.current.add(targetSession);
    setIsDirty(true);
    setIsMergeOpen(false);
    setNavigationFilter(undefined);
    setNotice({
      tone: 'success',
      message: `${report.sourceFiles} Dateien zu ${report.outputRows} Zeilen zusammengeführt · ${report.duplicatesRemoved} Dubletten entfernt.`,
    });
    onSourceChanged?.({ name: report.targetFilename, path: null });
  }, [onSourceChanged, onSourceIntent, openDatabase]);

  // Native macOS host bridge: files opened from Finder or the ⌘O panel.
  useEffect(() => {
    if (embedded) return;
    return onNativeFileOpened(({ buffer, filename }) => {
      onSourceIntent?.();
      setActiveFileId(null);
      void openDatabase((isCurrent) => openAsDatabase(buffer, filename, isCurrent)).then((opened) => {
        if (opened) onSourceChanged?.({ name: opened.filename, path: null });
      });
    }, reportError);
  }, [embedded, onSourceChanged, onSourceIntent, openDatabase, reportError]);

  useEffect(() => {
    if (embedded) return;
    announceReady();
  }, [embedded]);

  // Local HTTP API: answer requests from the open database, and let a caller
  // load a file by path the same way the sidebar does.
  useEffect(() => installApiHandler(), []);

  useEffect(() => {
    setOpenPathHandler(async (path) => {
      onSourceIntent?.();
      const intent = ++loadIntent.current;
      const buffer = await readFileAtPath(path);
      const isCurrent = () => intent === loadIntent.current;
      if (!isCurrent()) throw new Error('Der Ladevorgang wurde durch eine neuere Aktion ersetzt.');
      const previousSession = activeSourceSession.current;
      if (previousSession && dbEngine.isLoaded()) {
        sourceSessions.current.set(previousSession, {
          bytes: dbEngine.exportDatabase(),
          filename: dbEngine.getFilename(),
          document: dbEngine.sourceDocument,
          sourceInfo: dbEngine.sourceInfo,
        });
      }
      const filename = path.split('/').pop() || path;
      const meta = await openAsDatabase(buffer, filename, isCurrent);
      if (!meta || !isCurrent()) {
        throw new Error('Der Ladevorgang wurde durch eine neuere Aktion ersetzt.');
      }
      if (requestedPath === path) {
        // Same-path reload: no root prop changes, so keep the existing key now.
        activeSourceSession.current = sourceSessionKey ?? path;
        directSourceAdoption.current = null;
      } else {
        // New path: the root will provide its canonical source identity next.
        activeSourceSession.current = null;
        directSourceAdoption.current = { path, filename: meta.filename };
      }
      setActiveFileId(null);
      adoptMetadata(meta);
      onSourceChanged?.({ name: meta.filename, path });
      onExternalOpen?.();
      return { filename: meta.filename, tableCount: meta.tableCount };
    });
    setDatabaseChangedHandler(() => {
      onSourceIntent?.();
      handleDatabaseChanged();
    });
    return () => {
      setOpenPathHandler(undefined);
      setDatabaseChangedHandler(undefined);
    };
  }, [adoptMetadata, handleDatabaseChanged, onExternalOpen, onSourceChanged, onSourceIntent, requestedPath, sourceSessionKey]);

  // Keeps `/api/v1/health` answerable without waiting on the renderer.
  useEffect(() => {
    reportDatabaseChanged();
  }, [metadata, schemaVersion]);

  // The title bar is drawn by the page, so the host has to be told where it is
  // and which parts of it are buttons. Re-measured whenever its contents change.
  useWindowDrag(`${Boolean(metadata)}|${activeTab}`, !embedded);

  useEffect(() => {
    if (!active) return;
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
        handleOpenFileClick();
      } else if (key === 's' && metadata) {
        e.preventDefault();
        setIsExportOpen(true);
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [active, handleOpenFileClick, metadata]);

  useEffect(() => {
    if (!active || !metadata || !editorTabId) return;
    const target = requestedTableName ?? tableFocusByTab.current.get(editorTabId);
    if (!target || !metadata.tables.some((table) => table.name === target)) return;
    setSelectedTable(target);
    setActiveTab('data');
  }, [active, editorTabId, metadata, requestedTableName]);

  useEffect(() => {
    onReadyChange?.(true);
    return () => onReadyChange?.(false);
  }, [onReadyChange]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [editorTabId, isDirty, onDirtyChange]);

  useEffect(() => {
    if (!active || !metadata) return;
    const requestSave = () => setIsExportOpen(true);
    window.addEventListener('database-studio:save-active', requestSave);
    return () => window.removeEventListener('database-studio:save-active', requestSave);
  }, [active, metadata]);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so picking the same file twice fires a change event again.
      event.target.value = '';
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  const handleSelectTable = useCallback(
    (tableName: string) => {
      setSelectedTable(tableName);
      if (editorTabId) tableFocusByTab.current.set(editorTabId, tableName);
      if (activeTab !== 'data' && activeTab !== 'schema') {
        setActiveTab('data');
      }
    },
    [activeTab, editorTabId]
  );

  const viewProps = {
    fileInputRef,
    fileInputAccept: FILE_INPUT_ACCEPT,
    onFileInputChange: handleFileInputChange,
    metadata,
    activeTab,
    onTabChange: setActiveTab,
    onOpenFile: handleOpenFileClick,
    onOpenExport: () => setIsExportOpen(true),
    notice,
    onDismissNotice: () => setNotice(null),
    isLoading,
    activeTable,
    sourcePath: requestedPath,
    schemaVersion,
    onSelectTable: handleSelectTable,
    onOpenTableInNewTab,
    onSchemaChanged: handleDatabaseChanged,
    isExportOpen,
    onCloseExport: () => setIsExportOpen(false),
    onError: reportError,
    onDatabaseExported: () => setCurrentDirty(false),
    isMergeOpen,
    onOpenMerge: () => setIsMergeOpen(true),
    onCloseMerge: () => setIsMergeOpen(false),
    onMerged: handleMergedFiles,
    mergeDisabled: isDirty,
    navigationFilter,
    onNavigateForeignKey: handleNavigateForeignKey,
  };

  if (embedded) {
    return <TableStudioView {...viewProps} embedded />;
  }

  return (
    <Suspense fallback={<div className="h-full w-screen bg-[#181818]" />}>
      <StandaloneTableStudioView
        {...viewProps}
        active={active}
        activeFileId={activeFileId}
        onFileLoaded={handleFile}
        onOpenProjectFile={handleOpenProjectFile}
      />
    </Suspense>
  );
};
