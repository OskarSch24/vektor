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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
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
        className={`apple-modal flex w-full ${className} flex-col overflow-hidden rounded-[6px] border border-white/[0.12] bg-[#1b1b1b] shadow-[0_20px_64px_rgba(0,0,0,0.58)] focus:outline-none`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] bg-[#1d1d1d] px-4 py-3">
          {header}
          <button
            onClick={onClose}
            aria-label="Schließen"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-[3px] text-apple-text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

        {footer && (
          <div className="flex shrink-0 items-center border-t border-white/[0.08] bg-[#171717] px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
