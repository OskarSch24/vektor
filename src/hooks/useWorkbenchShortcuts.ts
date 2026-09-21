import { useEffect } from 'react';
import { isNativeHost } from '../services/nativeHost';

interface WorkbenchShortcutActions {
  toggleExplorer: () => void;
  addBlankTab: () => void;
  closeActiveTab: () => void;
  openFile: () => void;
}

export function useWorkbenchShortcuts({
  toggleExplorer,
  addBlankTab,
  closeActiveTab,
  openFile,
}: WorkbenchShortcutActions): void {
  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'b') {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleExplorer();
      } else if (key === 't') {
        event.preventDefault();
        event.stopImmediatePropagation();
        addBlankTab();
      } else if (key === 'w') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeActiveTab();
      } else if (key === 'o' && isNativeHost()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openFile();
      }
    };

    window.addEventListener('keydown', handleGlobalShortcut, true);
    return () => window.removeEventListener('keydown', handleGlobalShortcut, true);
  }, [addBlankTab, closeActiveTab, openFile, toggleExplorer]);
}
