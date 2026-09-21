import { useCallback, useEffect, useRef, useState } from 'react';
import { files, isNativeHost, onNativeFileStaged, type StagedFile } from '../services/nativeHost';
import type { ProjectFileNode } from '../types/projects';
import {
  fileTypeForName,
  initialEditorTabs,
  initialWorkspaceSources,
  newHomeSource,
  sourceIdentity,
  workspaceFor,
  type ActiveSource,
  type DataWorkspaceKind,
  type EditorTab,
  type ExternalGraphTarget,
  type OpenDisposition,
  type WorkspaceDisposeEvent,
  type WorkspaceSyncContext,
  type WorkspaceSourceUpdate,
} from './model';

/**
 * Owns the workbench's synchronous tab/source state machine. Refs intentionally
 * mirror React state so API, Finder and extension callbacks in the same tick
 * always observe the just-committed tab instead of a stale render closure.
 */
export function useWorkbenchController() {
  const [tabs, setTabs] = useState<EditorTab[]>(initialEditorTabs);
  const [activeTabId, setActiveTabId] = useState('tab-1');
  const [notice, setNotice] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const previousActiveTabId = useRef<string | null>(null);
  const tabSequence = useRef(1);
  const requestSequence = useRef(0);
  const disposeSequence = useRef(0);
  const openIntent = useRef(0);
  const workspaceSources = useRef(initialWorkspaceSources());
  const workspaceOwnerTab = useRef<Partial<Record<DataWorkspaceKind, string>>>({});
  const blockedSourceSync = useRef(new Set<DataWorkspaceKind>());
  const [workspaceDisposals, setWorkspaceDisposals] = useState<
    Partial<Record<DataWorkspaceKind, WorkspaceDisposeEvent>>
  >({});
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const source = activeTab.source;

  const reportNotice = useCallback((message: string) => setNotice(message), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  const commitTabs = useCallback((update: (current: EditorTab[]) => EditorTab[]) => {
    const next = update(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const activateEditorTab = useCallback((tab: EditorTab, beginIntent = true) => {
    if (beginIntent) openIntent.current += 1;
    setNotice(null);
    if (activeTabIdRef.current !== tab.id) previousActiveTabId.current = activeTabIdRef.current;
    activeTabIdRef.current = tab.id;
    if (tab.source.kind !== 'home') {
      blockedSourceSync.current.delete(tab.source.kind);
      workspaceSources.current[tab.source.kind] = tab.source;
      workspaceOwnerTab.current[tab.source.kind] = tab.id;
    }
    setActiveTabId(tab.id);
  }, []);

  const selectEditorTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    if (tab) activateEditorTab(tab);
  }, [activateEditorTab]);

  const createTabId = useCallback(() => `tab-${++tabSequence.current}`, []);

  const rendererSessionKey = useCallback((tab: EditorTab): string => (
    tab.source.kind === 'graph' && tab.source.path === null
      ? `graph-tab:${tab.id}`
      : sourceIdentity(tab.source)
  ), []);

  const disposeTabSession = useCallback((
    tab: EditorTab,
    remainingTabs: EditorTab[],
    unloadActive: boolean
  ) => {
    if (tab.source.kind === 'home') return;
    const kind = tab.source.kind;
    const sessionKey = rendererSessionKey(tab);
    const releaseSession = !remainingTabs.some((candidate) => (
      candidate.source.kind === kind && rendererSessionKey(candidate) === sessionKey
    ));
    setWorkspaceDisposals((current) => ({
      ...current,
      [kind]: {
        token: ++disposeSequence.current,
        tabId: tab.id,
        sessionKey,
        releaseSession,
        unloadActive: unloadActive && releaseSession,
      },
    }));
  }, [rendererSessionKey]);

  const insertAfterActive = useCallback((tab: EditorTab) => {
    commitTabs((current) => {
      const activeIndex = current.findIndex((candidate) => candidate.id === activeTabIdRef.current);
      const index = activeIndex < 0 ? current.length : activeIndex + 1;
      return [...current.slice(0, index), tab, ...current.slice(index)];
    });
    activateEditorTab(tab, false);
  }, [activateEditorTab, commitTabs]);

  const replaceActiveTab = useCallback((tab: EditorTab) => {
    const currentTabs = tabsRef.current;
    const previous = currentTabs.find((candidate) => candidate.id === activeTabIdRef.current);
    const remainingTabs = currentTabs.filter((candidate) => candidate.id !== previous?.id);
    if (previous && (
      previous.source.kind !== tab.source.kind
      || rendererSessionKey(previous) !== rendererSessionKey(tab)
    )) {
      disposeTabSession(
        previous,
        [...remainingTabs, tab],
        previous.source.kind !== 'home'
          && workspaceOwnerTab.current[previous.source.kind] === previous.id
      );
    }
    if (
      previous
      && previous.source.kind !== 'home'
      && (
        previous.source.kind !== tab.source.kind
        || rendererSessionKey(previous) !== rendererSessionKey(tab)
      )
      && workspaceOwnerTab.current[previous.source.kind] === previous.id
    ) {
      const previousSessionKey = rendererSessionKey(previous);
      const survivingOwner = remainingTabs.find((candidate) => (
        candidate.source.kind === previous.source.kind
        && rendererSessionKey(candidate) === previousSessionKey
      ));
      if (tab.source.kind !== previous.source.kind && survivingOwner) {
        workspaceOwnerTab.current[previous.source.kind] = survivingOwner.id;
      } else {
        delete workspaceOwnerTab.current[previous.source.kind];
        blockedSourceSync.current.add(previous.source.kind);
      }
    }
    commitTabs((current) => {
      const index = current.findIndex((candidate) => candidate.id === activeTabIdRef.current);
      if (index < 0) return [...current, tab];
      const next = [...current];
      next[index] = tab;
      return next;
    });
    activateEditorTab(tab, false);
  }, [activateEditorTab, commitTabs, disposeTabSession, rendererSessionKey]);

  const openSource = useCallback((
    next: ActiveSource,
    disposition: OpenDisposition = 'current',
    tableName?: string,
    beginIntent = true
  ) => {
    if (beginIntent) openIntent.current += 1;
    setNotice(null);
    const identity = sourceIdentity(next, tableName);
    const alreadyOpen = tabsRef.current.find(
      (tab) => sourceIdentity(tab.source, tab.tableName) === identity
    );
    if (alreadyOpen && (disposition === 'new-tab' || alreadyOpen.id !== activeTabIdRef.current)) {
      activateEditorTab(alreadyOpen, false);
      return;
    }

    // Never replace an editor that still owns unsaved in-memory work. Opening
    // the requested source beside it is both safer and less interruptive than
    // blocking a Finder/API hand-off behind a modal.
    const active = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
    const effectiveDisposition = disposition === 'current'
      && active?.dirty
      && sourceIdentity(active.source, active.tableName) !== identity
        ? 'new-tab'
        : disposition;
    const tab: EditorTab = effectiveDisposition === 'new-tab'
      ? { id: createTabId(), source: next, tableName }
      : { id: activeTabIdRef.current, source: next, tableName };
    if (effectiveDisposition === 'new-tab') insertAfterActive(tab);
    else replaceActiveTab(tab);
  }, [activateEditorTab, createTabId, insertAfterActive, replaceActiveTab]);

  const openFile = useCallback((file: ProjectFileNode, disposition: OpenDisposition = 'current') => {
    openSource({
      kind: workspaceFor(file),
      path: file.path,
      name: file.name,
      fileType: file.fileType,
      pendingWal: file.pendingWal,
      requestVersion: ++requestSequence.current,
    }, disposition);
  }, [openSource]);

  const beginWorkspaceIntent = useCallback((kind: DataWorkspaceKind) => {
    openIntent.current += 1;
    blockedSourceSync.current.delete(kind);
  }, []);
  const beginGraphIntent = useCallback(
    () => beginWorkspaceIntent('graph'),
    [beginWorkspaceIntent]
  );
  const beginTableIntent = useCallback(
    () => beginWorkspaceIntent('table'),
    [beginWorkspaceIntent]
  );
  const beginVaultIntent = useCallback(
    () => beginWorkspaceIntent('vault'),
    [beginWorkspaceIntent]
  );

  const syncWorkspaceSource = useCallback((
    kind: DataWorkspaceKind,
    update: WorkspaceSourceUpdate,
    context: WorkspaceSyncContext
  ) => {
    // Closing/replacing the owning editor invalidates every completion from
    // that resident renderer until an explicit new intent reactivates it.
    if (blockedSourceSync.current.has(kind)) return;
    const currentOwnerId = workspaceOwnerTab.current[kind] ?? null;
    if (context.ownerTabId) {
      const origin = tabsRef.current.find((tab) => tab.id === context.ownerTabId);
      if (
        currentOwnerId !== context.ownerTabId
        || origin?.source.kind !== kind
        || origin.source.requestVersion !== context.requestVersion
      ) return;
    } else if (
      currentOwnerId !== null
      || workspaceSources.current[kind].requestVersion !== context.requestVersion
    ) {
      return;
    }

    const current = workspaceSources.current[kind];
    const next: ActiveSource = {
      ...current,
      name: update.name,
      path: update.path === undefined ? current.path : update.path,
      fileType: update.fileType
        ?? (kind === 'table' ? fileTypeForName(update.name) : kind === 'graph' ? 'graph' : undefined),
      pendingWal: update.pendingWal,
    };
    workspaceSources.current[kind] = next;
    const ownerId = workspaceOwnerTab.current[kind];
    const owner = ownerId
      ? tabsRef.current.find((tab) => tab.id === ownerId && tab.source.kind === kind)
      : undefined;
    if (owner) {
      const nextOwner = { ...owner, source: next };
      const sessionChanged = rendererSessionKey(owner) !== rendererSessionKey(nextOwner);
      if (sessionChanged) {
        // Child/API opens adopt the new engine before reporting it upward, so
        // release only the superseded cache here; unloading would close the new
        // source that is already live in the resident renderer.
        disposeTabSession(
          owner,
          tabsRef.current.filter((tab) => tab.id !== owner.id),
          false
        );
      }
      commitTabs((currentTabs) => currentTabs.map((tab) => (
        tab.id === owner.id
          ? { ...tab, source: next, tableName: sessionChanged ? undefined : tab.tableName }
          : tab
      )));
      return;
    }

    // A resident API/MCP adapter can adopt a file without an existing owner.
    // Materialise it in the root instead of leaving the loaded engine hidden.
    const active = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
    const tab: EditorTab = {
      id: active?.source.kind === 'home' ? active.id : createTabId(),
      source: next,
    };
    if (active?.source.kind === 'home') replaceActiveTab(tab);
    else insertAfterActive(tab);
  }, [commitTabs, createTabId, disposeTabSession, insertAfterActive, rendererSessionKey, replaceActiveTab]);

  const syncGraphSource = useCallback(
    (update: WorkspaceSourceUpdate, context: WorkspaceSyncContext) => (
      syncWorkspaceSource('graph', update, context)
    ),
    [syncWorkspaceSource]
  );
  const syncTableSource = useCallback(
    (update: WorkspaceSourceUpdate, context: WorkspaceSyncContext) => (
      syncWorkspaceSource('table', update, context)
    ),
    [syncWorkspaceSource]
  );
  const syncVaultSource = useCallback(
    (update: WorkspaceSourceUpdate, context: WorkspaceSyncContext) => (
      syncWorkspaceSource('vault', update, context)
    ),
    [syncWorkspaceSource]
  );

  const setWorkspaceDirty = useCallback((kind: DataWorkspaceKind, dirty: boolean) => {
    const ownerId = workspaceOwnerTab.current[kind];
    if (!ownerId) return;
    commitTabs((current) => current.map((tab) => (
      tab.id === ownerId && Boolean(tab.dirty) !== dirty
        ? { ...tab, dirty }
        : tab
    )));
  }, [commitTabs]);
  const setGraphDirty = useCallback(
    (dirty: boolean) => setWorkspaceDirty('graph', dirty),
    [setWorkspaceDirty]
  );
  const setTableDirty = useCallback(
    (dirty: boolean) => setWorkspaceDirty('table', dirty),
    [setWorkspaceDirty]
  );

  const revealWorkspaceOwner = useCallback((kind: DataWorkspaceKind) => {
    const ownerId = workspaceOwnerTab.current[kind];
    const owner = ownerId
      ? tabsRef.current.find((tab) => tab.id === ownerId && tab.source.kind === kind)
      : undefined;
    if (owner) activateEditorTab(owner, false);
  }, [activateEditorTab]);
  const revealGraphOwner = useCallback(
    () => revealWorkspaceOwner('graph'),
    [revealWorkspaceOwner]
  );
  const revealTableOwner = useCallback(
    () => revealWorkspaceOwner('table'),
    [revealWorkspaceOwner]
  );

  const openHome = useCallback(() => {
    openIntent.current += 1;
    const existing = tabsRef.current.find((tab) => tab.source.kind === 'home');
    if (existing) {
      activateEditorTab(existing, false);
      return;
    }
    insertAfterActive({
      id: createTabId(),
      source: newHomeSource(++requestSequence.current),
    });
  }, [activateEditorTab, createTabId, insertAfterActive]);

  const addBlankTab = useCallback(() => {
    openIntent.current += 1;
    insertAfterActive({
      id: createTabId(),
      source: newHomeSource(++requestSequence.current),
    });
  }, [createTabId, insertAfterActive]);

  const closeEditorTab = useCallback((id: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const closing = current[index];
    const remaining = current.filter((tab) => tab.id !== id);
    const closingOwnsWorkspace = closing.source.kind !== 'home'
      && workspaceOwnerTab.current[closing.source.kind] === id;
    disposeTabSession(closing, remaining, closingOwnsWorkspace);
    if (
      closingOwnsWorkspace
      && closing.source.kind !== 'home'
    ) {
      const sessionKey = rendererSessionKey(closing);
      const survivingOwner = remaining.find((tab) => (
        tab.source.kind === closing.source.kind
        && rendererSessionKey(tab) === sessionKey
      ));
      if (survivingOwner) {
        workspaceOwnerTab.current[closing.source.kind] = survivingOwner.id;
      } else {
        delete workspaceOwnerTab.current[closing.source.kind];
        blockedSourceSync.current.add(closing.source.kind);
      }
    }
    if (remaining.length === 0) {
      const home = { id: createTabId(), source: newHomeSource(++requestSequence.current) };
      tabsRef.current = [home];
      setTabs([home]);
      activateEditorTab(home);
      return;
    }
    tabsRef.current = remaining;
    setTabs(remaining);
    if (activeTabIdRef.current === id) {
      const previous = remaining.find((tab) => tab.id === previousActiveTabId.current);
      const next = previous ?? remaining[Math.min(index, remaining.length - 1)];
      activeTabIdRef.current = next.id;
      previousActiveTabId.current = null;
      activateEditorTab(next);
    } else if (previousActiveTabId.current === id) {
      previousActiveTabId.current = null;
    }
  }, [activateEditorTab, createTabId, disposeTabSession, rendererSessionKey]);

  const closeActiveTab = useCallback(() => {
    closeEditorTab(activeTabIdRef.current);
  }, [closeEditorTab]);

  const openTableInNewTab = useCallback((tableName: string) => {
    const ownerId = workspaceOwnerTab.current.table;
    const owner = tabsRef.current.find((tab) => tab.id === ownerId);
    const resident = owner?.source ?? workspaceSources.current.table;
    openSource(resident, 'new-tab', tableName);
  }, [openSource]);

  const revealGraphForExternalIngest = useCallback((): ExternalGraphTarget => {
    const ownerId = workspaceOwnerTab.current.graph;
    const owner = ownerId
      ? tabsRef.current.find((tab) => tab.id === ownerId && tab.source.kind === 'graph')
      : undefined;

    if (owner) {
      activateEditorTab(owner, false);
      return {
        sessionKey: owner.source.path ? null : `graph-tab:${owner.id}`,
        created: false,
      };
    }

    const graphTab: EditorTab = {
      id: tabsRef.current.find((tab) => tab.id === activeTabIdRef.current)?.source.kind === 'home'
        ? activeTabIdRef.current
        : createTabId(),
      source: {
        kind: 'graph',
        path: null,
        name: 'Browser-Import',
        fileType: 'graph',
        requestVersion: ++requestSequence.current,
      },
    };

    if (graphTab.id === activeTabIdRef.current) replaceActiveTab(graphTab);
    else insertAfterActive(graphTab);

    return { sessionKey: `graph-tab:${graphTab.id}`, created: true };
  }, [activateEditorTab, createTabId, insertAfterActive, replaceActiveTab]);

  const openStagedFile = useCallback((
    { name: filename, path, url, pendingWal }: StagedFile,
    existingIntent?: number
  ) => {
    const intent = existingIntent ?? ++openIntent.current;
    const adopt = (fileType: ProjectFileNode['fileType']) => {
      if (intent !== openIntent.current) return;
      openSource({
        kind: workspaceFor({ name: filename, fileType }),
        path,
        name: filename,
        fileType,
        pendingWal,
        requestVersion: ++requestSequence.current,
      }, 'current', undefined, false);
    };

    if (!filename.toLocaleLowerCase().endsWith('.json') || filename.toLocaleLowerCase().endsWith('.amqrun.json') || filename.toLocaleLowerCase().endsWith('.dbconnection.json')) {
      adopt(fileTypeForName(filename));
      return;
    }

    // Plain JSON is ambiguous: Phase-X and graph envelopes win over rows.
    void fetch(url)
      .then((response) => response.json())
      .then((value: unknown) => {
        const record = value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown>
          : null;
        const format = record?.format;
        if (format === 'amq.phase-x.run' || format === 'amq.phase-x.run-manifest') adopt('phase-x-run');
        else if (record && Array.isArray(record.nodes) && Array.isArray(record.edges)) adopt('graph');
        else adopt('json-table');
      })
      .catch(() => adopt('json-table'));
  }, [openSource]);

  const requestOpenFile = useCallback(() => {
    if (!isNativeHost()) return;
    const intent = ++openIntent.current;
    void files.pick()
      .then((file) => {
        if (intent === openIntent.current && file) openStagedFile(file, intent);
      })
      .catch((error) => {
        if (intent === openIntent.current) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      });
  }, [openStagedFile]);

  useEffect(() => onNativeFileStaged(({ filename, path, url, pendingWal }) => {
    openStagedFile({ name: filename, path, url, pendingWal });
  }), [openStagedFile]);

  return {
    tabs,
    activeTabId,
    source,
    notice,
    reportNotice,
    clearNotice,
    graphSource: workspaceSources.current.graph,
    tableSource: workspaceSources.current.table,
    vaultSource: workspaceSources.current.vault,
    graphOwnerTabId: workspaceOwnerTab.current.graph,
    tableOwnerTabId: workspaceOwnerTab.current.table,
    vaultOwnerTabId: workspaceOwnerTab.current.vault,
    graphDisposeEvent: workspaceDisposals.graph,
    tableDisposeEvent: workspaceDisposals.table,
    vaultDisposeEvent: workspaceDisposals.vault,
    selectEditorTab,
    closeEditorTab,
    closeActiveTab,
    addBlankTab,
    openFile,
    openHome,
    requestOpenFile,
    beginGraphIntent,
    beginTableIntent,
    beginVaultIntent,
    syncGraphSource,
    syncTableSource,
    syncVaultSource,
    setGraphDirty,
    setTableDirty,
    revealGraphOwner,
    revealTableOwner,
    revealGraphForExternalIngest,
    openTableInNewTab,
  };
}

export type WorkbenchController = ReturnType<typeof useWorkbenchController>;
