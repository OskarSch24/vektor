import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { ProjectSidebar } from './components/ProjectSidebar';
import { EditorTabs } from './components/workbench/EditorTabs';
import { WorkspaceHost } from './components/workbench/WorkspaceHost';
import { WorkbenchStatusbar } from './components/workbench/WorkbenchStatusbar';
import { WorkbenchTitlebar } from './components/workbench/WorkbenchTitlebar';
import { UnsavedChangesDialog } from './components/workbench/UnsavedChangesDialog';
import { useProjects } from './hooks/useProjects';
import { useWindowDrag } from './hooks/useWindowDrag';
import { useWorkbenchShortcuts } from './hooks/useWorkbenchShortcuts';
import { useQuickOpen } from './hooks/useQuickOpen';
import { setActiveApiAdapter } from './services/api/dispatcher';
import { isNativeHost } from './services/nativeHost';
import { useWorkbenchController } from './workbench/useWorkbenchController';

const QuickOpen = lazy(async () => ({
  default: (await import('./components/workbench/QuickOpen')).QuickOpen,
}));

export const App: FC = () => {
  const workbench = useWorkbenchController();
  const projects = useProjects(workbench.reportNotice);
  const nativeHost = isNativeHost();
  const quickOpen = useQuickOpen();
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);

  const totalSources = useMemo(
    () => projects.projects.reduce((sum, project) => sum + project.fileCount, 0),
    [projects.projects]
  );

  useEffect(() => {
    if (workbench.source.kind === 'table') setActiveApiAdapter('sqlite');
    else if (workbench.source.kind === 'vault') setActiveApiAdapter('vault');
    else if (workbench.source.kind === 'graph') setActiveApiAdapter('graph');
  }, [workbench.source.kind]);

  const requestCloseTab = useCallback((id: string) => {
    const tab = workbench.tabs.find((candidate) => candidate.id === id);
    if (tab?.dirty) {
      workbench.selectEditorTab(id);
      setPendingCloseId(id);
      return;
    }
    workbench.closeEditorTab(id);
  }, [workbench]);

  const requestCloseActiveTab = useCallback(() => {
    requestCloseTab(workbench.activeTabId);
  }, [requestCloseTab, workbench.activeTabId]);

  const pendingCloseTab = pendingCloseId
    ? workbench.tabs.find((tab) => tab.id === pendingCloseId)
    : undefined;

  useEffect(() => {
    if (pendingCloseId && !pendingCloseTab) setPendingCloseId(null);
  }, [pendingCloseId, pendingCloseTab]);

  useWorkbenchShortcuts({
    toggleExplorer: projects.toggleCollapsed,
    addBlankTab: workbench.addBlankTab,
    closeActiveTab: requestCloseActiveTab,
    openFile: workbench.requestOpenFile,
  });
  useWindowDrag(`${workbench.source.kind}|${workbench.source.name}|${projects.isCollapsed}`);

  return (
    <div className="cursor-shell h-screen w-screen overflow-hidden bg-apple-bg text-apple-text-primary font-sans flex flex-col">
      <WorkbenchTitlebar
        source={workbench.source}
        nativeHost={nativeHost}
        explorerCollapsed={projects.isCollapsed}
        onOpenHome={workbench.openHome}
        onToggleExplorer={projects.toggleCollapsed}
        onOpenQuick={quickOpen.openQuickOpen}
      />

      <main className="flex-1 min-h-0 flex overflow-hidden">
        <ProjectSidebar
          projects={projects.projects}
          isCollapsed={projects.isCollapsed}
          isBusy={projects.isBusy}
          isSupported={projects.isSupported}
          activePath={workbench.source.path}
          onToggleCollapsed={projects.toggleCollapsed}
          onAddProject={() => void projects.addProject()}
          onRemoveProject={(id) => void projects.removeProject(id)}
          onRefreshProject={(id) => void projects.refreshProject(id)}
          onOpenFile={workbench.openFile}
          hideCollapsedRail
        />

        <section className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col bg-[#181818]">
          <EditorTabs
            tabs={workbench.tabs}
            activeId={workbench.activeTabId}
            onSelect={workbench.selectEditorTab}
            onClose={requestCloseTab}
            onAdd={workbench.addBlankTab}
          />

          {workbench.notice && (
            <div className="cursor-notice shrink-0 flex items-center gap-2 border-b border-apple-amber/20 bg-apple-amber/[0.07] px-3 py-1.5 text-[11px] text-apple-amber">
              <span className="h-1.5 w-1.5 rounded-full bg-apple-amber" />
              <span className="flex-1 truncate">{workbench.notice}</span>
              <button
                onClick={workbench.clearNotice}
                className="text-apple-text-tertiary hover:text-white"
              >
                Schließen
              </button>
            </div>
          )}

          <WorkspaceHost
            workbench={workbench}
            nativeHost={nativeHost}
            projectCount={projects.projects.length}
            sourceCount={totalSources}
            nativeProjects={projects.isSupported}
            onAddProject={() => void projects.addProject()}
          />
        </section>
      </main>

      <WorkbenchStatusbar
        source={workbench.source}
        projectCount={projects.projects.length}
        sourceCount={totalSources}
        nativeHost={nativeHost}
      />

      <UnsavedChangesDialog
        filename={pendingCloseTab?.source.name ?? null}
        onCancel={() => setPendingCloseId(null)}
        onDiscard={() => {
          if (pendingCloseId) workbench.closeEditorTab(pendingCloseId);
          setPendingCloseId(null);
        }}
        onSave={() => {
          if (pendingCloseId) workbench.selectEditorTab(pendingCloseId);
          setPendingCloseId(null);
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              window.dispatchEvent(new Event('database-studio:save-active'));
            });
          });
        }}
      />
      {quickOpen.quickOpenVisible && (
        <Suspense fallback={null}>
          <QuickOpen
            visible
            projects={projects.projects}
            onClose={quickOpen.closeQuickOpen}
            onOpen={workbench.openFile}
          />
        </Suspense>
      )}
    </div>
  );
};
