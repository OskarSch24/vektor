import React from 'react';
import { AlertTriangle, Binary, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatBytes, type KeyValue } from '../services/redis/keyspace';
import { asDisplayText, isBinary, type WireValue } from '../services/redis/wire';

interface ValueViewerProps {
  value: KeyValue;
  onPage: (request: { offset?: number; cursor?: string }) => void;
  busy: boolean;
}

/**
 * Renders one value according to its Redis type.
 *
 * A single "show the value" box would be the easy version and the wrong one: a
 * sorted set is a member with a score, a stream is entries with ids and fields,
 * and flattening either into a list of strings throws away the structure the
 * user opened it to see.
 */
export const ValueViewer: React.FC<ValueViewerProps> = ({ value, onPage, busy }) => {
  switch (value.kind) {
    case 'string':
      return (
        <div className="space-y-2">
          <Meta>
            {formatBytes(value.bytes)}
            {value.truncated && ' · gekürzt auf die ersten 64 kB'}
          </Meta>
          <Cell value={value.value} block />
          {value.truncated && (
            <p className="text-[12px] text-apple-amber flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              Der vollständige Wert ist {formatBytes(value.bytes)} groß. Angezeigt wird der Anfang;
              den Rest holt ein <code className="font-mono">GETRANGE</code> in der Konsole.
            </p>
          )}
        </div>
      );

    case 'list':
      return (
        <Paged
          total={value.total}
          offset={value.offset}
          count={value.items.length}
          onPage={(offset) => onPage({ offset })}
          busy={busy}
          unit="Einträge"
        >
          <Table
            head={['#', 'Wert']}
            rows={value.items.map((item, index) => [
              <Index key="i">{value.offset + index}</Index>,
              <Cell key="v" value={item} />,
            ])}
          />
        </Paged>
      );

    case 'set':
      return (
        <Cursored
          total={value.total}
          cursor={value.cursor}
          count={value.items.length}
          onPage={(cursor) => onPage({ cursor })}
          busy={busy}
          unit="Mitglieder"
        >
          <Table
            head={['Mitglied']}
            rows={value.items.map((item, index) => [<Cell key={index} value={item} />])}
          />
        </Cursored>
      );

    case 'hash':
      return (
        <Cursored
          total={value.total}
          cursor={value.cursor}
          count={value.fields.length}
          onPage={(cursor) => onPage({ cursor })}
          busy={busy}
          unit="Felder"
        >
          <Table
            head={['Feld', 'Wert']}
            rows={value.fields.map(([field, item], index) => [
              <span key="f" className="font-mono text-[12px] text-apple-cyan">{asDisplayText(field)}</span>,
              <Cell key={index} value={item} />,
            ])}
          />
        </Cursored>
      );

    case 'zset':
      return (
        <Paged
          total={value.total}
          offset={value.offset}
          count={value.entries.length}
          onPage={(offset) => onPage({ offset })}
          busy={busy}
          unit="Mitglieder"
        >
          <Table
            head={['#', 'Score', 'Mitglied']}
            rows={value.entries.map((entry, index) => [
              <Index key="i">{value.offset + index}</Index>,
              <span key="s" className="font-mono text-[12px] text-apple-amber tabular-nums">{entry.score}</span>,
              <Cell key="m" value={entry.member} />,
            ])}
          />
        </Paged>
      );

    case 'stream':
      return (
        <div className="space-y-2">
          <Meta>{value.total} Einträge · neueste zuerst</Meta>
          <div className="space-y-2">
            {value.entries.map((entry) => (
              <div key={entry.id} className="glass-card rounded-lg p-3">
                <div className="font-mono text-[11.5px] text-apple-purple mb-2">{entry.id}</div>
                <Table
                  head={['Feld', 'Wert']}
                  rows={entry.fields.map(([field, item], index) => [
                    <span key="f" className="font-mono text-[12px] text-apple-cyan">{field}</span>,
                    <Cell key={index} value={item} />,
                  ])}
                />
              </div>
            ))}
          </div>
        </div>
      );

    case 'json':
      return (
        <div className="space-y-2">
          <Meta>JSON-Dokument{value.valid ? '' : ' · nicht als JSON lesbar'}</Meta>
          <pre className="glass-card rounded-lg p-3 text-[12px] font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto">
            {value.valid ? JSON.stringify(JSON.parse(value.text), null, 2) : value.text}
          </pre>
        </div>
      );

    case 'vectorset':
      return (
        <div className="space-y-3">
          <Meta>
            {value.card} Vektoren · {value.dimensions} Dimensionen
          </Meta>
          <Table
            head={['Eigenschaft', 'Wert']}
            rows={value.info.map(([field, item]) => [
              <span key="f" className="font-mono text-[12px] text-apple-cyan">{field}</span>,
              <span key="v" className="font-mono text-[12px]">{item}</span>,
            ])}
          />
          {value.sample.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-apple-text-tertiary mb-1.5">
                Stichprobe
              </div>
              <Table head={['Element']} rows={value.sample.map((item) => [
                <span key={item} className="font-mono text-[12px]">{item}</span>,
              ])} />
            </div>
          )}
          <p className="text-[12px] text-apple-text-tertiary">
            Ähnliche Elemente findet <code className="font-mono">VSIM</code> in der Konsole.
          </p>
        </div>
      );

    default:
      return (
        <div className="glass-card rounded-lg p-4 text-[13px] text-apple-text-secondary">
          {value.note}
        </div>
      );
  }
};

