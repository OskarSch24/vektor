import { useCallback, useEffect, useState } from 'react';
import { projectSource } from '../services/projects';
import { FileFormat } from '../services/importers';
import { Project, ProjectFileNode } from '../types/projects';

const COLLAPSED_STORAGE_KEY = 'sqlite-studio.projects-collapsed';
const FORMATS_STORAGE_KEY = 'sqlite-studio.project-formats';

/** All supported source formats are visible when no preference was saved. */
const DEFAULT_FORMATS: FileFormat[] = ['sqlite', 'csv', 'xlsx', 'json', 'document', 'parquet', 'arrow', 'duckdb', 'connection'];

function readEnabledFormats(): Set<FileFormat> {
  try {
    const saved = localStorage.getItem(FORMATS_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : null;
    return new Set(Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_FORMATS);
  } catch {
    return new Set(DEFAULT_FORMATS);
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Owns the list of project folders and the collapsed state of their sidebar.
 * Errors are reported through `onError` instead of thrown, so a broken project
 * never takes the whole app down.
 */
export function useProjects(onError: (message: string) => void, enabled = true) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(readCollapsed);
  const [enabledFormats, setEnabledFormats] = useState<Set<FileFormat>>(readEnabledFormats);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(isCollapsed));
    } catch {
      // A blocked storage quota must not break the toggle.
    }
  }, [isCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(FORMATS_STORAGE_KEY, JSON.stringify([...enabledFormats]));
    } catch {
      // A blocked storage quota must not break the filter.
    }
  }, [enabledFormats]);

  const toggleFormat = useCallback((format: FileFormat) => {
    setEnabledFormats((previous) => {
      const next = new Set(previous);
      if (!next.delete(format)) next.add(format);
      return next;
    });
  }, []);

  const reload = useCallback(
    (signal?: { cancelled: boolean }) => {
      if (!enabled) return Promise.resolve();
      return projectSource
        .list()
        .then((restored) => {
          if (!signal?.cancelled) setProjects(restored);
        })
        .catch((err) => onError(`Projekte konnten nicht geladen werden: ${err?.message || err}`));
    },
    [enabled, onError]
  );

  // Restore persisted projects from the native host on start-up.
  useEffect(() => {
    const signal = { cancelled: false };
    void reload(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [reload]);

  // The host can also add a folder through its own menu, outside of any RPC call.
  useEffect(() => {
    if (!enabled) return;
    const bridge = (window.sqliteStudio ??= {});
    bridge.projectsChanged = () => {
      setIsCollapsed(false);
      void reload();
    };
    return () => {
      delete bridge.projectsChanged;
    };
  }, [enabled, reload]);

  const addProject = useCallback(async () => {
    setIsBusy(true);
    try {
      const added = await projectSource.add();
      if (!added) return;
      setProjects((previous) => [
        ...previous.filter((project) => project.id !== added.id),
        added,
      ]);
      setIsCollapsed(false);
      if (added.fileCount === 0) {
        onError(`In "${added.name}" wurden keine SQLite-Datenbanken gefunden.`);
      }
    } catch (err: any) {
      onError(`Ordner konnte nicht hinzugefügt werden: ${err?.message || err}`);
    } finally {
      setIsBusy(false);
    }
  }, [onError]);

  const removeProject = useCallback(
    async (projectId: string) => {
      // Drop it from the UI first — the list must not depend on the host answering.
      setProjects((previous) => previous.filter((project) => project.id !== projectId));
      try {
        await projectSource.remove(projectId);
      } catch (err: any) {
        onError(`Projekt konnte nicht entfernt werden: ${err?.message || err}`);
      }
    },
    [onError]
  );

  const refreshProject = useCallback(
    async (projectId: string) => {
      try {
        const refreshed = await projectSource.refresh(projectId);
        setProjects((previous) =>
          refreshed
            ? previous.map((project) => (project.id === projectId ? refreshed : project))
            : previous.filter((project) => project.id !== projectId)
        );
      } catch (err: any) {
        onError(`Ordner konnte nicht neu eingelesen werden: ${err?.message || err}`);
      }
    },
    [onError]
  );

  const readProjectFile = useCallback((file: ProjectFileNode) => projectSource.readFile(file), []);

  const toggleCollapsed = useCallback(() => setIsCollapsed((collapsed) => !collapsed), []);

  return {
    projects,
    isBusy,
    isCollapsed,
    enabledFormats,
    toggleFormat,
    isPersistent: enabled && projectSource.isPersistent,
    toggleCollapsed,
    addProject,
    removeProject,
    refreshProject,
    readProjectFile,
  };
}
