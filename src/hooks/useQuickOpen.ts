import { useCallback, useEffect, useState } from 'react';

export interface QuickOpenController {
  quickOpenVisible: boolean;
  openQuickOpen: () => void;
  closeQuickOpen: () => void;
}

/**
 * Owns the global Quick Open shortcut without coupling it to App or the
 * workbench controller. Shift is deliberately excluded so Cmd+Shift+P remains
 * available for a future command palette.
 */
export function useQuickOpen(enabled = true): QuickOpenController {
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const openQuickOpen = useCallback(() => setQuickOpenVisible(true), []);
  const closeQuickOpen = useCallback(() => setQuickOpenVisible(false), []);

  useEffect(() => {
    if (!enabled) return;

    const handleShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLocaleLowerCase() === 'p'
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setQuickOpenVisible(true);
      }
    };

    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [enabled]);

  return { quickOpenVisible, openQuickOpen, closeQuickOpen };
}
