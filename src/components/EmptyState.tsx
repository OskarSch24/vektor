import React, { useCallback, useState } from 'react';
import { FilePlus2, FolderOpen, Network, Upload, Users } from 'lucide-react';

interface EmptyStateProps {
  onNewGraph: () => void;
  onOpenGraph: () => void;
  onOpenCoordination: () => void;
  onDropFile: (file: File) => void;
  isLoading: boolean;
}

/**
 * What you see before a graph is open. Doubles as a drop target for graph and
 * Phase-X run files.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  onNewGraph,
  onOpenGraph,
  onOpenCoordination,
  onDropFile,
  isLoading,
}) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) onDropFile(file);
    },
    [onDropFile]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`flex-1 flex flex-col items-center justify-center p-8 transition-colors ${
        isDragging ? 'bg-apple-blue/[0.06]' : ''
      }`}
    >
      <div
        className={`w-full max-w-lg rounded-3xl border-2 border-dashed transition-all duration-200 p-10 text-center ${
          isDragging
            ? 'border-apple-blue bg-apple-blue/[0.08] scale-[1.01]'
            : 'border-white/[0.1] bg-white/[0.02]'
        }`}
      >
        <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-apple-purple/12 border border-apple-purple/30 flex items-center justify-center text-apple-purple">
          {isDragging ? <Upload className="w-7 h-7" /> : <Network className="w-7 h-7" />}
        </div>

        <h1 className="text-lg font-semibold text-apple-text-primary tracking-tight">
          {isDragging ? 'Loslassen zum Öffnen' : 'Graph-Arbeitsraum'}
        </h1>
        <p className="mt-2 text-xs text-apple-text-secondary leading-relaxed max-w-sm mx-auto">
          Öffne Wissensgraphen oder fertige Phase-X-Läufe. Zieh eine{' '}
          <span className="font-mono text-apple-text-primary">.graph</span>- oder{' '}
          <span className="font-mono text-apple-text-primary">.amqrun.json</span>-Datei hierher.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onNewGraph}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-apple-blue hover:bg-apple-blue-hover disabled:opacity-50 transition-colors"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            Neuer Graph
          </button>

          <button
            onClick={onOpenGraph}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] disabled:opacity-50 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-apple-blue" />
            Öffnen
          </button>

          <button
            onClick={onOpenCoordination}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] disabled:opacity-50 transition-colors"
          >
            <Users className="w-3.5 h-3.5 text-apple-indigo" />
            Koordination
          </button>

        </div>
      </div>

      <p className="mt-6 text-[11px] text-apple-text-muted">
        ⌘N neuer Graph · ⌘O öffnen · ⌘, Einstellungen
      </p>
    </div>
  );
};
