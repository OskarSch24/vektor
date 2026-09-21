import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CornerDownLeft, Terminal } from 'lucide-react';
import { Modal } from './Modal';
import type { Connection } from '../services/redis/connection';
import { isBinary, type WireValue } from '../services/redis/wire';

interface ConsoleProps {
  connection: Connection;
  writesAllowed: boolean;
}

interface Line {
  id: number;
  command: string;
  value?: WireValue;
  error?: string;
  durationMs: number;
}

/**
 * Splits a typed line into arguments, honouring quotes.
 *
 * `SET greeting "hallo welt"` has to arrive as three arguments, not four —
 * splitting on whitespace alone would write the key `greeting` with the value
 * `"hallo` and leave the user wondering where the rest went.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (current || started) tokens.push(current);
  return tokens;
}

export const Console: React.FC<ConsoleProps> = ({ connection, writesAllowed }) => {
  const [input, setInput] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pending, setPending] = useState<{ args: string[]; reason: string } | null>(null);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  const execute = useCallback(
    async (args: string[], confirmed: boolean) => {
      const started = performance.now();
      const command = args.join(' ');
      try {
        const value = await connection.run(args, { confirmed });
        setLines((current) => [
          ...current,
          { id: nextId.current++, command, value, durationMs: performance.now() - started },
        ]);
      } catch (err: any) {
        setLines((current) => [
          ...current,
          {
            id: nextId.current++,
            command,
            error: err?.message || String(err),
            durationMs: performance.now() - started,
          },
        ]);
      }
    },
    [connection]
  );

  const submit = () => {
    const args = tokenize(input);
    if (args.length === 0) return;

    setHistory((current) => [input, ...current].slice(0, 100));
    setHistoryIndex(-1);
    setInput('');

    const verdict = connection.inspect(args);
    if (verdict.allowed && verdict.needsConfirmation) {
      // The confirmation is a dialog, not a second Enter: the commands that
      // reach this branch are the ones nobody wants to run by muscle memory.
      setPending({ args, reason: verdict.reason ?? 'Dieser Befehl muss bestätigt werden.' });
      return;
    }
    void execute(args, false);
  };

  const preview = tokenize(input);
  const verdict = preview.length > 0 ? connection.inspect(preview) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scroller} className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-[12.5px] min-h-0">
        {lines.length === 0 && (
          <div className="text-apple-text-tertiary space-y-1">
            <p>Befehle gehen direkt an {connection.host}:{connection.port}, Datenbank {connection.database}.</p>
            <p>
              {connection.catalogue.loaded
                ? `${connection.catalogue.size} Befehle bekannt — der Server hat seinen Katalog selbst gemeldet.`
                : 'Der Server hat COMMAND nicht beantwortet; es gilt eine eingebaute, vorsichtige Einstufung.'}
            </p>
          </div>
        )}

        {lines.map((line) => (
          <div key={line.id}>
            <div className="flex items-start gap-2">
              <span className="text-apple-blue shrink-0">›</span>
              <span className="break-all">{line.command}</span>
              <span className="ml-auto shrink-0 text-[11px] text-apple-text-muted tabular-nums">
                {line.durationMs.toFixed(1)} ms
              </span>
            </div>
            {line.error ? (
              <div className="pl-4 text-apple-red break-all">{line.error}</div>
            ) : (
              <Reply value={line.value!} />
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-apple-border p-2.5 space-y-1.5 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-apple-text-tertiary shrink-0" />
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
                return;
              }
              // Arrow keys walk the history, as in redis-cli.
              if (event.key === 'ArrowUp' && history.length > 0) {
                event.preventDefault();
                const next = Math.min(historyIndex + 1, history.length - 1);
                setHistoryIndex(next);
                setInput(history[next]);
              }
              if (event.key === 'ArrowDown' && historyIndex >= 0) {
                event.preventDefault();
                const next = historyIndex - 1;
                setHistoryIndex(next);
                setInput(next < 0 ? '' : history[next]);
              }
            }}
            placeholder="GET px:test:node:1"
            spellCheck={false}
            autoFocus
            className="flex-1 bg-transparent font-mono text-[13px] focus:outline-none placeholder:text-apple-text-muted"
          />
          <button
            onClick={submit}
            className="p-1.5 rounded-lg text-apple-text-secondary hover:text-white hover:bg-white/[0.06] transition-colors"
            title="Ausführen"
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
          </button>
        </div>

        {verdict && (
          <div className="text-[11px] pl-6">
            {!verdict.allowed ? (
              <span className="text-apple-amber">{verdict.reason}</span>
            ) : (
              <span className="text-apple-text-tertiary">
                {verdict.info.name.toUpperCase()}
                {verdict.info.flags.length > 0 && ` · ${verdict.info.flags.join(' ')}`}
                {verdict.needsConfirmation && ' · fragt vor der Ausführung nach'}
              </span>
            )}
          </div>
        )}
      </div>

      <Modal
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        labelledBy="confirm-title"
        header={
          <h2 id="confirm-title" className="flex items-center gap-2 text-[15px] font-semibold flex-1">
            <AlertTriangle className="w-4 h-4 text-apple-amber" />
            Bestätigen
          </h2>
        }
        footer={
          <div className="flex items-center gap-2 w-full">
            <div className="flex-1" />
            <button
              onClick={() => setPending(null)}
              className="px-3 py-1.5 text-[13px] rounded-lg text-apple-text-secondary hover:text-white transition-colors"
            >
              Abbrechen
            </button>
            <button
              onClick={() => {
                const command = pending;
                setPending(null);
                if (command) void execute(command.args, true);
              }}
              className="px-4 py-1.5 text-[13px] font-medium rounded-lg bg-apple-red hover:bg-apple-red/80 text-white transition-colors"
            >
              Trotzdem ausführen
            </button>
          </div>
        }
      >
        <p className="text-[13px] text-apple-text-secondary mb-3">{pending?.reason}</p>
        <pre className="glass-card rounded-lg p-3 font-mono text-[12.5px] break-all whitespace-pre-wrap">
          {pending?.args.join(' ')}
        </pre>
        {!writesAllowed && (
          <p className="mt-3 text-[12px] text-apple-text-tertiary">
            Schreibzugriff ist ausgeschaltet — lesende Befehle laufen trotzdem.
          </p>
        )}
      </Modal>
    </div>
  );
};

/** Renders a reply the way redis-cli does, one indented line per element. */
const Reply: React.FC<{ value: WireValue; depth?: number }> = ({ value, depth = 0 }) => {
  const indent = { paddingLeft: `${(depth + 1) * 16}px` };

  switch (value.t) {
    case 'error':
      return <div style={indent} className="text-apple-red break-all">(error) {value.v}</div>;
    case 'nil':
      return <div style={indent} className="text-apple-text-muted">(nil)</div>;
    case 'int':
      return <div style={indent} className="text-apple-amber">(integer) {value.v}</div>;
    case 'big':
      return <div style={indent} className="text-apple-amber">(big number) {value.v}</div>;
    case 'double':
      return <div style={indent} className="text-apple-amber">(double) {value.v}</div>;
    case 'bool':
      return <div style={indent} className="text-apple-amber">({value.v ? 'true' : 'false'})</div>;
    case 'simple':
      return <div style={indent} className="text-apple-green break-all">{value.v}</div>;
    case 'bulk':
      return isBinary(value) ? (
        <div style={indent} className="text-apple-purple break-all">
          (binär, base64) {value.v}
        </div>
      ) : (
        <div style={indent} className="break-all">"{value.v}"</div>
      );
    default: {
      const items = value.v as WireValue[];
      if (items.length === 0) {
        return <div style={indent} className="text-apple-text-muted">(leer)</div>;
      }
      return (
        <>
          {items.map((item, index) => (
            <div key={index} className="flex">
              <span style={indent} className="text-apple-text-muted shrink-0 tabular-nums">
                {index + 1})
              </span>
              <div className="flex-1 min-w-0">
                <Reply value={item} depth={0} />
              </div>
            </div>
          ))}
        </>
      );
    }
  }
};
