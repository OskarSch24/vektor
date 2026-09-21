import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings } from '../types/settings';
import { defaultSettings, loadSettings, saveSettings } from '../services/settings';

/**
 * Loads settings once and persists every change, debounced — typing an API key
 * character by character should not mean a file write per keystroke.
 */
export function useSettings(onError: (message: string) => void) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);
  const saveTimer = useRef<number | null>(null);
  /** Mirrors `settings` so callbacks can read it without being re-created. */
  const latest = useRef(settings);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((loaded) => {
      if (cancelled) return;
      latest.current = loaded;
      setSettings(loaded);
      setIsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(
    (change: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => {
      setSettings((current) => {
        const patch = typeof change === 'function' ? change(current) : change;
        const next = { ...current, ...patch };
        latest.current = next;

        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          void saveSettings(latest.current).catch((err) =>
            onError(`Einstellungen konnten nicht gespeichert werden: ${err?.message || err}`)
          );
        }, 400);

        return next;
      });
    },
    [onError]
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    []
  );

  /** Reads the current value outside of React's render cycle. */
  const read = useCallback(() => latest.current, []);

  return { settings, isLoaded, update, read };
}
