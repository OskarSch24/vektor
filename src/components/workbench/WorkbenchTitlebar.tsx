import { PanelLeftOpen, Search } from 'lucide-react';
import type { ActiveSource } from '../../workbench/model';
import { BrandIcon } from './BrandIcon';

interface WorkbenchTitlebarProps {
  source: ActiveSource;
  nativeHost: boolean;
  explorerCollapsed: boolean;
  onOpenHome: () => void;
  onToggleExplorer: () => void;
  onOpenQuick: () => void;
}

export function WorkbenchTitlebar({
  source,
  nativeHost,
  explorerCollapsed,
  onOpenHome,
  onToggleExplorer,
  onOpenQuick,
}: WorkbenchTitlebarProps) {
  return (
    <header
      data-drag-region
      className="database-titlebar h-9 shrink-0 flex items-center border-b border-white/[0.075] px-2 select-none relative z-50"
    >
      <div data-no-drag className="database-brand-slot flex min-w-0 items-center">
        {nativeHost && <span className="native-titlebar-safe-area shrink-0" aria-hidden="true" />}
        <button
          onClick={onOpenHome}
          className="cursor-app-title group flex h-7 min-w-0 items-center gap-2 px-1 text-left text-white/90 transition-colors hover:text-white"
          title="Neuen Datenraum öffnen"
        >
          <BrandIcon className="cursor-brand-mark h-6 w-6 shrink-0 rounded-[5px]" />
          <span className="whitespace-nowrap text-[11.5px] font-medium tracking-[-0.01em]">
            Vektor
          </span>
        </button>
        {explorerCollapsed && (
          <button
            onClick={onToggleExplorer}
            aria-label="Explorer öffnen"
            title="Explorer öffnen (⌘B)"
            className="ml-1 grid h-6 w-6 place-items-center rounded-[3px] text-apple-text-muted transition-colors hover:bg-white/[0.055] hover:text-white"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" strokeWidth={1.65} />
          </button>
        )}
      </div>

      <button
        data-no-drag
        type="button"
        onClick={onOpenQuick}
        className="cursor-command-center absolute left-1/2 flex h-6 w-[min(430px,38vw)] -translate-x-1/2 items-center gap-2 rounded-[5px] border px-2.5 text-[10.5px] text-apple-text-muted transition-colors hover:text-apple-text-secondary"
        title={source.path ?? source.name}
      >
        <Search className="h-3 w-3 shrink-0 text-apple-text-muted" strokeWidth={1.7} />
        <span className={`source-dot source-dot-${source.kind}`} />
        <span className="min-w-0 flex-1 truncate text-left">{source.name}</span>
        <kbd className="shrink-0 rounded-[3px] border border-white/[0.07] bg-black/10 px-1 font-mono text-[8.5px] leading-4 text-apple-text-muted">⌘P</kbd>
      </button>
    </header>
  );
}
