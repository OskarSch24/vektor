import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { DataWorkspaceKind, WorkspaceKind } from './model';

const loadGraphStudio = () => import('../GraphStudio');
const loadTableStudio = () => import('../sqlite/App');
const loadVaultStudio = () => import('../vault/App');

const workspaceLoaders: Record<DataWorkspaceKind, () => Promise<unknown>> = {
  graph: loadGraphStudio,
  table: loadTableStudio,
  vault: loadVaultStudio,
};

const preloadOrder: DataWorkspaceKind[] = ['graph', 'table', 'vault'];

export const GraphStudio = lazy(async () => ({
  default: (await loadGraphStudio()).GraphStudio,
}));

export const TableStudio = lazy(async () => ({
  default: (await loadTableStudio()).TableStudio,
}));

export const VaultStudio = lazy(async () => ({
  default: (await loadVaultStudio()).VaultStudio,
}));

/**
 * Keeps one resident instance of each data engine while moving its download
 * and initialisation off the shell's first-paint path.
 */
export function useResidentWorkspaces(activeKind: WorkspaceKind) {
  const [modulesReady, setModulesReady] = useState<Set<DataWorkspaceKind>>(() => new Set());
  const [adaptersReady, setAdaptersReady] = useState<Set<DataWorkspaceKind>>(() => new Set());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (kind: DataWorkspaceKind) => {
    await workspaceLoaders[kind]();
    if (!mounted.current) return;
    setModulesReady((current) => {
      if (current.has(kind)) return current;
      const next = new Set(current);
      next.add(kind);
      return next;
    });
  }, []);

  const setAdapterReady = useCallback((kind: DataWorkspaceKind, value: boolean) => {
    setAdaptersReady((current) => {
      if (current.has(kind) === value) return current;
      const next = new Set(current);
      if (value) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);
  const onGraphReadyChange = useCallback(
    (value: boolean) => setAdapterReady('graph', value),
    [setAdapterReady]
  );
  const onTableReadyChange = useCallback(
    (value: boolean) => setAdapterReady('table', value),
    [setAdapterReady]
  );
  const onVaultReadyChange = useCallback(
    (value: boolean) => setAdapterReady('vault', value),
    [setAdapterReady]
  );

  // A workspace selected before idle warming reaches it starts loading now.
  useEffect(() => {
    if (activeKind !== 'home') void load(activeKind).catch(() => undefined);
  }, [activeKind, load]);

  // Warm the three resident engines sequentially once the shell has painted.
  useEffect(() => {
    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let paintFallback: ReturnType<typeof globalThis.setTimeout> | null = null;
    let paintObserver: PerformanceObserver | null = null;
    let preloadStarted = false;

    const schedule = (index: number) => {
      if (cancelled || index >= preloadOrder.length) return;
      const run = () => {
        idleHandle = null;
        timeoutHandle = null;
        void load(preloadOrder[index])
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) schedule(index + 1);
          });
      };

      if ('requestIdleCallback' in window) {
        idleHandle = window.requestIdleCallback(run, { timeout: 500 });
      } else {
        timeoutHandle = globalThis.setTimeout(run, 0);
      }
    };

    const startPreload = () => {
      if (cancelled || preloadStarted) return;
      preloadStarted = true;
      paintObserver?.disconnect();
      paintObserver = null;
      if (paintFallback !== null) globalThis.clearTimeout(paintFallback);
      paintFallback = null;
      schedule(0);
    };

    const startAfterTwoFrames = () => {
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = null;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = null;
          startPreload();
        });
      });
    };

    // requestIdleCallback may run before any content has reached the screen.
    // Prefer the actual paint signal; older WKWebViews get a bounded fallback.
    if (performance.getEntriesByName('first-contentful-paint').length > 0) {
      startPreload();
    } else if (
      'PerformanceObserver' in window
      && PerformanceObserver.supportedEntryTypes.includes('paint')
    ) {
      paintObserver = new PerformanceObserver((entries) => {
        if (entries.getEntries().some((entry) => entry.name === 'first-contentful-paint')) {
          startPreload();
        }
      });
      paintObserver.observe({ type: 'paint', buffered: true });
      paintFallback = globalThis.setTimeout(startPreload, 500);
    } else {
      startAfterTwoFrames();
    }

    return () => {
      cancelled = true;
      paintObserver?.disconnect();
      if (paintFallback !== null) globalThis.clearTimeout(paintFallback);
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      if (idleHandle !== null && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle !== null) globalThis.clearTimeout(timeoutHandle);
    };
  }, [load]);

  return {
    allAdaptersReady: preloadOrder.every((kind) => adaptersReady.has(kind)),
    onGraphReadyChange,
    onTableReadyChange,
    onVaultReadyChange,
    mountGraph: activeKind === 'graph' || modulesReady.has('graph'),
    mountTable: activeKind === 'table' || modulesReady.has('table'),
    mountVault: activeKind === 'vault' || modulesReady.has('vault'),
  };
}
