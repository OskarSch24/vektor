import React, { useRef, useState } from 'react';
import { Code2, Database, FileSpreadsheet, LoaderCircle, ShieldCheck, Zap } from 'lucide-react';

interface DropZoneProps {
  onFileLoaded: (file: File) => void;
  onOpenFile: () => void;
  isLoading: boolean;
}

export const DropZone: React.FC<DropZoneProps> = ({
  onFileLoaded,
  onOpenFile,
  isLoading,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  // Drag events fire for every child element; counting enters and leaves keeps
  // the highlight stable instead of flickering as the pointer crosses the layout.
  const dragDepth = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileLoaded(file);
  };

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-busy={isLoading}
      className="relative flex h-full w-full flex-1 select-none items-center justify-center overflow-y-auto bg-[#181818] px-5 py-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage: 'radial-gradient(circle at center, black, transparent 72%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#6697b5]/[0.035] blur-3xl"
      />

      <div className="relative w-full max-w-[760px]">
        <div className="mb-3 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.15em] text-[#6f6f6f]">
          <span className="h-px w-5 bg-[#3a3a3a]" />
          Tabellen · lokaler Arbeitsraum
        </div>

        <header className="mb-6 flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[5px] border border-[#393939] bg-[#222] text-[#b8cdd6]">
            <Database className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[20px] font-medium leading-6 tracking-[-0.025em] text-[#f0f0f0] sm:text-[22px]">
              Tabellen-Arbeitsraum
            </h1>
            <p className="mt-1 max-w-[590px] text-[11.5px] leading-[1.55] text-[#969696] sm:text-[12px]">
              SQLite, CSV, JSONL und Excel lokal untersuchen – keine Daten verlassen deinen Mac.
            </p>
          </div>
        </header>

        <button
          type="button"
          onClick={onOpenFile}
          disabled={isLoading}
          className={`group relative flex min-h-[112px] w-full items-center gap-4 overflow-hidden rounded-[8px] border border-dashed px-4 py-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-[border-color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6688a8] sm:px-5 ${
            isDragging
              ? 'border-[#79a5c8] bg-[#1d2930] shadow-[inset_0_0_0_1px_rgba(121,165,200,0.13),0_0_30px_rgba(83,127,159,0.09)]'
              : 'border-[#3b3b3b] bg-[#1d1d1d] hover:border-[#555555] hover:bg-[#202020]'
          } disabled:cursor-wait disabled:opacity-60`}
        >
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[7px] border transition-colors ${
            isDragging
              ? 'border-[#527692] bg-[#263943] text-[#a9cee4]'
              : 'border-[#393939] bg-[#262626] text-[#a8a8a8] group-hover:border-[#464646] group-hover:text-[#d9d9d9]'
          }`}>
            {isLoading ? <LoaderCircle className="h-[18px] w-[18px] animate-spin" /> : <FileSpreadsheet className="h-[18px] w-[18px]" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium tracking-[-0.005em] text-[#e7e7e7]">
              {isDragging ? 'Loslassen und im Studio öffnen' : 'Datei hier ablegen'}
            </p>
            <p className="mt-1 text-[10.5px] leading-4 text-[#858585] sm:text-[11px]">
              {isDragging ? 'Die Datei wird ausschließlich lokal verarbeitet.' : 'Oder klicken, um eine Datei auf diesem Mac auszuwählen.'}
            </p>
          </div>
          <div className="hidden shrink-0 flex-wrap justify-end gap-1.5 sm:flex">
            {['SQLite', 'CSV', 'JSONL', 'Excel'].map((format) => (
              <span key={format} className="rounded-[4px] border border-[#383838] bg-[#232323] px-1.5 py-1 font-mono text-[8.5px] text-[#828282]">
                {format}
              </span>
            ))}
          </div>
        </button>

        <div className="mt-5 grid overflow-hidden border-y border-[#292929] sm:grid-cols-3 sm:divide-x sm:divide-[#292929]">
          <div className="flex min-h-12 items-center gap-2.5 border-b border-[#292929] px-3 sm:border-b-0 sm:pl-0">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#81a585]" />
            <div>
              <span className="block text-[10.5px] font-medium text-[#c7c7c7]">100% privat</span>
              <span className="block text-[9.5px] text-[#6f6f6f]">Client-side WASM</span>
            </div>
          </div>

          <div className="flex min-h-12 items-center gap-2.5 border-b border-[#292929] px-3 sm:border-b-0">
            <Zap className="h-3.5 w-3.5 shrink-0 text-[#b7a372]" />
            <div>
              <span className="block text-[10.5px] font-medium text-[#c7c7c7]">Direkt bereit</span>
              <span className="block text-[9.5px] text-[#6f6f6f]">Lokale SQL-Engine</span>
            </div>
          </div>

          <div className="flex min-h-12 items-center gap-2.5 px-3 sm:pr-0">
            <Code2 className="h-3.5 w-3.5 shrink-0 text-[#7f9ead]" />
            <div>
              <span className="block text-[10.5px] font-medium text-[#c7c7c7]">SQL-Editor</span>
              <span className="block text-[9.5px] text-[#6f6f6f]">Editor &amp; Schema DDL</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
