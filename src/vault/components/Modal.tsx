import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  header: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** id of the element naming the dialog, for screen readers. */
  labelledBy?: string;
  className?: string;
}

/**
 * Shared dialog shell: closes on Escape and on a click outside, restores focus
 * to whatever was focused before, and locks the page behind it.
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  header,
  footer,
  children,
  labelledBy,
  className = 'max-w-md',
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement;
    panelRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md"
      // Only a click that starts and ends on the backdrop itself closes the
      // dialog — dragging a text selection out of the panel must not.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`apple-modal w-full ${className} max-h-[calc(100dvh-2rem)] bg-[#151720]/95 border border-white/[0.12] rounded-2xl shadow-apple-window overflow-hidden flex flex-col focus:outline-none`}
      >
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-white/[0.08] bg-white/[0.02] shrink-0">
          {header}
          <button
            onClick={onClose}
            aria-label="Schließen"
            className="p-1.5 rounded-lg text-apple-text-secondary hover:text-white hover:bg-white/[0.08] transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto min-h-0">{children}</div>

        {footer && (
          <div className="px-5 py-3 border-t border-white/[0.08] bg-black/20 flex items-center shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
