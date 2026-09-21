import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActiveTab, GraphDocument, GraphSource, QueryResult } from './types/graph';
import { IngestPayload } from './types/ingest';
import { ProjectFileNode } from './types/projects';
import { AdaptedPhaseXRun } from './types/phaseX';
import { graphEngine } from './services/graphEngine';
import {
  announceReady,
  files,
  ingestServer,
  isNativeHost,
  onIngestReceived,
  onNativeFileOpened,
} from './services/nativeHost';
import { importCoordinationFolder } from './services/coordination/import';
import { validateGraphDocument } from './services/graphDocument';
import { isPhaseXEnvelope, isPhaseXFileName } from './services/phaseX/adapter';
import { importPhaseXDocument } from './services/phaseX/import';
import { DEFAULT_INGEST_PORT, addUsage } from './services/settings';
import { Usage } from './types/settings';
import { useSettings } from './hooks/useSettings';
import { useIngestJobs } from './hooks/useIngestJobs';
import { useWindowDrag } from './hooks/useWindowDrag';
import { useProjects } from './hooks/useProjects';
import { GraphWorkspaceView } from './components/GraphWorkspaceView';
import type { Notice } from './components/NoticeBanner';
import {
  installApiHandler,
  reportGraphChanged,
  setGraphChangedHandler,
  setOpenPathHandler,
} from './services/api/host';
import { GraphWriteQueue, type GraphWriteSnapshot } from './services/GraphWriteQueue';
import type { WorkspaceDisposeEvent } from './workbench/model';

interface ExternalIngestTarget {
  sessionKey: string | null;
  created: boolean;
}

interface PendingMapRequest {
  url: string;
  targetId?: string;
  targetPath?: string;
}

interface PathlessGraphSnapshot {
  document: GraphDocument;
  activeFilePath: string | null;
  phaseXRun: AdaptedPhaseXRun | null;
  activeTab: ActiveTab;
  selectedId: string | null;
  selectedJsonPointer: string;
  searchTerm: string;
  hiddenLabels: Set<string>;
  highlighted: Set<string> | null;
  dirtyVersion: number | null;
  pendingMap: PendingMapRequest | null;
}

function cloneGraphDocument(document: GraphDocument): GraphDocument {
  return JSON.parse(JSON.stringify(document)) as GraphDocument;
}

export interface GraphStudioProps {
  /** Hides the duplicate project rail when hosted by Database Studio. */
  embedded?: boolean;
  /** Opens a project source selected in Database Studio's shared navigator. */
  requestedPath?: string | null;
  /** Forces a re-open when the same path is selected again. */
  requestVersion?: number;
  /** Root editor identity, used to distinguish tab switches from replacements. */
  editorTabId?: string;
  /** Stable storage key for an unsaved graph owned by one root editor tab. */
  pathlessSessionKey?: string | null;
  disposeEvent?: WorkspaceDisposeEvent;
  /** Keeps global shortcuts scoped to the visible workspace. */
  active?: boolean;
  /** Delegates the unified native picker to Database Studio's root router. */
  onRequestOpen?: () => void;
  /** Invalidates an older root-level open before a new child action begins. */
  onSourceIntent?: () => void;
  /** Keeps the shared title and source highlight aligned with child actions. */
  onSourceChanged?: (source: {
    name: string;
    path: string | null;
    fileType: 'graph' | 'phase-x-run';
  }) => void;
  /** Makes an API/MCP-opened document visible in its real root editor tab. */
  onExternalOpen?: () => void;
  /** Reveals or creates the real root graph tab before an extension import. */
  onExternalIngestTarget?: () => ExternalIngestTarget;
  /** Reports when the adapter's API, file-open and ingest handlers are live. */
  onReadyChange?: (ready: boolean) => void;
  /** Mirrors the resident document's unsaved state into its root editor tab. */
  onDirtyChange?: (dirty: boolean) => void;
}

