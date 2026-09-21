import React from 'react';
import type { ActiveTab } from '../types/graph';
import { ApiPanel } from './ApiPanel';
import { EmptyState } from './EmptyState';
import { GraphCanvas } from './GraphCanvas';
import { IngestPanel } from './IngestPanel';
import { NodeInspector } from './NodeInspector';
import { NoticeBanner } from './NoticeBanner';
import { OntologyViewer } from './OntologyViewer';
import { PhaseXHierarchyView } from './PhaseXHierarchyView';
import { ProjectSidebar } from './ProjectSidebar';
import { QueryView } from './QueryView';
import { SettingsModal } from './SettingsModal';
import { Sidebar } from './Sidebar';
import { StatsViewer } from './StatsViewer';
import { TitleBar } from './TitleBar';

interface GraphWorkspaceViewProps {
  embedded: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileSelected: (file: File) => void;
  titleBarProps: React.ComponentProps<typeof TitleBar>;
  noticeBannerProps: React.ComponentProps<typeof NoticeBanner>;
  projectSidebarProps: React.ComponentProps<typeof ProjectSidebar> | null;
  hasGraph: boolean;
  activeTab: ActiveTab;
  emptyStateProps: React.ComponentProps<typeof EmptyState>;
  sidebarProps: React.ComponentProps<typeof Sidebar>;
  graphCanvasProps: React.ComponentProps<typeof GraphCanvas>;
  nodeInspectorProps: React.ComponentProps<typeof NodeInspector> | null;
  hierarchyProps: React.ComponentProps<typeof PhaseXHierarchyView> | null;
  queryViewProps: React.ComponentProps<typeof QueryView>;
  ontologyViewerProps: React.ComponentProps<typeof OntologyViewer>;
  ingestPanelProps: React.ComponentProps<typeof IngestPanel>;
  statsViewerProps: React.ComponentProps<typeof StatsViewer>;
  graphApiPanelProps: React.ComponentProps<typeof ApiPanel>;
  settingsModalProps: React.ComponentProps<typeof SettingsModal>;
}

/**
 * Pure composition for the graph workspace. State, persistence, native-host
 * wiring and all mutations remain owned by GraphStudio.
 */
export const GraphWorkspaceView: React.FC<GraphWorkspaceViewProps> = ({
  embedded,
  fileInputRef,
  onFileSelected,
  titleBarProps,
  noticeBannerProps,
  projectSidebarProps,
  hasGraph,
  activeTab,
  emptyStateProps,
  sidebarProps,
  graphCanvasProps,
  nodeInspectorProps,
  hierarchyProps,
  queryViewProps,
  ontologyViewerProps,
  ingestPanelProps,
  statsViewerProps,
  graphApiPanelProps,
  settingsModalProps,
}) => (
  <div className={`${embedded ? 'w-full' : 'w-screen'} h-full flex flex-col bg-apple-bg text-apple-text-primary overflow-hidden font-sans`}>
    <input
      type="file"
      ref={fileInputRef}
      accept=".graph,.amqrun,.amqrun.json,.json,application/json"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) onFileSelected(file);
      }}
    />

    <TitleBar {...titleBarProps} />

    <NoticeBanner {...noticeBannerProps} />

    <main className="flex-1 flex min-h-0 overflow-hidden">
      {projectSidebarProps && <ProjectSidebar {...projectSidebarProps} />}

      {activeTab === 'api' && !hasGraph ? (
        <ApiPanel sampleLabel={null} />
      ) : !hasGraph ? (
        <EmptyState {...emptyStateProps} />
      ) : (
        <>
          {activeTab !== 'hierarchy' && <Sidebar {...sidebarProps} />}

          <div className="flex-1 flex min-w-0 h-full overflow-hidden">
            {activeTab === 'graph' && (
              <>
                <GraphCanvas {...graphCanvasProps} />
                {nodeInspectorProps && <NodeInspector {...nodeInspectorProps} />}
              </>
            )}

            {activeTab === 'hierarchy' && hierarchyProps && (
              <PhaseXHierarchyView {...hierarchyProps} />
            )}

            {activeTab === 'query' && <QueryView {...queryViewProps} />}

            {activeTab === 'ontology' && <OntologyViewer {...ontologyViewerProps} />}

            {activeTab === 'ingest' && <IngestPanel {...ingestPanelProps} />}

            {activeTab === 'stats' && <StatsViewer {...statsViewerProps} />}

            {activeTab === 'api' && <ApiPanel {...graphApiPanelProps} />}
          </div>
        </>
      )}
    </main>

    <SettingsModal {...settingsModalProps} />
  </div>
);
