import { useCallback, useEffect, useState } from 'react';
import { Project } from '../types/projects';
import { isNativeHost, projectStore } from '../services/nativeHost';
import { notifyProjectsChanged, subscribeProjectsChanged } from '../services/projectEvents';

const COLLAPSED_STORAGE_KEY = 'graph-studio.projects-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Owns the list of project folders and whether their sidebar is collapsed.
 *
 * Scanning folders means reading the real file system, which only the packaged
 * app can do — in a browser the hook stays empty and reports itself as
 * unsupported rather than pretending.
 */
export function useProjects(onError: (message: string) => void, enabled = true) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isLoading, setIsLoading] = useState(() => enabled && isNativeHost());
  const [isCollapsed, setIsCollapsed] = useState(readCollapsed);

  const isSupported = enabled && isNativeHost();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(isCollapsed));
    } catch {
      // A blocked storage quota must not break the toggle.
    }
  }, [isCollapsed]);

  const reload = useCallback(
    (signal?: { cancelled: boolean }) => {
      if (!isSupported) {
        setIsLoading(false);
        return Promise.resolve();
      }
      setIsLoading(true);
      return projectStore
        .list()
        .then((restored) => {
          if (signal?.cancelled) return;
          // Show every saved root immediately. Deep scans are independent and
          // arrive one by one, so one large checkout cannot hold the complete
          // Explorer (or the browser extension's project picker) hostage.
          setProjects(restored);
          for (const project of restored) {
            void projectStore
              .refresh(project.id)
              .then((refreshed) => {
                if (signal?.cancelled || !refreshed) return;
                setProjects((current) => current.map((entry) => (
                  entry.id === refreshed.id ? refreshed : entry
                )));
              })
              .catch((err) => {
                if (!signal?.cancelled) {
                  onError(`„${project.name}“ konnte nicht eingelesen werden: ${err?.message || err}`);
                }
              });
          }
        })
        .catch((err) => onError(`Projekte konnten nicht geladen werden: ${err?.message || err}`))
        .finally(() => {
          if (!signal?.cancelled) setIsLoading(false);
        });
    },
    [isSupported, onError]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void reload(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [reload]);

  useEffect(() => subscribeProjectsChanged(() => void reload()), [reload]);

  const addProject = useCallback(async () => {
    setIsBusy(true);
    try {
      const added = await projectStore.add();
      if (!added) return;

      setProjects((previous) => [...previous.filter((p) => p.id !== added.id), added]);
      setIsCollapsed(false);
      notifyProjectsChanged();

      if (added.fileCount === 0) {
        onError(`In "${added.name}" wurden keine unterstützten Datenquellen gefunden.`);
      }
    } catch (err: any) {
      onError(`Ordner konnte nicht hinzugefügt werden: ${err?.message || err}`);
    } finally {
      setIsBusy(false);
    }
  }, [onError]);

  const removeProject = useCallback(
    async (id: string) => {
      // Dropped from the view first: the list must not wait on the host.
      setProjects((previous) => previous.filter((project) => project.id !== id));
      try {
        await projectStore.remove(id);
        notifyProjectsChanged();
      } catch (err: any) {
        onError(`Projekt konnte nicht entfernt werden: ${err?.message || err}`);
      }
    },
    [onError]
  );

  const refreshProject = useCallback(
    async (id: string) => {
      try {
        const refreshed = await projectStore.refresh(id);
        setProjects((previous) =>
          refreshed
            ? previous.map((project) => (project.id === id ? refreshed : project))
            : previous.filter((project) => project.id !== id)
        );
        notifyProjectsChanged();
      } catch (err: any) {
        onError(`Ordner konnte nicht neu eingelesen werden: ${err?.message || err}`);
      }
    },
    [onError]
  );

  const toggleCollapsed = useCallback(() => setIsCollapsed((collapsed) => !collapsed), []);

  return {
    projects,
    isBusy,
    isLoading,
    isCollapsed,
    isSupported,
    toggleCollapsed,
    addProject,
    removeProject,
    refreshProject,
    reload,
  };
}