// MARK: - Building blocks

const Meta: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[11.5px] text-apple-text-tertiary">{children}</div>
);

const Index: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="font-mono text-[11.5px] text-apple-text-muted tabular-nums">{children}</span>
);

/**
 * One value cell. A binary value is never printed as text: its base64 would
 * look like a string the key does not contain.
 */
const Cell: React.FC<{ value: WireValue; block?: boolean }> = ({ value, block }) => {
  if (value.t === 'nil') {
    return <span className="text-[12px] text-apple-text-muted italic">nicht vorhanden</span>;
  }
  if (isBinary(value)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-apple-purple">
        <Binary className="w-3.5 h-3.5" />
        binär · {asDisplayText(value).length} Zeichen base64
      </span>
    );
  }
  const text = asDisplayText(value);
  return block ? (
    <pre className="glass-card rounded-lg p-3 text-[12px] font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto">
      {text}
    </pre>
  ) : (
    <span className="font-mono text-[12px] break-all">{text}</span>
  );
};

const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div className="overflow-x-auto rounded-lg border border-apple-border">
    <table className="w-full text-left border-collapse">
      <thead>
        <tr className="bg-white/[0.03]">
          {head.map((label) => (
            <th
              key={label}
              className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-apple-text-tertiary font-medium border-b border-apple-border"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-b border-apple-border-subtle last:border-0 hover:bg-white/[0.02]">
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className="px-3 py-1.5 align-top data-grid-cell">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** Offset paging — for types Redis can address by position. */
const Paged: React.FC<{
  total: number;
  offset: number;
  count: number;
  unit: string;
  busy: boolean;
  onPage: (offset: number) => void;
  children: React.ReactNode;
}> = ({ total, offset, count, unit, busy, onPage, children }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2">
      <Meta>
        {total} {unit}
        {total > count && ` · ${offset + 1}–${offset + count}`}
      </Meta>
      <div className="flex-1" />
      <PageButton disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - 200))}>
        <ChevronLeft className="w-3.5 h-3.5" />
      </PageButton>
      <PageButton disabled={busy || offset + count >= total} onClick={() => onPage(offset + 200)}>
        <ChevronRight className="w-3.5 h-3.5" />
      </PageButton>
    </div>
    {children}
  </div>
);

/**
 * Cursor paging — for hashes and sets, which have no stable positions. There is
 * no "back": a SCAN cursor only moves forward, and pretending otherwise would
 * mean re-scanning from zero on every click.
 */
const Cursored: React.FC<{
  total: number;
  cursor: string;
  count: number;
  unit: string;
  busy: boolean;
  onPage: (cursor: string) => void;
  children: React.ReactNode;
}> = ({ total, cursor, count, unit, busy, onPage, children }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2">
      <Meta>
        {total} {unit} · {count} geladen
      </Meta>
      <div className="flex-1" />
      {cursor !== '0' && (
        <PageButton disabled={busy} onClick={() => onPage(cursor)}>
          Weitere laden
        </PageButton>
      )}
    </div>
    {children}
  </div>
);

const PageButton: React.FC<{
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ disabled, onClick, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="px-2 py-1 rounded-md text-[12px] text-apple-text-secondary border border-apple-border hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
  >
    {children}
  </button>
);
