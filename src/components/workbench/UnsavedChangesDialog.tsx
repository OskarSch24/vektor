import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface UnsavedChangesDialogProps {
  filename: string | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function UnsavedChangesDialog({
  filename,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!filename) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [filename, onCancel]);

  if (!filename) return null;

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-black/55 px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        aria-describedby="unsaved-description"
        className="w-full max-w-[430px] overflow-hidden rounded-[6px] border border-white/[0.12] bg-[#1b1b1b] shadow-2xl"
      >
        <div className="flex gap-3 px-4 py-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[5px] bg-[#33291b] text-[#e0aa5e]">
            <AlertTriangle className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 id="unsaved-title" className="text-[13px] font-semibold text-white">
              Änderungen noch nicht gesichert
            </h2>
            <p id="unsaved-description" className="mt-1.5 text-[11.5px] leading-5 text-apple-text-secondary">
              „{filename}“ enthält Änderungen in der Arbeitskopie. Sichere sie als Datei oder verwirf sie bewusst.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] bg-[#171717] px-3 py-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-7 rounded-[4px] px-3 text-[11px] text-apple-text-secondary hover:bg-white/[0.06] hover:text-white"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="h-7 rounded-[4px] px-3 text-[11px] text-[#e58a94] hover:bg-[#382126] hover:text-[#f3a3ad]"
          >
            Änderungen verwerfen
          </button>
          <button
            type="button"
            onClick={onSave}
            className="h-7 rounded-[4px] bg-[#315f88] px-3 text-[11px] font-medium text-white hover:bg-[#3a6d99]"
          >
            Sichern…
          </button>
        </div>
      </section>
    </div>
  );
}
