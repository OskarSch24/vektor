import { useBrowserExtensionStatus } from '../../hooks/useBrowserExtensionStatus';
import { browserExtensionCopy } from '../../workbench/browserExtensionCopy';
import { sourceLabel, type ActiveSource } from '../../workbench/model';

interface WorkbenchStatusbarProps {
  source: ActiveSource;
  projectCount: number;
  sourceCount: number;
  nativeHost: boolean;
}

export function WorkbenchStatusbar({
  source,
  projectCount,
  sourceCount,
  nativeHost,
}: WorkbenchStatusbarProps) {
  const browserExtension = useBrowserExtensionStatus();
  const browserExtensionView = browserExtensionCopy(browserExtension);

  return (
    <footer className="cursor-statusbar h-[22px] shrink-0 flex items-center border-t border-white/[0.075] bg-[#141414] px-2 text-[10px] text-apple-text-tertiary select-none">
      <div
        className="cursor-status-segment flex items-center gap-1.5 min-w-0"
        title={source.path ?? source.name}
      >
        <span className={`source-dot source-dot-${source.kind}`} />
        <span className="font-medium text-apple-text-secondary">{sourceLabel(source)}</span>
        <span className="truncate max-w-[300px] text-apple-text-tertiary">{source.name}</span>
      </div>
      <span className="cursor-status-spacer ml-auto" />
      <span className="cursor-status-segment hidden sm:flex tabular-nums">
        {projectCount} Projekte
      </span>
      <span className="cursor-status-segment hidden sm:flex tabular-nums">
        {sourceCount} Quellen
      </span>
      <button
        onClick={() => void browserExtension.refresh()}
        className={`cursor-status-segment browser-status browser-bridge-${browserExtension.state} flex gap-1.5`}
        title={`${browserExtensionView.detail} Klicken zum Aktualisieren.`}
      >
        <span className="browser-bridge-dot h-1.5 w-1.5 rounded-full" />
        <span className="hidden lg:inline">{browserExtensionView.label}</span>
        <span className="lg:hidden">Extension</span>
      </button>
      <span className="cursor-status-segment font-mono">
        {nativeHost ? 'API · 8793' : 'Browser-Vorschau'}
      </span>
    </footer>
  );
}
