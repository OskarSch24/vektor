import { Suspense, useCallback, useEffect, useRef } from 'react';
import { announceReady } from '../../services/nativeHost';
import {
  sourceIdentity,
  type WorkspaceSyncContext,
  type WorkspaceSourceUpdate,
} from '../../workbench/model';
import {
  GraphStudio,
  TableStudio,
  VaultStudio,
  useResidentWorkspaces,
} from '../../workbench/useResidentWorkspaces';
import type { WorkbenchController } from '../../workbench/useWorkbenchController';
import { DataRoom } from './DataRoom';
import { WorkspaceBoundary } from './WorkspaceBoundary';
import { WorkspaceLoading } from './WorkspaceLoading';

interface WorkspaceHostProps {
  workbench: WorkbenchController;
  nativeHost: boolean;
  projectCount: number;
  sourceCount: number;
  nativeProjects: boolean;
  onAddProject: () => void;
}

/** Hosts exactly one persistent instance of each database renderer. */
export function WorkspaceHost({
  workbench,
  nativeHost,
  projectCount,
  sourceCount,
  nativeProjects,
  onAddProject,
}: WorkspaceHostProps) {
  const {
    allAdaptersReady,
    mountGraph,
    mountTable,
    mountVault,
    onGraphReadyChange,
    onTableReadyChange,
    onVaultReadyChange,
  } = useResidentWorkspaces(workbench.source.kind);
  const didAnnounceReady = useRef(false);

  useEffect(() => {
    if (!allAdaptersReady || didAnnounceReady.current) return;
    didAnnounceReady.current = true;
    announceReady();
  }, [allAdaptersReady]);

  const activeTableName = workbench.tabs.find(
    (tab) => tab.id === workbench.tableOwnerTabId
  )?.tableName;
  const graphSyncContext = useRef<WorkspaceSyncContext>({
    ownerTabId: workbench.graphOwnerTabId ?? null,
    requestVersion: workbench.graphSource.requestVersion,
  });
  const tableSyncContext = useRef<WorkspaceSyncContext>({
    ownerTabId: workbench.tableOwnerTabId ?? null,
    requestVersion: workbench.tableSource.requestVersion,
  });
  const vaultSyncContext = useRef<WorkspaceSyncContext>({
    ownerTabId: workbench.vaultOwnerTabId ?? null,
    requestVersion: workbench.vaultSource.requestVersion,
  });
  graphSyncContext.current = {
    ownerTabId: workbench.graphOwnerTabId ?? null,
    requestVersion: workbench.graphSource.requestVersion,
  };
  tableSyncContext.current = {
    ownerTabId: workbench.tableOwnerTabId ?? null,
    requestVersion: workbench.tableSource.requestVersion,
  };
  vaultSyncContext.current = {
    ownerTabId: workbench.vaultOwnerTabId ?? null,
    requestVersion: workbench.vaultSource.requestVersion,
  };
  const syncGraphSource = useCallback((update: WorkspaceSourceUpdate) => {
    workbench.syncGraphSource(update, graphSyncContext.current);
  }, [workbench.syncGraphSource]);
  const syncTableSource = useCallback((update: WorkspaceSourceUpdate) => {
    workbench.syncTableSource(update, tableSyncContext.current);
  }, [workbench.syncTableSource]);
  const syncVaultSource = useCallback((update: WorkspaceSourceUpdate) => {
    workbench.syncVaultSource(update, vaultSyncContext.current);
  }, [workbench.syncVaultSource]);

  return (
    <div className="flex-1 min-h-0 overflow-hidden database-workspace">
      {workbench.source.kind === 'home' && (
        <DataRoom
          projectCount={projectCount}
          sourceCount={sourceCount}
          nativeProjects={nativeProjects}
          onOpenFile={workbench.requestOpenFile}
          onAddProject={onAddProject}
        />
      )}

      {mountGraph && (
        <div
          className={workbench.source.kind === 'graph' ? 'h-full' : 'hidden'}
          aria-hidden={workbench.source.kind !== 'graph'}
        >
          <WorkspaceBoundary label="Graph">
            <Suspense fallback={<WorkspaceLoading label="Graph wird geladen" />}>
              <GraphStudio
                embedded
                active={workbench.source.kind === 'graph'}
                requestedPath={workbench.graphOwnerTabId ? workbench.graphSource.path : null}
                requestVersion={workbench.graphSource.requestVersion}
                editorTabId={workbench.graphOwnerTabId}
                pathlessSessionKey={
                  workbench.graphSource.path === null && workbench.graphOwnerTabId
                    ? `graph-tab:${workbench.graphOwnerTabId}`
                    : null
                }
                disposeEvent={workbench.graphDisposeEvent}
                onRequestOpen={nativeHost ? workbench.requestOpenFile : undefined}
                onSourceIntent={workbench.beginGraphIntent}
                onSourceChanged={syncGraphSource}
                onExternalOpen={workbench.revealGraphOwner}
                onExternalIngestTarget={workbench.revealGraphForExternalIngest}
                onReadyChange={onGraphReadyChange}
                onDirtyChange={workbench.setGraphDirty}
              />
            </Suspense>
          </WorkspaceBoundary>
        </div>
      )}

      {mountTable && (
        <div
          className={workbench.source.kind === 'table' ? 'h-full' : 'hidden'}
          aria-hidden={workbench.source.kind !== 'table'}
        >
          <WorkspaceBoundary label="Tabelle">
            <Suspense fallback={<WorkspaceLoading label="Tabelle wird geladen" />}>
              <TableStudio
                embedded
                active={workbench.source.kind === 'table'}
                requestedPath={workbench.tableOwnerTabId ? workbench.tableSource.path : null}
                requestVersion={workbench.tableSource.requestVersion}
                sourceSessionKey={sourceIdentity(workbench.tableSource)}
                pendingWal={workbench.tableSource.pendingWal}
                editorTabId={workbench.tableOwnerTabId}
                requestedTableName={activeTableName}
                disposeEvent={workbench.tableDisposeEvent}
                onRequestOpen={nativeHost ? workbench.requestOpenFile : undefined}
                onSourceIntent={workbench.beginTableIntent}
                onSourceChanged={syncTableSource}
                onExternalOpen={workbench.revealTableOwner}
                onOpenTableInNewTab={workbench.openTableInNewTab}
                onReadyChange={onTableReadyChange}
                onDirtyChange={workbench.setTableDirty}
              />
            </Suspense>
          </WorkspaceBoundary>
        </div>
      )}

      {mountVault && (
        <div
          className={workbench.source.kind === 'vault' ? 'h-full' : 'hidden'}
          aria-hidden={workbench.source.kind !== 'vault'}
        >
          <WorkspaceBoundary label="Redis-Speicherstand">
            <Suspense fallback={<WorkspaceLoading label="Redis-Speicherstand wird geladen" />}>
              <VaultStudio
                embedded
                active={workbench.source.kind === 'vault'}
                requestedPath={
                  (workbench.vaultSource.fileType === 'redis-rdb'
                    || workbench.vaultSource.fileType === 'redis-aof')
                    && workbench.vaultOwnerTabId
                    ? workbench.vaultSource.path
                    : null
                }
                requestVersion={workbench.vaultSource.requestVersion}
                disposeEvent={workbench.vaultDisposeEvent}
                onSourceIntent={workbench.beginVaultIntent}
                onSourceChanged={syncVaultSource}
                onReadyChange={onVaultReadyChange}
              />
            </Suspense>
          </WorkspaceBoundary>
        </div>
      )}
    </div>
  );
}
