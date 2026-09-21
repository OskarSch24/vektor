import React from 'react';
import type { SqlValue } from 'sql.js';
import { blobLabel, isBlob } from '../lib/sql';

/** True for strings that look like a JSON object or array. */
export function looksLikeJson(value: SqlValue): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

/**
 * One cell as shown in the grids. Numbers are printed verbatim — no locale
 * grouping and no rounding, because a viewer that quietly turns 52.5200066 into
 * 52.52 is worse than useless.
 */
export const CellValue: React.FC<{ value: SqlValue }> = ({ value }) => {
  if (value === null || value === undefined) {
    return <span className="text-[10px] font-mono text-apple-amber/70 italic">NULL</span>;
  }

  if (isBlob(value)) {
    return (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-apple-pink/15 text-apple-pink border border-apple-pink/20">
        {blobLabel(value)}
      </span>
    );
  }

  if (typeof value === 'number') {
    return <span className="font-mono text-apple-cyan tabular-nums">{String(value)}</span>;
  }

  if (looksLikeJson(value)) {
    return (
      <span className="flex items-center gap-1 min-w-0">
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-apple-purple/15 text-apple-purple border border-apple-purple/20 shrink-0">
          JSON
        </span>
        <span className="truncate text-apple-text-secondary">{value}</span>
      </span>
    );
  }

  return <span className="truncate">{value}</span>;
};
