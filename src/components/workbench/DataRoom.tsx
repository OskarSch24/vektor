import type { FC } from 'react';
import { Database, FolderOpen, FolderPlus } from 'lucide-react';
import { BrandIcon } from './BrandIcon';

interface DataRoomProps {
  projectCount: number;
  sourceCount: number;
  nativeProjects: boolean;
  onOpenFile: () => void;
  onAddProject: () => void;
}

export const DataRoom: FC<DataRoomProps> = ({
  projectCount,
  sourceCount,
  nativeProjects,
  onOpenFile,
  onAddProject,
}) => (
  <div className="data-room h-full overflow-y-auto">
    <div className="cursor-welcome relative z-[1] mx-auto flex min-h-full max-w-[760px] items-center px-8 py-12">
      <div className="w-full">
        <div className="cursor-welcome-hero flex items-start gap-4">
          <BrandIcon className="cursor-welcome-mark h-10 w-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-medium leading-7 tracking-[-0.03em] text-[#ededed]">Neuer Tab</h1>
            <p className="mt-1.5 max-w-[560px] text-[12px] leading-5 text-apple-text-tertiary">
              Öffne eine Quelle aus dem Explorer. Vektor erkennt das Format und passt diesen Arbeitsbereich automatisch an.
            </p>
          </div>
        </div>

        <div className="cursor-welcome-grid mt-8 grid grid-cols-[minmax(220px,0.8fr)_minmax(280px,1.2fr)] gap-10 border-t border-white/[0.065] pt-6">
          <section className="cursor-start-panel">
            <div className="cursor-section-heading-row mb-2 flex items-center justify-between">
              <h2 className="cursor-section-heading text-[9.5px] font-semibold uppercase tracking-[0.12em] text-apple-text-tertiary">Öffnen</h2>
              <span className="font-mono text-[8.5px] text-apple-text-muted">LOKAL</span>
            </div>
            <div className="space-y-0.5">
              <button onClick={onOpenFile} disabled={!nativeProjects} className="cursor-start-action">
                <FolderOpen className="h-3.5 w-3.5" />
                <span>Datei öffnen…</span>
                <span className="cursor-action-hint ml-auto">⌘O</span>
              </button>
              <button onClick={onAddProject} disabled={!nativeProjects} className="cursor-start-action">
                <FolderPlus className="h-3.5 w-3.5" />
                <span>Projektordner hinzufügen…</span>
              </button>
            </div>
          </section>

          <section className="cursor-empty-help">
            <div className="cursor-section-heading-row mb-2 flex items-center justify-between">
              <h2 className="cursor-section-heading text-[9.5px] font-semibold uppercase tracking-[0.12em] text-apple-text-tertiary">Arbeitsbereich</h2>
              <span className="font-mono text-[8.5px] text-apple-text-muted">{sourceCount} QUELLEN</span>
            </div>
            <div className="border-l border-white/[0.075] pl-3 text-[11px] leading-[18px] text-apple-text-tertiary">
              <p>Wähle links eine Datei. Sie ersetzt diesen leeren Tab.</p>
              <p className="mt-2">Mit Rechtsklick → <span className="text-apple-text-secondary">In neuem Tab öffnen</span> bleibt der aktuelle Tab erhalten.</p>
            </div>
          </section>
        </div>

        <div className="cursor-welcome-telemetry mt-7 flex items-center border-y border-white/[0.055] py-2.5 text-[10px] text-apple-text-tertiary">
          <span className="cursor-telemetry-value">{String(projectCount).padStart(2, '0')}</span>
          <span>Projekte</span>
          <span className="cursor-telemetry-divider" />
          <span className="cursor-telemetry-value">{String(sourceCount).padStart(2, '0')}</span>
          <span>Quellen</span>
          <span className="ml-auto hidden items-center gap-4 font-mono text-[8.5px] uppercase tracking-[0.04em] text-apple-text-muted sm:flex">
            <span>SQLite · CSV · Excel</span>
            <span>Graph · Phase X</span>
            <span>RDB · AOF</span>
          </span>
        </div>

        <div className="mt-4 flex items-center gap-2 text-[10px] text-apple-text-muted">
          <Database className="h-3.5 w-3.5 text-apple-cyan" strokeWidth={1.55} />
          <span>Ein Hauptbereich, automatisch passend zur aktiven Quelle.</span>
        </div>
      </div>
    </div>
  </div>
);
