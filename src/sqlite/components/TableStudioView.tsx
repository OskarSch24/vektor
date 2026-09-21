import React, { lazy, Suspense } from 'react';
import type { ChangeEventHandler, ReactNode, RefObject } from 'react';
import type { ActiveTab, DatabaseMetadata } from '../types/sqlite';
import { dbEngine } from '../services/dbEngine';
import type { TablePageLoader } from '../services/tableFilters';
import type { Notice } from './NoticeBanner';
import { TitleBar } from './TitleBar';
import { NoticeBanner } from './NoticeBanner';
import { ApiPanel } from './ApiPanel';
import { Sidebar } from './Sidebar';
import { DataBrowser, type DataBrowserNavigationFilter } from './DataBrowser';
import type { ForeignKeyNavigationTarget } from './RelationalDataGrid';
import { SqlEditor } from './SqlEditor';
import { SchemaViewer } from './SchemaViewer';
import { StatsViewer } from './StatsViewer';
import { ExportModal } from './ExportModal';
import type { MergeFilesReport } from './MergeFilesModal';
import type { ImportedTable } from '../services/importers';
const DataViews = lazy(async () => ({ default: (await import('./views/DataViews')).DataViews }));

const loadTablePage: TablePageLoader = (tableName, options) => (
  dbEngine.getTableData(tableName, options)
);

const MergeFilesModal = lazy(async () => ({
  default: (await import('./MergeFilesModal')).MergeFilesModal,
}));

export interface TableStudioViewProps {
  embedded: boolean;
  fileInputRef: RefObject<HTMLInputElement>;
  fileInputAccept: string;
  onFileInputChange: ChangeEventHandler<HTMLInputElement>;
  metadata: DatabaseMetadata | null;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onOpenFile: () => void;
  onOpenExport: () => void;
  notice: Notice | null;
  onDismissNotice: () => void;
  isLoading: boolean;
  activeTable: string | null;
  sourcePath?: string | null;
  schemaVersion: number;
  onSelectTable: (tableName: string) => void;
  onOpenTableInNewTab?: (tableName: string) => void;
  onSchemaChanged: () => void;
  isExportOpen: boolean;
  onCloseExport: () => void;
  onError: (message: string) => void;
  onDatabaseExported?: () => void;
  isMergeOpen?: boolean;
  onOpenMerge?: () => void;
  onCloseMerge?: () => void;
  onMerged?: (tables: ImportedTable[], report: MergeFilesReport) => void | Promise<void>;
  mergeDisabled?: boolean;
  navigationFilter?: DataBrowserNavigationFilter;
  onNavigateForeignKey?: (target: ForeignKeyNavigationTarget) => void;
  /** Standalone-only chrome supplied from its lazy module. */
  leadingPane?: ReactNode;
  /** Standalone-only empty state supplied from its lazy module. */
  emptyView?: ReactNode;
}

/**
 * Pure composition layer for Table Studio. Database ownership, sessions and
 * side effects deliberately stay in the controller component.
 */
export const TableStudioView: React.FC<TableStudioViewProps> = ({
  embedded,
  fileInputRef,
  fileInputAccept,
  onFileInputChange,
  metadata,
  activeTab,
  onTabChange,
  onOpenFile,
  onOpenExport,
  notice,
  onDismissNotice,
  isLoading,
  activeTable,
  sourcePath,
  schemaVersion,
  onSelectTable,
  onOpenTableInNewTab,
  onSchemaChanged,
  isExportOpen,
  onCloseExport,
  onError,
  onDatabaseExported,
  isMergeOpen = false,
  onOpenMerge,
  onCloseMerge,
  onMerged,
  mergeDisabled = false,
  navigationFilter,
  onNavigateForeignKey,
  leadingPane = null,
  emptyView = null,
}) => (
  <div className={`${embedded ? 'w-full' : 'w-screen'} h-full flex flex-col bg-apple-bg text-apple-text-primary overflow-hidden font-sans`}>
    <input
      type="file"
      ref={fileInputRef}
      onChange={onFileInputChange}
      accept={fileInputAccept}
      className="hidden"
    />

    <TitleBar
      embedded={embedded}
      metadata={metadata}
      activeTab={activeTab}
      onTabChange={onTabChange}
      onOpenFile={onOpenFile}
      onExport={onOpenExport}
      warningMessage={notice?.tone === 'warning' ? notice.message : null}
      statusMessage={notice?.tone === 'success' ? notice.message : null}
      onMergeFiles={onOpenMerge}
      mergeDisabled={mergeDisabled}
    />

    <NoticeBanner
      notice={notice?.tone === 'error' ? notice : null}
      onDismiss={onDismissNotice}
    />

    <main className="flex-1 flex min-h-0 relative overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-md flex flex-col items-center justify-center space-y-3 select-none">
          <div className="w-8 h-8 rounded-full border-2 border-apple-blue border-t-transparent animate-spin" />
          <p className="text-xs font-medium text-white tracking-wide">
            Datenbank wird geladen…
          </p>
        </div>
      )}

      {leadingPane}

      {activeTab === 'api' && !metadata ? (
        <ApiPanel sampleTable={null} />
      ) : !metadata ? (
        emptyView || <div className="flex-1 bg-[#181818]" />
      ) : (
        <div className="flex-1 flex h-full min-w-0 overflow-hidden">
          <Sidebar
            metadata={metadata}
            selectedTable={activeTable}
            onSelectTable={onSelectTable}
            onOpenTableInNewTab={onOpenTableInNewTab ? (table) => onOpenTableInNewTab(table.name) : undefined}
          />

          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
            {activeTab === 'data' && (
              <Suspense fallback={<div className="p-5 text-xs">Ansicht wird geladen…</div>}>
              <DataViews key={`${metadata.filename}:${activeTable}:${schemaVersion}`} metadata={metadata} tableName={activeTable} schemaVersion={schemaVersion} sourcePath={sourcePath} onSelectTable={onSelectTable}>
              <DataBrowser
                metadata={metadata}
                activeTableName={activeTable}
                schemaVersion={schemaVersion}
                onOpenExport={onOpenExport}
                loadPage={loadTablePage}
                navigationFilter={navigationFilter}
                onNavigateForeignKey={onNavigateForeignKey}
              />
              </DataViews>
              </Suspense>
            )}

            {activeTab === 'query' && (
              <SqlEditor metadata={metadata} onSchemaChanged={onSchemaChanged} />
            )}

            {activeTab === 'schema' && (
              <SchemaViewer metadata={metadata} activeTableName={activeTable} />
            )}

            {activeTab === 'stats' && <StatsViewer metadata={metadata} />}

            {activeTab === 'api' && <ApiPanel sampleTable={activeTable} />}
          </div>
        </div>
      )}
    </main>

    <ExportModal
      isOpen={isExportOpen}
      onClose={onCloseExport}
      onError={onError}
      metadata={metadata}
      activeTable={activeTable}
      onDatabaseExported={onDatabaseExported}
    />
    {isMergeOpen && onCloseMerge && onMerged && (
      <Suspense fallback={null}>
        <MergeFilesModal
          isOpen
          onClose={onCloseMerge}
          onMerged={onMerged}
        />
      </Suspense>
    )}
  </div>
);