export const GraphStudio: React.FC<GraphStudioProps> = ({
  embedded = false,
  requestedPath = null,
  requestVersion = 0,
  editorTabId,
  pathlessSessionKey = null,
  disposeEvent,
  active = true,
  onRequestOpen,
  onSourceIntent,
  onSourceChanged,
  onExternalOpen,
  onExternalIngestTarget,
  onReadyChange,
  onDirtyChange,
}) => {
  const [hasGraph, setHasGraph] = useState(false);
  const [graphVersion, setGraphVersion] = useState(0);
  /** Null while clean; otherwise the globally monotone mutation revision. */
  const [dirtyVersion, setDirtyVersion] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('graph');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [hiddenLabels, setHiddenLabels] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [server, setServer] = useState({ running: false, port: DEFAULT_INGEST_PORT });
  const [graphPath, setGraphPath] = useState<string | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [phaseXRun, setPhaseXRun] = useState<AdaptedPhaseXRun | null>(null);
  const [selectedJsonPointer, setSelectedJsonPointer] = useState('/run');
  /** A whole-site request from the extension, with the destination it chose. */
  const [pendingMap, setPendingMap] = useState<PendingMapRequest | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadIntent = useRef(0);
  /** Changes only when the engine adopts a different logical document. */
  const documentGeneration = useRef(0);
  const graphPathRef = useRef<string | null>(null);
  const mutationRevision = useRef(0);
  const dirtyVersionRef = useRef<number | null>(null);
  const pathlessSessions = useRef(new Map<string, PathlessGraphSnapshot>());
  const activePathlessSessionKey = useRef<string | null>(pathlessSessionKey);
  const activePathlessOwnerId = useRef<string | null>(pathlessSessionKey ? editorTabId ?? null : null);
  // The API adopts a graph before React receives the matching root-tab props.
  // This hand-off prevents that prop update from reading the same file twice.
  const directSourceAdoption = useRef<{ path: string; intent: number } | null>(null);
  const pathlessUiState = useRef({
    activeFilePath,
    phaseXRun,
    activeTab,
    selectedId,
    selectedJsonPointer,
    searchTerm,
    hiddenLabels,
    highlighted,
    dirtyVersion,
    pendingMap,
  });
  pathlessUiState.current = {
    activeFilePath,
    phaseXRun,
    activeTab,
    selectedId,
    selectedJsonPointer,
    searchTerm,
    hiddenLabels,
    highlighted,
    dirtyVersion,
    pendingMap,
  };
  const graphWriteQueue = useRef<GraphWriteQueue | null>(null);
  if (!graphWriteQueue.current) {
    graphWriteQueue.current = new GraphWriteQueue((path, contents) => files.write(path, contents));
  }

  const reportError = useCallback(
    (message: string) => setNotice({ tone: 'error', message }),
    []
  );

  /**
   * Native RPC handlers may finish on different queues. Serialising every
   * graph write here prevents an older snapshot from landing after a newer
   * one. Different documents stay in FIFO order; identical revisions dedupe.
   */
  const enqueueGraphWrite = useCallback((snapshot: GraphWriteSnapshot): Promise<{ path: string }> => {
    return graphWriteQueue.current!.enqueue(snapshot).then((saved) => {
      if (
        documentGeneration.current === snapshot.generation
        && graphPathRef.current === snapshot.path
        && dirtyVersionRef.current === snapshot.revision
      ) {
        dirtyVersionRef.current = null;
        setDirtyVersion((current) => (current === snapshot.revision ? null : current));
      }
      return saved;
    });
  }, []);

  const flushDirtyGraph = useCallback(() => {
    const path = graphPathRef.current;
    const revision = dirtyVersionRef.current;
    if (!path || revision === null || !graphEngine.isLoaded() || !isNativeHost()) return;
    const generation = documentGeneration.current;
    const contents = JSON.stringify(graphEngine.toDocument(), null, 2);
    void enqueueGraphWrite({ path, contents, generation, revision }).catch((error) =>
      reportError(`Automatisches Sichern von "${path}" fehlgeschlagen: ${error instanceof Error ? error.message : error}`)
    );
  }, [enqueueGraphWrite, reportError]);

  const awaitGraphPathIdle = useCallback(async (path: string): Promise<void> => {
    await graphWriteQueue.current!.waitForPath(path);
  }, []);

  const readGraphFile = useCallback(async (path: string) => {
    // If the user reopens the file currently being edited, enqueue its latest
    // in-memory snapshot before reading from disk and wait for that exact path.
    flushDirtyGraph();
    await awaitGraphPathIdle(path);
    return files.read(path);
  }, [awaitGraphPathIdle, flushDirtyGraph]);

  const { settings, update: updateSettings, read: readSettings } = useSettings(reportError);

  const projects = useProjects(reportError, !embedded);
  const toggleProjects = projects.toggleCollapsed;

  /** Re-renders derived views without claiming that a freshly loaded file changed. */
  const refreshGraph = useCallback(() => setGraphVersion((version) => version + 1), []);
  /** Every actual engine mutation goes through here, enabling debounced autosave. */
  const markGraphDirty = useCallback(() => {
    const revision = ++mutationRevision.current;
    dirtyVersionRef.current = revision;
    setGraphVersion((version) => version + 1);
    setDirtyVersion(revision);
  }, []);

  const capturePathlessSession = useCallback((sessionKey: string) => {
    if (!graphEngine.isLoaded() || graphPathRef.current !== null) {
      pathlessSessions.current.delete(sessionKey);
      return;
    }
    const ui = pathlessUiState.current;
    pathlessSessions.current.set(sessionKey, {
      document: cloneGraphDocument(graphEngine.toDocument()),
      activeFilePath: ui.activeFilePath,
      phaseXRun: ui.phaseXRun,
      activeTab: ui.activeTab,
      selectedId: ui.selectedId,
      selectedJsonPointer: ui.selectedJsonPointer,
      searchTerm: ui.searchTerm,
      hiddenLabels: new Set(ui.hiddenLabels),
      highlighted: ui.highlighted ? new Set(ui.highlighted) : null,
      dirtyVersion: ui.dirtyVersion,
      pendingMap: ui.pendingMap ? { ...ui.pendingMap } : null,
    });
  }, []);

  const restorePathlessSession = useCallback((snapshot: PathlessGraphSnapshot) => {
    flushDirtyGraph();
    loadIntent.current += 1;
    documentGeneration.current += 1;
    graphPathRef.current = null;
    dirtyVersionRef.current = snapshot.dirtyVersion;
    graphEngine.load(cloneGraphDocument(snapshot.document), snapshot.document.metadata.name);
    setGraphPath(null);
    setActiveFilePath(snapshot.activeFilePath);
    setPhaseXRun(snapshot.phaseXRun);
    setHasGraph(true);
    setActiveTab(snapshot.activeTab);
    setSelectedId(snapshot.selectedId);
    setSelectedJsonPointer(snapshot.selectedJsonPointer);
    setSearchTerm(snapshot.searchTerm);
    setHiddenLabels(new Set(snapshot.hiddenLabels));
    setHighlighted(snapshot.highlighted ? new Set(snapshot.highlighted) : null);
    setDirtyVersion(snapshot.dirtyVersion);
    setPendingMap(snapshot.pendingMap ? { ...snapshot.pendingMap } : null);
    refreshGraph();
  }, [flushDirtyGraph, refreshGraph]);

  const activatePathlessSession = useCallback((sessionKey: string, ownerId?: string) => {
    const previousKey = activePathlessSessionKey.current;
    if (previousKey === sessionKey) return;
    if (previousKey) capturePathlessSession(previousKey);
    activePathlessSessionKey.current = sessionKey;
    activePathlessOwnerId.current = ownerId ?? null;
    const snapshot = pathlessSessions.current.get(sessionKey);
    if (snapshot) restorePathlessSession(snapshot);
  }, [capturePathlessSession, restorePathlessSession]);

  useEffect(() => {
    if (!disposeEvent) return;
    if (disposeEvent.releaseSession) {
      pathlessSessions.current.delete(disposeEvent.sessionKey);
    }
    if (!disposeEvent.unloadActive) return;

    // Capture a final file-backed revision before detaching it, then invalidate
    // every outstanding read/parse so a closed tab cannot repopulate the API.
    flushDirtyGraph();
    loadIntent.current += 1;
    documentGeneration.current += 1;
    directSourceAdoption.current = null;
    activePathlessSessionKey.current = null;
    activePathlessOwnerId.current = null;
    graphPathRef.current = null;
    dirtyVersionRef.current = null;
    graphEngine.close();
    setGraphPath(null);
    setActiveFilePath(null);
    setPhaseXRun(null);
    setHasGraph(false);
    setSelectedId(null);
    setHighlighted(null);
    setHiddenLabels(new Set());
    setDirtyVersion(null);
    setPendingMap(null);
    refreshGraph();
  }, [disposeEvent, flushDirtyGraph, refreshGraph]);

  useEffect(() => {
    const previousKey = activePathlessSessionKey.current;
    if (previousKey === pathlessSessionKey) {
      activePathlessOwnerId.current = pathlessSessionKey ? editorTabId ?? null : null;
      return;
    }

    if (previousKey) {
      // Replacing the source inside the same editor tab ends that unsaved
      // session. Switching to another tab keeps it available for restoration.
      if (pathlessSessionKey === null && activePathlessOwnerId.current === editorTabId) {
        pathlessSessions.current.delete(previousKey);
      } else {
        capturePathlessSession(previousKey);
      }
    }

    activePathlessSessionKey.current = pathlessSessionKey;
    activePathlessOwnerId.current = pathlessSessionKey ? editorTabId ?? null : null;
    if (!pathlessSessionKey) return;
    const snapshot = pathlessSessions.current.get(pathlessSessionKey);
    if (snapshot) restorePathlessSession(snapshot);
  }, [capturePathlessSession, editorTabId, pathlessSessionKey, restorePathlessSession]);

  // MARK: - Usage

  /**
   * Adds what a request actually consumed to the running totals. Read through
   * `readSettings` rather than the render-time value, so several requests
   * finishing in the same tick cannot overwrite each other's contribution.
   */
  const recordUsage = useCallback(
    (delta: Partial<Usage>) => {
      updateSettings({ usage: addUsage(readSettings().usage, delta) });
    },
    [readSettings, updateSettings]
  );

  // MARK: - Ingest

  /**
   * Warnings the user has already seen and closed. A whole-site run repeats
   * the same provider problem for hundreds of jobs; once dismissed, the same
   * sentence must not come back for the rest of the session.
   */
  const dismissedWarnings = useRef(new Set<string>());
  /**
   * Every warning line that has been on screen at all. A provider that stays
   * unreachable fails again after each rest period, and each of those failures
   * is real — but the sentence is the same one the user already read. It is
   * shown once per session; the job rows keep the detail for anyone who looks.
   */
  const shownWarnings = useRef(new Set<string>());

  const showWarning = useCallback(
    (message: string) => {
      const lines = message
        .split('\n')
        .filter((line) => !dismissedWarnings.current.has(line) && !shownWarnings.current.has(line));
      if (lines.length === 0) return;
      for (const line of lines) shownWarnings.current.add(line);

      // A provider problem is fixable from right here, so offer the fix.
      const isProviderProblem = lines.some((line) => /^(Textanalyse|Transkription|Bildanalyse)/.test(line));
      setNotice({
        tone: 'warning',
        message: lines.join('\n'),
        actions: isProviderProblem
          ? [
              { label: 'Anbieter einstellen', onClick: () => setIsSettingsOpen(true) },
              {
                label: 'KI-Analyse ausschalten',
                onClick: () => {
                  updateSettings({ offlineExtractionOnly: true });
                  setNotice({
                    tone: 'success',
                    message:
                      'KI-Analyse ausgeschaltet — Importe laufen weiter, nur strukturell. Wieder einschalten unter Einstellungen → KI-Anbieter.',
                  });
                },
              },
            ]
          : undefined,
      });
    },
    [updateSettings]
  );

  // Changing the provider settings is a fresh start — a problem fixed there
  // deserves a fresh report if it is not fixed after all.
  const providerFingerprint = JSON.stringify({
    active: settings.activeProvider,
    provider: settings.providers[settings.activeProvider],
    offline: settings.offlineExtractionOnly,
  });
  useEffect(() => {
    shownWarnings.current.clear();
  }, [providerFingerprint]);

  const dismissNotice = useCallback(() => {
    setNotice((current) => {
      if (current?.tone === 'warning') {
        for (const line of current.message.split('\n')) dismissedWarnings.current.add(line);
      }
      return null;
    });
  }, []);

  const jobs = useIngestJobs({
    readSettings,
    recordUsage,
    onGraphChanged: markGraphDirty,
    onError: showWarning,
    onFinished: (job, result) => {
      if (job.result?.targetId.startsWith('file:')) void projects.reload();
      setNotice({
        tone: 'success',
        message: `"${job.payload.title || job.payload.url}": ${result.nodesCreated} Knoten und ${
          result.edgesCreated
        } Kanten geschrieben.`,
      });
    },
  });

  const enqueueIngest = jobs.enqueue;

  const handleIncomingPayload = useCallback(
    (payload: IngestPayload) => {
      onSourceIntent?.();
      const externalTarget = onExternalIngestTarget?.();
      if (externalTarget?.sessionKey) {
        activatePathlessSession(externalTarget.sessionKey, editorTabId);
      }
      // A newly requested ingest is a newer user intent than any file that is
      // still being decoded (notably a Phase-X run with external artefacts).
      loadIntent.current += 1;
      // An import arriving while no graph is open would have nowhere to go.
      if (externalTarget?.created || !graphEngine.isLoaded()) {
        documentGeneration.current += 1;
        graphPathRef.current = null;
        dirtyVersionRef.current = null;
        graphEngine.create(externalTarget?.created ? 'Browser-Import' : 'Unbenannter Graph');
        setGraphPath(null);
        setActiveFilePath(null);
        setPhaseXRun(null);
        setDirtyVersion(null);
        setHasGraph(true);
        setSelectedId(null);
        setHighlighted(null);
        setHiddenLabels(new Set());
        onSourceChanged?.({
          name: externalTarget?.created ? 'Browser-Import' : 'Unbenannter Graph',
          path: null,
          fileType: 'graph',
        });
        refreshGraph();
      }
      // The extension can ask for the site to be mapped instead of the single
      // page converted; the list then opens in the import tab.
      // The destination picked in the popup travels with the map request —
      // dropping it here is how a whole-site run ended up in the wrong graph.
      if (payload.mapSite) {
        setPendingMap({ url: payload.url, targetId: payload.targetId, targetPath: payload.targetPath });
      } else {
        enqueueIngest(payload);
      }

      setActiveTab('ingest');
    },
    [
      activatePathlessSession,
      editorTabId,
      enqueueIngest,
      onExternalIngestTarget,
      onSourceChanged,
      onSourceIntent,
      refreshGraph,
    ]
  );

  // MARK: - Graph documents

  const adoptDocument = useCallback(
    (document: GraphDocument, name: string, path: string | null, sourceName = name) => {
      flushDirtyGraph();
      documentGeneration.current += 1;
      graphPathRef.current = path;
      dirtyVersionRef.current = null;
      graphEngine.load(document, name);
      setGraphPath(path);
      setActiveFilePath(path);
      setPhaseXRun(null);
      setHasGraph(true);
      setSelectedId(null);
      setHighlighted(null);
      setHiddenLabels(new Set());
      setActiveTab((current) => (current === 'hierarchy' ? 'graph' : current));
      setDirtyVersion(null);
      onSourceChanged?.({ name: sourceName, path, fileType: 'graph' });
      refreshGraph();
    },
    [flushDirtyGraph, onSourceChanged, refreshGraph]
  );

  const adoptPhaseXRun = useCallback(
    (imported: AdaptedPhaseXRun) => {
      flushDirtyGraph();
      documentGeneration.current += 1;
      graphPathRef.current = null;
      dirtyVersionRef.current = null;
      graphEngine.load(imported.graph, imported.graph.metadata.name);
      const rootId = imported.hierarchyRootIds[0] ?? imported.graph.nodes[0]?.id ?? null;
      const rootPointer = rootId ? imported.pointerByNodeId.get(rootId) ?? '/run' : '/run';
      setGraphPath(null);
      setActiveFilePath(imported.sourcePath);
      setPhaseXRun(imported);
      setHasGraph(true);
      setSelectedId(rootId);
      setSelectedJsonPointer(rootPointer);
      setHighlighted(null);
      setHiddenLabels(new Set());
      setActiveTab('hierarchy');
      setDirtyVersion(null);
      onSourceChanged?.({
        name: imported.sourceName,
        path: imported.sourcePath,
        fileType: 'phase-x-run',
      });
      refreshGraph();
    },
    [flushDirtyGraph, onSourceChanged, refreshGraph]
  );

  const parseAndAdopt = useCallback(
    async (
      contents: string,
      filename: string,
      path: string | null,
      expectedIntent?: number
    ): Promise<boolean> => {
      const intent = expectedIntent ?? ++loadIntent.current;
      try {
        const parsed: unknown = JSON.parse(contents);
        if (isPhaseXEnvelope(parsed) || isPhaseXFileName(filename)) {
          const imported = await importPhaseXDocument(parsed, { filename, path });
          if (intent !== loadIntent.current) return false;
          adoptPhaseXRun(imported);
        } else {
          const document = validateGraphDocument(parsed);
          if (intent !== loadIntent.current) return false;
          adoptDocument(document, filename.replace(/\.graph$/i, ''), path, filename);
        }
        return true;
      } catch (err) {
        if (intent === loadIntent.current) {
          reportError(
            `"${filename}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : err}`
          );
        }
        return false;
      }
    },
    [adoptDocument, adoptPhaseXRun, reportError]
  );

  const handleNewGraph = useCallback(() => {
    onSourceIntent?.();
    loadIntent.current += 1;
    flushDirtyGraph();
    documentGeneration.current += 1;
    graphPathRef.current = null;
    dirtyVersionRef.current = null;
    graphEngine.create('Unbenannter Graph');
    setGraphPath(null);
    setActiveFilePath(null);
    setPhaseXRun(null);
    setHasGraph(true);
    setSelectedId(null);
    setHighlighted(null);
    setHiddenLabels(new Set());
    setDirtyVersion(null);
    onSourceChanged?.({ name: 'Unbenannter Graph', path: null, fileType: 'graph' });
    refreshGraph();
  }, [flushDirtyGraph, onSourceChanged, onSourceIntent, refreshGraph]);

  const handleOpenGraph = useCallback(async () => {
    onSourceIntent?.();
    flushDirtyGraph();
    if (onRequestOpen) {
      loadIntent.current += 1;
      onRequestOpen();
      return;
    }
    if (!isNativeHost()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const intent = ++loadIntent.current;
      const opened = await files.open();
      if (opened) {
        const current = await readGraphFile(opened.path);
        await parseAndAdopt(current.contents, current.name, current.path, intent);
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  }, [flushDirtyGraph, onRequestOpen, onSourceIntent, parseAndAdopt, readGraphFile, reportError]);

  const handleOpenProjectFile = useCallback(
    async (file: ProjectFileNode) => {
      onSourceIntent?.();
      const intent = ++loadIntent.current;
      try {
        const opened = await readGraphFile(file.path);
        await parseAndAdopt(opened.contents, opened.name, opened.path, intent);
      } catch (err) {
        if (intent === loadIntent.current) {
          reportError(`"${file.name}" konnte nicht geöffnet werden: ${err instanceof Error ? err.message : err}`);
        }
      }
    },
    [onSourceIntent, parseAndAdopt, readGraphFile, reportError]
  );

  useEffect(() => {
    if (!requestedPath) return;
    const directlyAdopted = directSourceAdoption.current;
    if (
      directlyAdopted?.path === requestedPath
      && directlyAdopted.intent === loadIntent.current
      && graphEngine.isLoaded()
    ) {
      directSourceAdoption.current = null;
      setActiveFilePath(requestedPath);
      return;
    }
    directSourceAdoption.current = null;
    const intent = ++loadIntent.current;
    let cancelled = false;
    void readGraphFile(requestedPath)
      .then((opened) => {
        if (!cancelled) return parseAndAdopt(opened.contents, opened.name, opened.path, intent);
        return false;
      })
      .catch((err) => {
        if (!cancelled) {
          reportError(`"${requestedPath.split('/').pop() || requestedPath}" konnte nicht geöffnet werden: ${
            err instanceof Error ? err.message : err
          }`);
        }
      });
    return () => {
      cancelled = true;
      if (loadIntent.current === intent) loadIntent.current += 1;
    };
  }, [parseAndAdopt, readGraphFile, reportError, requestedPath, requestVersion]);

  /**
   * Reads a shared workspace's coordination records — the work, actor, event,
   * handoff and decision notes a tracker keeps — and shows them as the graph
   * they already are. What a table of records cannot show is the shape they
   * make together: which workstreams stand on a revision that has since moved.
   *
   * The result is adopted without a path. It is a projection of files this app
   * does not own, and autosave writing a graph back over a tracker's records
   * would corrupt exactly the state they exist to protect.
   */
  const handleOpenCoordination = useCallback(async () => {
    onSourceIntent?.();
    if (!isNativeHost()) {
      reportError('Koordinations-Records lassen sich nur in der App lesen — im Browser fehlt der Ordnerzugriff.');
      return;
    }

    const intent = ++loadIntent.current;
    try {
      const picked = await files.chooseFolder('Projektordner oder Coordination/Items auswählen');
      if (!picked) return;

      const imported = await importCoordinationFolder(picked.path);
      if (intent !== loadIntent.current) return;
      adoptDocument(imported.document, imported.name, null);
      setActiveTab('graph');

      const review = imported.document.nodes.filter(
        (node) => node.labels.includes('Workstream') && node.properties.needsReview === true
      ).length;

      const summary =
        `${imported.recordCount} Records aus "${imported.name}" gelesen` +
        (review > 0
          ? ` — ${review} Workstream(s) stehen auf einer überholten Abhängigkeit.`
          : ' — keine überholten Abhängigkeiten.');

      setNotice(
        imported.problems.length > 0
          ? { tone: 'warning', message: [summary, ...imported.problems].join('\n') }
          : { tone: 'success', message: summary }
      );
    } catch (err) {
      if (intent === loadIntent.current) {
        reportError(`Koordinations-Ordner konnte nicht gelesen werden: ${err instanceof Error ? err.message : err}`);
      }
    }
  }, [adoptDocument, onSourceIntent, reportError]);

  const handleExport = useCallback(async () => {
    const generation = documentGeneration.current;
    const revision = dirtyVersionRef.current;
    const document = graphEngine.toDocument();
    const contents = JSON.stringify(document, null, 2);
    const filename = `${graphEngine.getName() || 'graph'}.graph`;

    if (isNativeHost()) {
      try {
        const saved = graphPath
          ? await enqueueGraphWrite({ path: graphPath, contents, generation, revision })
          : await files.saveAs(filename, contents);
        if (saved && generation === documentGeneration.current) {
          graphPathRef.current = saved.path;
          setGraphPath(saved.path);
          if (dirtyVersionRef.current === revision) {
            dirtyVersionRef.current = null;
            setDirtyVersion((current) => (current === revision ? null : current));
          }
          onSourceChanged?.({
            name: saved.path.split('/').pop() || graphEngine.getName() || 'Graph',
            path: saved.path,
            fileType: 'graph',
          });
          setNotice({ tone: 'success', message: `Gespeichert: ${saved.path}` });
        }
      } catch (err) {
        reportError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Browser fallback: a plain download.
    const blob = new Blob([contents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    if (dirtyVersionRef.current === revision) {
      dirtyVersionRef.current = null;
      setDirtyVersion((current) => (current === revision ? null : current));
    }
  }, [enqueueGraphWrite, graphPath, onSourceChanged, reportError]);

  // MARK: - Derived views
  //
  // `graphVersion` is what makes these re-compute: the engine is a mutable
  // store outside React, so a version counter is the honest dependency.

  const nodes = useMemo(() => graphEngine.getNodes(), [graphVersion]);
  const edges = useMemo(() => graphEngine.getEdges(), [graphVersion]);
  const schema = useMemo(() => graphEngine.getSchema(), [graphVersion]);
  const sources = useMemo(() => graphEngine.getSources(), [graphVersion]);
  const selectedNode = selectedId ? graphEngine.getNode(selectedId) : undefined;
  const incidentEdges = useMemo(
    () => (selectedId ? graphEngine.incidentEdges(selectedId) : []),
    [selectedId, graphVersion]
  );

  const toggleLabel = useCallback((label: string) => {
    setHiddenLabels((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const handleRemoveSource = useCallback(
    (sourceId: string) => {
      if (phaseXRun) {
        setNotice({
          tone: 'warning',
          message: 'Phase-X-Läufe sind schreibgeschützt. Die Originaldatei und ihre abgeleitete Ansicht bleiben unverändert.',
        });
        return;
      }
      onSourceIntent?.();
      graphEngine.removeSource(sourceId);
      setSelectedId(null);
      markGraphDirty();
    },
    [markGraphDirty, onSourceIntent, phaseXRun]
  );

  const handleFocusSource = useCallback((source: GraphSource) => {
    setSelectedId(source.id);
    setActiveTab('graph');
  }, []);

  const handleDeleteNode = useCallback(
    (id: string) => {
      onSourceIntent?.();
      graphEngine.deleteNode(id);
      setSelectedId(null);
      markGraphDirty();
    },
    [markGraphDirty, onSourceIntent]
  );

  const handleSelectNode = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!id || !phaseXRun) return;
      const pointer = phaseXRun.pointerByNodeId.get(id);
      if (pointer) setSelectedJsonPointer(pointer);
    },
    [phaseXRun]
  );

  const handleQueryHighlight = useCallback((result: QueryResult | null) => {
    setHighlighted(result ? new Set(result.nodeIds) : null);
  }, []);

  // A graph that came from a file goes back to that file after every change,
  // the way a database does. Without this an import into the open graph lived
  // only in memory until ⌘S — and read as "not saved in my project".
  const autosaveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!graphPath || !hasGraph || !isNativeHost() || dirtyVersion === null) return;
    const revision = dirtyVersion;
    const generation = documentGeneration.current;
    const path = graphPath;
    const timer = window.setTimeout(() => {
      if (autosaveTimer.current === timer) autosaveTimer.current = null;
      if (generation !== documentGeneration.current || graphPathRef.current !== path) return;
      const contents = JSON.stringify(graphEngine.toDocument(), null, 2);
      enqueueGraphWrite({ path, contents, generation, revision })
        .catch((err) => reportError(`Automatisches Sichern fehlgeschlagen: ${err?.message || err}`));
    }, 600);
    autosaveTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autosaveTimer.current === timer) autosaveTimer.current = null;
    };
  }, [dirtyVersion, enqueueGraphWrite, graphPath, hasGraph, reportError]);

  // MARK: - Local HTTP API

  useEffect(() => installApiHandler(), []);

  useEffect(() => {
    setOpenPathHandler(async (path) => {
      onSourceIntent?.();
      const intent = ++loadIntent.current;
      const file = await readGraphFile(path);
      if (intent !== loadIntent.current) {
        throw new Error('Der Ladevorgang wurde durch eine neuere Aktion ersetzt.');
      }
      directSourceAdoption.current = { path, intent };
      const opened = await parseAndAdopt(file.contents, file.name, file.path, intent);
      if (!opened) {
        if (directSourceAdoption.current?.intent === intent) directSourceAdoption.current = null;
        throw new Error(`„${file.name}“ konnte nicht geöffnet werden.`);
      }
      onExternalOpen?.();
      return {
        name: graphEngine.getName(),
        nodeCount: graphEngine.nodeCount(),
        edgeCount: graphEngine.edgeCount(),
      };
    });
    // A write over the API has to reach the canvas and the autosave the same
    // way an edit in the inspector does.
    setGraphChangedHandler(() => {
      onSourceIntent?.();
      markGraphDirty();
    });

    return () => {
      setOpenPathHandler(undefined);
      setGraphChangedHandler(undefined);
    };
  }, [markGraphDirty, onExternalOpen, onSourceIntent, parseAndAdopt, readGraphFile]);

  // Keeps `/api/v1/health` answerable without waiting on the renderer.
  useEffect(() => {
    reportGraphChanged();
  }, [hasGraph, graphVersion]);

  // MARK: - Native host wiring

  useEffect(() => {
    if (embedded) return;
    return onNativeFileOpened(
      ({ contents, filename, path }) => {
        const intent = ++loadIntent.current;
        if (!path) {
          void parseAndAdopt(contents, filename, null, intent);
          return;
        }
        void readGraphFile(path)
          .then((current) => parseAndAdopt(current.contents, current.name, current.path, intent))
          .catch((error) => {
            if (intent === loadIntent.current) reportError(error instanceof Error ? error.message : String(error));
          });
      },
      reportError
    );
  }, [embedded, parseAndAdopt, readGraphFile, reportError]);

  useEffect(() => onIngestReceived(handleIncomingPayload), [handleIncomingPayload]);

  useEffect(() => {
    if (embedded) return;
    announceReady();
  }, [embedded]);

  // Starts the ingest server once settings are known, so the extension can
  // reach the app without the user having to switch it on first.
  const desiredPort = settings.ingestPort;
  useEffect(() => {
    if (!isNativeHost()) return;
    let cancelled = false;

    void ingestServer
      .start(desiredPort)
      .then((status) => {
        if (!cancelled) setServer({ running: status.running, port: status.port });
      })
      .catch((err) => {
        if (!cancelled) {
          setNotice({
            tone: 'warning',
            message: `Import-Server auf Port ${desiredPort} konnte nicht gestartet werden: ${
              err?.message || err
            }`,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desiredPort]);

  // Keeps the extension's `GET /status` answer current: it reports the open
  // graph and the measured token usage, both of which the popup shows before the
  // user commits to a conversion.
  useEffect(() => {
    if (!isNativeHost() || !server.running) return;
    void ingestServer
      .setState({
        graphName: hasGraph ? graphEngine.getName() : '',
        graphPath: graphPath ?? '',
        nodeCount: hasGraph ? graphEngine.nodeCount() : 0,
        tokensUsed: settings.usage.inputTokens + settings.usage.outputTokens,
      })
      .catch(() => undefined);
  }, [hasGraph, graphVersion, graphPath, settings.usage, server.running]);

  // The title bar is drawn by the page, so the host has to be told where it is
  // and which parts of it are buttons. Re-measured whenever the bar's contents
  // change — the tab switcher only exists once a graph is open.
  useWindowDrag(`${hasGraph}|${activeTab}|${jobs.activeCount > 0}|${server.running}`, !embedded);

  // MARK: - Keyboard

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === 'o') {
        event.preventDefault();
        void handleOpenGraph();
      } else if (key === 'n') {
        event.preventDefault();
        handleNewGraph();
      } else if (key === 's' && graphEngine.isLoaded()) {
        event.preventDefault();
        void handleExport();
      } else if (key === ',') {
        event.preventDefault();
        setIsSettingsOpen(true);
      } else if (key === 'b' && !embedded) {
        event.preventDefault();
        toggleProjects();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, embedded, handleExport, handleNewGraph, handleOpenGraph, toggleProjects]);

  useEffect(() => {
    if (!active || !hasGraph) return;
    const requestSave = () => void handleExport();
    window.addEventListener('database-studio:save-active', requestSave);
    return () => window.removeEventListener('database-studio:save-active', requestSave);
  }, [active, handleExport, hasGraph]);

  useEffect(() => {
    onReadyChange?.(true);
    return () => onReadyChange?.(false);
  }, [onReadyChange]);

  useEffect(() => {
    onDirtyChange?.(dirtyVersion !== null);
  }, [dirtyVersion, editorTabId, onDirtyChange]);

  return (
    <GraphWorkspaceView
      embedded={embedded}
      fileInputRef={fileInputRef}
      onFileSelected={(file) => {
        const intent = ++loadIntent.current;
        void file.text().then((contents) => parseAndAdopt(contents, file.name, null, intent));
      }}
      titleBarProps={{
        embedded,
        graphName: hasGraph ? graphEngine.getName() : null,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        activeTab,
        onTabChange: setActiveTab,
        onNewGraph: handleNewGraph,
        onOpenGraph: () => void handleOpenGraph(),
        onOpenCoordination: () => void handleOpenCoordination(),
        onExport: () => void handleExport(),
        onOpenSettings: () => setIsSettingsOpen(true),
        activeJobs: jobs.activeCount,
        hasHierarchy: phaseXRun !== null,
      }}
      noticeBannerProps={{ notice, onDismiss: dismissNotice }}
      projectSidebarProps={embedded ? null : {
        projects: projects.projects,
        isCollapsed: projects.isCollapsed,
        isBusy: projects.isBusy,
        isSupported: projects.isSupported,
        activePath: activeFilePath,
        onToggleCollapsed: projects.toggleCollapsed,
        onAddProject: projects.addProject,
        onRemoveProject: projects.removeProject,
        onRefreshProject: projects.refreshProject,
        onOpenFile: handleOpenProjectFile,
      }}
      hasGraph={hasGraph}
      activeTab={activeTab}
      emptyStateProps={{
        onNewGraph: handleNewGraph,
        onOpenGraph: () => void handleOpenGraph(),
        onOpenCoordination: () => void handleOpenCoordination(),
        onDropFile: (file) => {
          onSourceIntent?.();
          const intent = ++loadIntent.current;
          void file.text().then((contents) => parseAndAdopt(contents, file.name, null, intent));
        },
        isLoading: false,
      }}
      sidebarProps={{
        schema,
        sources,
        hiddenLabels,
        onToggleLabel: toggleLabel,
        searchTerm,
        onSearchChange: setSearchTerm,
        onRemoveSource: handleRemoveSource,
        onFocusSource: handleFocusSource,
      }}
      graphCanvasProps={{
        active,
        nodes,
        edges,
        selectedId,
        onSelect: handleSelectNode,
        highlighted,
        hiddenLabels,
        searchTerm,
        layoutMode: phaseXRun ? 'hierarchy' : 'force',
      }}
      nodeInspectorProps={selectedNode ? {
        node: selectedNode,
        incident: incidentEdges,
        resolveNode: (id) => graphEngine.getNode(id),
        onSelect: (id) => handleSelectNode(id),
        onClose: () => setSelectedId(null),
        onDelete: handleDeleteNode,
        readOnly: phaseXRun !== null,
        onShowHierarchy: phaseXRun
          ? () => {
              const pointer = phaseXRun.pointerByNodeId.get(selectedNode.id) ?? '/run';
              setSelectedJsonPointer(pointer);
              setActiveTab('hierarchy');
            }
          : undefined,
      } : null}
      hierarchyProps={phaseXRun ? {
        run: phaseXRun,
        selectedPointer: selectedJsonPointer,
        onSelect: (pointer, nodeId) => {
          setSelectedJsonPointer(pointer);
          setSelectedId(nodeId);
        },
        onShowGraph: (nodeId) => {
          setSelectedId(nodeId);
          setActiveTab('graph');
        },
      } : null}
      queryViewProps={{
        schema,
        onHighlight: handleQueryHighlight,
        onShowGraph: () => setActiveTab('graph'),
      }}
      ontologyViewerProps={{ schema }}
      ingestPanelProps={{
        jobs: jobs.jobs,
        targets: settings.targets,
        defaultTargetId: settings.defaultTargetId,
        onEnqueue: handleIncomingPayload,
        onCancel: jobs.cancel,
        onRetry: jobs.retry,
        onClearFinished: jobs.clearFinished,
        serverRunning: server.running,
        serverPort: server.port,
        onError: showWarning,
        onNotice: (message) => setNotice({ tone: 'success', message }),
        onCancelAll: jobs.cancelAll,
        pendingMap,
        onMapConsumed: () => setPendingMap(null),
      }}
      statsViewerProps={{ nodes, edges }}
      graphApiPanelProps={{ sampleLabel: schema.labels[0]?.label ?? null }}
      settingsModalProps={{
        isOpen: isSettingsOpen,
        onClose: () => setIsSettingsOpen(false),
        settings,
        onChange: updateSettings,
        serverRunning: server.running,
        serverPort: server.port,
        onServerChanged: (running, port) => setServer({ running, port }),
        onError: reportError,
      }}
    />
  );
};
