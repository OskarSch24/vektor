import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SqlValue } from 'sql.js';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Download,
  History,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { dbEngine } from '../services/dbEngine';
import { DatabaseMetadata, QueryHistoryItem, QueryResult } from '../types/sqlite';
import { containsDdl, quoteIdent, toCsvField, toDisplayString } from '../lib/sql';
import { CellDetailModal } from './CellDetailModal';
import { DataGrid } from './DataGrid';

interface SqlEditorProps {
  metadata: DatabaseMetadata;
  /** Called after a statement that may have changed data or the schema. */
  onSchemaChanged: () => void;
}

const HISTORY_STORAGE_KEY = 'sqlite-studio.query-history';
const HISTORY_LIMIT = 30;

function loadHistory(): QueryHistoryItem[] {
  try {
    const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/**
 * Templates built from the database that is actually open, instead of the
 * hard-coded demo-database queries this used to ship with.
 */
function buildTemplates(metadata: DatabaseMetadata) {
  const templates: Array<{ title: string; sql: string }> = [];
  const firstTable = metadata.tables.find((t) => t.type === 'table') ?? metadata.tables[0];

  if (firstTable) {
    const name = quoteIdent(firstTable.name);
    templates.push({
      title: `Erste 20 Zeilen aus ${firstTable.name}`,
      sql: `SELECT * FROM ${name} LIMIT 20;`,
    });

    const groupable = firstTable.columns.find((c) => c.pk !== 1 && c.type !== 'BLOB');
    if (groupable) {
      const column = quoteIdent(groupable.name);
      templates.push({
        title: `Werte in ${firstTable.name}.${groupable.name} zählen`,
        sql: `SELECT ${column} AS wert, COUNT(*) AS anzahl\nFROM ${name}\nGROUP BY ${column}\nORDER BY anzahl DESC\nLIMIT 50;`,
      });
    }

    templates.push({
      title: `Query Plan für ${firstTable.name} analysieren`,
      sql: `EXPLAIN QUERY PLAN SELECT * FROM ${name};`,
    });
  }

  templates.push(
    {
      title: 'Alle Tabellen & Views auflisten',
      sql: "SELECT type, name FROM sqlite_master\nWHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'\nORDER BY type, name;",
    },
    {
      title: 'Alle Indizes auflisten',
      sql: "SELECT name, tbl_name, sql FROM sqlite_master\nWHERE type = 'index' AND sql IS NOT NULL\nORDER BY tbl_name, name;",
    },
    {
      title: 'SQLite-Version & Einstellungen',
      sql: 'SELECT sqlite_version() AS version;',
    }
  );

  return templates;
}

/** Human-readable summary of what a finished batch did. */
function describeResult(result: QueryResult): string {
  const parts: string[] = [];
  if (result.columns.length > 0) {
    parts.push(`${result.rowCount.toLocaleString('de-DE')} ${result.rowCount === 1 ? 'Zeile' : 'Zeilen'} zurückgegeben`);
  }
  if (result.rowsModified > 0) {
    parts.push(`${result.rowsModified.toLocaleString('de-DE')} ${result.rowsModified === 1 ? 'Zeile' : 'Zeilen'} geändert`);
  }
  if (parts.length === 0) {
    parts.push(`${result.statementCount} ${result.statementCount === 1 ? 'Befehl' : 'Befehle'} ausgeführt`);
  }
  return parts.join(' · ');
}

export const SqlEditor: React.FC<SqlEditorProps> = ({ metadata, onSchemaChanged }) => {
  const templates = useMemo(() => buildTemplates(metadata), [metadata]);
  const [sql, setSql] = useState(() => templates[0]?.sql ?? 'SELECT sqlite_version();');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<QueryHistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [inspectedCell, setInspectedCell] = useState<
    { column: string; value: SqlValue; rowIndex: number } | null
  >(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (err) {
      console.warn('Verlauf konnte nicht gespeichert werden', err);
    }
  }, [history]);

  const execute = useCallback(() => {
    const statement = sql.trim();
    if (!statement) return;

    const executed = dbEngine.executeQuery(statement);
    setResult(executed);
    setInspectedCell(null);

    setHistory((previous) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sql: statement,
          timestamp: Date.now(),
          executionTimeMs: executed.executionTimeMs,
          rowCount: executed.rowCount,
          success: !executed.error,
        },
        ...previous.filter((item) => item.sql !== statement),
      ].slice(0, HISTORY_LIMIT)
    );

    // Anything that wrote rows or touched the schema invalidates the sidebar,
    // the schema view and the statistics.
    if (!executed.error && (executed.rowsModified > 0 || containsDdl(statement))) {
      onSchemaChanged();
    }
  }, [sql, onSchemaChanged]);

  const exportResultCsv = () => {
    if (!result || result.values.length === 0) return;
    const lines = [
      result.columns.map(toCsvField).join(','),
      ...result.values.map((row) => row.map(toCsvField).join(',')),
    ];
    const url = URL.createObjectURL(
      new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `query_result_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyAsMarkdown = () => {
    if (!result || result.values.length === 0) return;
    const escape = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [
      `| ${result.columns.map(escape).join(' | ')} |`,
      `| ${result.columns.map(() => '---').join(' | ')} |`,
      ...result.values
        .slice(0, 100)
        .map((row) => `| ${row.map((v) => escape(toDisplayString(v))).join(' | ')} |`),
    ];
    void navigator.clipboard.writeText(lines.join('\n'));
    setCopiedMarkdown(true);
    setTimeout(() => setCopiedMarkdown(false), 2000);
  };

  return (
    <div className="flex-1 h-full flex flex-col min-w-0 bg-[#0A0C11] overflow-hidden">
      <div className="h-12 px-4 border-b border-white/[0.08] glass-toolbar flex items-center justify-between shrink-0 gap-2 select-none">
        <div className="flex items-center gap-2">
          <button
            onClick={execute}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-apple-blue hover:bg-apple-blue-hover text-white text-xs font-semibold shadow-apple-sm transition-colors active:scale-95"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            <span>Ausführen</span>
            <span className="text-[10px] font-mono text-white/70 bg-white/20 px-1 py-0.5 rounded ml-1">
              ⌘↵
            </span>
          </button>

          <button
            onClick={() => {
              setSql('');
              textareaRef.current?.focus();
            }}
            title="Editor leeren"
            aria-label="Editor leeren"
            className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-apple-text-secondary hover:text-white transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <div className="relative">
            <button
              onClick={() => setShowTemplates((open) => !open)}
              aria-expanded={showTemplates}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-apple-text-secondary hover:text-white text-xs transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-apple-purple" />
              <span>SQL-Vorlagen</span>
              <ChevronDown
                className={`w-3 h-3 text-apple-text-tertiary transition-transform ${
                  showTemplates ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showTemplates && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowTemplates(false)} />
                <div className="absolute left-0 top-full mt-1 w-80 bg-[#171923] border border-white/[0.12] rounded-xl shadow-apple-lg p-1.5 z-30">
                  <div className="text-[10px] font-semibold text-apple-text-tertiary uppercase px-2 py-1">
                    Für diese Datenbank erzeugt
                  </div>
                  {templates.map((template) => (
                    <button
                      key={template.title}
                      onClick={() => {
                        setSql(template.sql);
                        setShowTemplates(false);
                        textareaRef.current?.focus();
                      }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-apple-text-primary hover:bg-apple-blue/20 hover:text-white transition-colors truncate"
                    >
                      {template.title}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <button
          onClick={() => setShowHistory((open) => !open)}
          aria-expanded={showHistory}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
            showHistory
              ? 'bg-apple-blue/20 text-apple-blue border-apple-blue/40'
              : 'bg-white/[0.04] hover:bg-white/[0.08] text-apple-text-secondary hover:text-white border-white/[0.08]'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          <span>Historie ({history.length})</span>
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="h-44 shrink-0 bg-[#0F1118] border-b border-white/[0.08] relative">
            <textarea
              ref={textareaRef}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  execute();
                }
              }}
              placeholder="SQL-Befehl eingeben, z. B. SELECT * FROM tabelle LIMIT 10;"
              aria-label="SQL-Editor"
              className="w-full h-full bg-transparent p-4 pb-8 font-mono text-xs text-apple-text-primary resize-none focus:outline-none placeholder:text-apple-text-muted selection:bg-apple-blue/30 leading-relaxed select-text"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="absolute right-3 bottom-2.5 text-[10px] text-apple-text-tertiary select-none font-mono pointer-events-none">
              ⌘ + Enter zum Ausführen
            </div>
          </div>

          {result && (
            <div
              className={`px-4 py-2 border-b flex items-center justify-between gap-3 text-xs ${
                result.error
                  ? 'bg-apple-red/10 border-apple-red/30 text-apple-red'
                  : 'bg-white/[0.02] border-white/[0.06] text-apple-text-secondary'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {result.error ? (
                  <>
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span className="font-mono truncate select-text">{result.error}</span>
                  </>
                ) : (
                  <>
                    <span className="w-2 h-2 rounded-full bg-apple-green shrink-0" />
                    <span className="font-medium text-white truncate">{describeResult(result)}</span>
                    <span className="text-apple-text-tertiary">•</span>
                    <span className="font-mono text-apple-text-tertiary shrink-0">
                      {result.executionTimeMs} ms
                    </span>
                  </>
                )}
              </div>

              {!result.error && result.rowCount > 0 && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={copyAsMarkdown}
                    className="flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] px-2 py-1 rounded-md text-apple-text-secondary hover:text-white border border-white/[0.06] transition-colors"
                  >
                    {copiedMarkdown ? (
                      <>
                        <Check className="w-3 h-3 text-apple-green" />
                        <span>Kopiert</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Markdown</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={exportResultCsv}
                    className="flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] px-2 py-1 rounded-md text-apple-text-secondary hover:text-white border border-white/[0.06] transition-colors"
                  >
                    <Download className="w-3 h-3 text-apple-green" />
                    <span>CSV Export</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex-1 overflow-auto bg-[#0C0E14]">
            {!result ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center text-apple-text-tertiary select-none">
                <Code2 className="w-8 h-8 text-white/20 mb-2" />
                <p className="text-xs font-medium">Noch keine Abfrage ausgeführt</p>
                <p className="text-[11px] text-apple-text-muted mt-0.5">
                  Drücke ⌘ + Enter oder klicke auf „Ausführen“.
                </p>
              </div>
            ) : result.error ? (
              <div className="p-6 font-mono text-xs leading-relaxed">
                <div className="font-bold mb-1 text-apple-red">SQLite Error</div>
                <div className="p-3 rounded-lg bg-apple-red/10 border border-apple-red/20 text-white select-text whitespace-pre-wrap">
                  {result.error}
                </div>
              </div>
            ) : result.values.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center text-apple-text-tertiary select-none">
                <p className="text-xs font-medium">{describeResult(result)}</p>
                <p className="text-[11px] text-apple-text-muted mt-0.5">
                  Keine Ergebniszeilen zurückgegeben.
                </p>
              </div>
            ) : (
              <DataGrid
                columns={result.columns}
                rows={result.values}
                onInspect={setInspectedCell}
              />
            )}
          </div>
        </div>

        {showHistory && (
          <aside className="w-80 h-full border-l border-white/[0.08] bg-[#12141C] flex flex-col shrink-0 select-none">
            <div className="p-3 border-b border-white/[0.08] flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Abfrage-Verlauf</span>
              {history.length > 0 && (
                <button
                  onClick={() => setHistory([])}
                  className="text-[11px] text-apple-red hover:underline"
                >
                  Leeren
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {history.length === 0 ? (
                <p className="text-xs text-apple-text-tertiary text-center py-8">
                  Keine bisherigen Abfragen
                </p>
              ) : (
                history.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSql(item.sql);
                      textareaRef.current?.focus();
                    }}
                    className="w-full text-left p-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] transition-colors group"
                  >
                    <div className="flex items-center justify-between mb-1 text-[10px] font-mono text-apple-text-tertiary">
                      <span className={item.success ? 'text-apple-green' : 'text-apple-red'}>
                        {item.success ? `✓ ${item.rowCount} Zeilen` : '✗ Fehler'}
                      </span>
                      <span>{item.executionTimeMs} ms</span>
                    </div>
                    <div className="text-xs font-mono text-apple-text-secondary group-hover:text-white line-clamp-2 break-all">
                      {item.sql}
                    </div>
                  </button>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      <CellDetailModal cell={inspectedCell} onClose={() => setInspectedCell(null)} />
    </div>
  );
};
