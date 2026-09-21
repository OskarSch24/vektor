import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type NoticeTone = 'error' | 'warning' | 'success';

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface Notice {
  tone: NoticeTone;
  message: string;
  /** Buttons rendered next to the text — the fix, one click away. */
  actions?: NoticeAction[];
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
  success: {
    wrapper: 'bg-apple-green/10 border-apple-green/30 text-apple-green',
    icon: <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />,
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
      {notice.actions?.map((action) => (
        <button
          key={action.label}
          onClick={action.onClick}
          className="shrink-0 px-2 py-1 rounded-md text-[11px] font-medium border border-current/40 hover:bg-white/10 transition-colors"
        >
          {action.label}
        </button>
      ))}
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
