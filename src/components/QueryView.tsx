import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Play, Sparkles, Target } from 'lucide-react';
import { GraphSchema, QueryResult } from '../types/graph';
import { QueryError, runQuery } from '../services/query';
import { formatCount, formatPropertyValue } from '../lib/graph';

interface QueryViewProps {
  schema: GraphSchema;
  onHighlight: (result: QueryResult | null) => void;
  onShowGraph: () => void;
}

const EXAMPLES = [
  {
    title: 'Alle Personen',
    query: 'MATCH (p:Person)\nRETURN p.name, p.description\nLIMIT 50',
  },
  {
    title: 'Was eine Seite nennt',
    query: 'MATCH (s:Page)-[:NENNT]->(e)\nRETURN s.title, e.name\nLIMIT 100',
  },
  {
    title: 'Häufigste Themen',
    query: 'MATCH (t:Topic)\nRETURN t.name, count(*) AS anzahl\nORDER BY anzahl DESC\nLIMIT 20',
  },
  {
    title: 'Videoszenen zu einem Stichwort',
    query: 'MATCH (s:Scene)-[:ZEIGT]->(t)\nWHERE t.name CONTAINS "…"\nRETURN s.name, t.name',
  },
  {
    title: 'Verlinkte Domains',
    query: 'MATCH (a)-[:VERLINKT_AUF]->(b:Site)\nRETURN b.domain, count(*) AS links\nORDER BY links DESC',
  },
];

/**
 * The query tab. Deliberately plain: a textarea, a run button, a grid. The
 * value is in the language, not in an editor that pretends to be an IDE.
 */
export const QueryView: React.FC<QueryViewProps> = ({ schema, onHighlight, onShowGraph }) => {
  const [source, setSource] = useState('MATCH (n)\nRETURN n\nLIMIT 100');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const execute = useCallback(() => {
    try {
      const outcome = runQuery(source);
      setResult(outcome);
      setError(null);
      onHighlight(outcome);
    } catch (err) {
      setResult(null);
      onHighlight(null);
      setError(
        err instanceof QueryError
          ? `${err.message} (Position ${err.position})`
          : err instanceof Error
            ? err.message
            : String(err)
      );
    }
  }, [source, onHighlight]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      execute();
    }
  };

  const hints = useMemo(
    () => ({
      labels: schema.labels.slice(0, 12).map((entry) => entry.label),
      types: schema.relationshipTypes.slice(0, 12).map((entry) => entry.type),
    }),
    [schema]
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 border-b border-apple-border-subtle">
        <div className="flex items-center justify-between px-4 py-2 select-none">
          <div className="flex items-center gap-2 text-apple-text-tertiary">
            <BookOpen className="w-3.5 h-3.5" />
            <span className="text-[11px] font-semibold uppercase tracking-wider">Abfrage</span>
          </div>

          <div className="flex items-center gap-2">
            {result && (
              <button
                onClick={onShowGraph}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-apple-text-primary bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] transition-colors"
              >
                <Target className="w-3.5 h-3.5 text-apple-purple" />
                Im Graph zeigen
              </button>
            )}
            <button
              onClick={execute}
              title="Ausführen (⌘↩)"
              className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium text-white bg-apple-blue hover:bg-apple-blue-hover transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              Ausführen
            </button>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          rows={6}
          className="w-full bg-black/30 px-4 py-3 text-xs font-mono text-apple-text-primary resize-y focus:outline-none border-t border-white/[0.05] leading-relaxed"
        />

        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-t border-white/[0.05]">
          <Sparkles className="w-3 h-3 text-apple-text-muted shrink-0" />
          {EXAMPLES.map((example) => (
            <button
              key={example.title}
              onClick={() => setSource(example.query)}
              className="px-2 py-0.5 rounded-md text-[11px] text-apple-text-secondary bg-white/[0.04] hover:bg-white/[0.1] hover:text-white border border-white/[0.06] transition-colors"
            >
              {example.title}
            </button>
          ))}
        </div>

        {(hints.labels.length > 0 || hints.types.length > 0) && (
          <div className="px-4 py-1.5 border-t border-white/[0.05] flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-apple-text-muted select-text">
            {hints.labels.length > 0 && (
              <span>
                Labels: <span className="font-mono">{hints.labels.join(', ')}</span>
              </span>
            )}
            {hints.types.length > 0 && (
              <span>
                Beziehungen: <span className="font-mono">{hints.types.join(', ')}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 flex items-start gap-2.5 px-4 py-2.5 bg-apple-red/10 border-b border-apple-red/30 text-apple-red">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <p className="text-xs leading-relaxed select-text">{error}</p>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {result ? (
          result.rows.length === 0 ? (
            <p className="p-6 text-xs text-apple-text-tertiary">Keine Treffer.</p>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10">
                <tr>
                  {result.columns.map((column) => (
                    <th
                      key={column}
                      className="text-left font-semibold text-apple-text-secondary bg-apple-panel border-b border-apple-border px-3 py-2 whitespace-nowrap select-none"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="hover:bg-white/[0.03] transition-colors">
                    {row.map((value, columnIndex) => (
                      <td
                        key={columnIndex}
                        className="data-grid-cell border-b border-apple-border-subtle px-3 py-1.5 text-apple-text-primary align-top select-text max-w-md truncate"
                        title={formatPropertyValue(value)}
                      >
                        {formatPropertyValue(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="p-6 text-xs text-apple-text-muted">
            Noch keine Abfrage ausgeführt. ⌘↩ führt aus.
          </p>
        )}
      </div>

      {result && (
        <footer className="shrink-0 px-4 py-1.5 border-t border-apple-border-subtle flex items-center gap-3 text-[11px] text-apple-text-tertiary select-none">
          <span className="font-mono tabular-nums">{formatCount(result.rows.length)} Zeilen</span>
          <span className="font-mono tabular-nums">{result.durationMs.toFixed(1)} ms</span>
          <span className="font-mono tabular-nums">
            {formatCount(result.nodeIds.length)} Knoten hervorgehoben
          </span>
        </footer>
      )}
    </div>
  );
};
