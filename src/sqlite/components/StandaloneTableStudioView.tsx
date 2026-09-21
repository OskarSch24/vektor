import React, { useCallback, useEffect } from 'react';
import type { ProjectFileNode } from '../types/projects';
import { useProjects } from '../hooks/useProjects';
import { DropZone } from './DropZone';
import { ProjectSidebar } from './ProjectSidebar';
import { TableStudioView } from './TableStudioView';
import type { TableStudioViewProps } from './TableStudioView';

type ReadProjectFile = (file: ProjectFileNode) => Promise<ArrayBuffer>;

export type StandaloneTableStudioViewProps = Omit<
  TableStudioViewProps,
  'embedded' | 'leadingPane' | 'emptyView'
> & {
  active: boolean;
  activeFileId: string | null;
  onFileLoaded: (file: File) => void;
  onOpenProjectFile: (file: ProjectFileNode, readFile: ReadProjectFile) => void;
};

/**
 * Standalone-only project and welcome chrome. Keeping this in a lazy module
 * prevents the unified app from downloading or evaluating it.
 */
export const StandaloneTableStudioView: React.FC<StandaloneTableStudioViewProps> = ({
  active,
  activeFileId,
  onFileLoaded,
  onOpenProjectFile,
  ...viewProps
}) => {
  const projects = useProjects(viewProps.onError);
  const { readProjectFile, toggleCollapsed } = projects;

  useEffect(() => {
    if (!active) return;
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [active, toggleCollapsed]);

  const handleOpenProjectFile = useCallback(
    (file: ProjectFileNode) => onOpenProjectFile(file, readProjectFile),
    [onOpenProjectFile, readProjectFile]
  );

  return (
    <TableStudioView
      {...viewProps}
      embedded={false}
      leadingPane={(
        <ProjectSidebar
          projects={projects.projects}
          enabledFormats={projects.enabledFormats}
          onToggleFormat={projects.toggleFormat}
          activeFileId={activeFileId}
          isCollapsed={projects.isCollapsed}
          isBusy={projects.isBusy}
          isPersistent={projects.isPersistent}
          onToggleCollapsed={projects.toggleCollapsed}
          onAddProject={projects.addProject}
          onRemoveProject={projects.removeProject}
          onRefreshProject={projects.refreshProject}
          onOpenFile={handleOpenProjectFile}
        />
      )}
      emptyView={(
        <DropZone
          onFileLoaded={onFileLoaded}
          onOpenFile={viewProps.onOpenFile}
          isLoading={viewProps.isLoading}
        />
      )}
    />
  );
};
