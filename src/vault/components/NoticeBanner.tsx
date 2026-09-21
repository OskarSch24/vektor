import React from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';

export type NoticeTone = 'error' | 'warning';

export interface Notice {
  tone: NoticeTone;
  message: string;
}

interface NoticeBannerProps {
  notice: Notice | null;
  onDismiss: () => void;
}

const TONE_STYLE: Record<NoticeTone, { wrapper: string; icon: React.ReactNode }> = {
  error: {
    wrapper: 'bg-apple-red/10 border-apple-red/30 text-apple-red',
    icon: <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />,
  },
  warning: {
    wrapper: 'bg-apple-amber/10 border-apple-amber/30 text-apple-amber',
    icon: <Info className="w-4 h-4 shrink-0 mt-px" />,
  },
};

/**
 * In-app replacement for `alert()`: non-blocking, dismissable and selectable,
 * so the message can actually be copied into a bug report.
 */
export const NoticeBanner: React.FC<NoticeBannerProps> = ({ notice, onDismiss }) => {
  if (!notice) return null;
  const style = TONE_STYLE[notice.tone];

  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`shrink-0 flex items-start gap-2.5 px-4 py-2.5 border-b ${style.wrapper}`}
    >
      {style.icon}
      <p className="flex-1 text-xs leading-relaxed select-text whitespace-pre-wrap break-words">
        {notice.message}
      </p>
      <button
        onClick={onDismiss}
        aria-label="Meldung schließen"
        className="p-1 -m-1 rounded-md hover:bg-white/10 transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
