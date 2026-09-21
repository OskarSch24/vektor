import React, { useMemo, useState } from 'react';
import type { SqlValue } from 'sql.js';
import { Binary, Braces, Check, Copy, FileText } from 'lucide-react';
import { blobToBase64, blobToHex, formatBytes, isBlob, toDisplayString } from '../lib/sql';
import { Modal } from './Modal';

interface CellDetailModalProps {
  cell: { column: string; value: SqlValue; rowIndex: number } | null;
  columnType?: string;
  onClose: () => void;
}

type ViewMode = 'formatted' | 'raw';

/** Pretty-printed JSON, or `null` when the value is not JSON. */
function formatJson(value: SqlValue): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null
      ? JSON.stringify(parsed, null, 2)
      : null;
  } catch {
    return null;
  }
}

export const CellDetailModal: React.FC<CellDetailModalProps> = ({
  cell,
  columnType,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('formatted');

  const value = cell?.value ?? null;
  const json = useMemo(() => formatJson(value), [value]);
  const blob = isBlob(value) ? value : null;

  // `formatted` shows a JSON tree or a hex dump; `raw` always shows the bytes as
  // they are stored, which is what you want when copying a value out.
  const rawText = blob ? blobToBase64(blob) : toDisplayString(value);
  const formattedText = json ?? (blob ? blobToHex(blob) : rawText);
  const hasTwoViews = Boolean(json || blob);
  const shownText = hasTwoViews && viewMode === 'formatted' ? formattedText : rawText;

  const handleCopy = () => {
    void navigator.clipboard.writeText(shownText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const icon = blob ? <Binary className="w-4 h-4" /> : json ? <Braces className="w-4 h-4" /> : <FileText className="w-4 h-4" />;

  return (
    <Modal
      isOpen={cell !== null}
      onClose={onClose}
      labelledBy="cell-detail-title"
      className="max-w-2xl max-h-[85vh]"
      header={
        <div className="flex items-center justify-between gap-3 w-full">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-apple-blue/15 border border-apple-blue/30 flex items-center justify-center text-apple-blue shrink-0">
              {icon}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 id="cell-detail-title" className="text-sm font-semibold text-white truncate">
                  {cell?.column}
                </h3>
                {columnType && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-apple-text-secondary border border-white/[0.06] shrink-0">
                    {columnType}
                  </span>
                )}
              </div>
              {cell && (
                <p className="text-[11px] text-apple-text-tertiary">Zeile #{cell.rowIndex + 1}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasTwoViews && (
              <div className="flex items-center bg-black/30 p-0.5 rounded-lg border border-white/[0.08]">
                {(['formatted', 'raw'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      viewMode === mode
                        ? 'bg-apple-blue text-white shadow-sm'
                        : 'text-apple-text-secondary hover:text-white'
                    }`}
                  >
                    {mode === 'raw' ? 'Raw' : blob ? 'Hex' : 'JSON'}
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={handleCopy}
              className="flex items-center gap-1 text-xs bg-white/[0.06] hover:bg-white/[0.12] text-white px-3 py-1.5 rounded-lg border border-white/[0.08] transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-apple-green" />
                  <span>Kopiert</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-apple-text-secondary" />
                  <span>Kopieren</span>
                </>
              )}
            </button>
          </div>
        </div>
      }
      footer={
        <div className="flex items-center justify-between w-full text-[11px] text-apple-text-tertiary">
          <span>
            {blob
              ? `${formatBytes(blob.byteLength)} binär${
                  viewMode === 'raw' ? ' (Base64)' : ''
                }`
              : `Länge: ${rawText.length.toLocaleString('de-DE')} Zeichen`}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-white/[0.08] text-white text-[10px] font-mono">
              ESC
            </kbd>
            <span>zum Schließen</span>
          </span>
        </div>
      }
    >
      {value === null ? (
        <div className="text-center py-10">
          <span className="text-sm font-mono text-apple-amber/80 bg-apple-amber/10 px-3 py-1.5 rounded-lg border border-apple-amber/20">
            NULL
          </span>
        </div>
      ) : (
        <pre className="text-xs font-mono bg-[#0D0F15] p-4 rounded-xl border border-white/[0.06] text-apple-text-primary whitespace-pre-wrap break-all leading-relaxed select-text selection:bg-apple-blue/40">
          {shownText}
        </pre>
      )}
    </Modal>
  );
};
