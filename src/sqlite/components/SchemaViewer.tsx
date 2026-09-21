import React, { useState } from 'react';
import { Check, Copy, KeyRound, Link2, ListTree, Table as TableIcon } from 'lucide-react';
import { DatabaseMetadata, TableInfo } from '../types/sqlite';

interface SchemaViewerProps {
  metadata: DatabaseMetadata;
  activeTableName: string | null;
}

export const SchemaViewer: React.FC<SchemaViewerProps> = ({
  metadata,
  activeTableName,
}) => {
  const [copiedDdl, setCopiedDdl] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'columns' | 'ddl' | 'indexes' | 'fks'>('columns');

  const table: TableInfo | undefined = metadata.tables.find((t) => t.name === activeTableName);

  if (!table) {
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-[#0A0C11] text-apple-text-tertiary text-sm">
        Keine Tabelle ausgewählt
      </div>
    );
  }

  const handleCopyDdl = () => {
    void navigator.clipboard.writeText(table.sql);
    setCopiedDdl(true);
    setTimeout(() => setCopiedDdl(false), 2000);
  };

  return (
    <div className="flex-1 h-full flex flex-col min-w-0 bg-[#0A0C11] overflow-hidden">
      {/* Header Toolbar */}
      <div className="h-12 px-6 border-b border-white/[0.08] glass-toolbar flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center space-x-3">
          <div className="w-7 h-7 rounded-lg bg-apple-purple/15 border border-apple-purple/30 flex items-center justify-center text-apple-purple">
            <TableIcon className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-sm font-semibold text-white tracking-tight">{table.name}</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-apple-text-secondary">
                {table.type.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        {/* Sub-tab Pill Switcher */}
        <div className="flex items-center bg-[#151722] p-0.5 rounded-lg border border-white/[0.08]">
          <button
            onClick={() => setActiveSubTab('columns')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              activeSubTab === 'columns'
                ? 'bg-[#2A2E3D] text-white shadow-sm'
                : 'text-apple-text-secondary hover:text-white'
            }`}
          >
            Spalten ({table.columns.length})
          </button>

          <button
            onClick={() => setActiveSubTab('indexes')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              activeSubTab === 'indexes'
                ? 'bg-[#2A2E3D] text-white shadow-sm'
                : 'text-apple-text-secondary hover:text-white'
            }`}
          >
            Indizes ({table.indexes.length})
          </button>

          <button
            onClick={() => setActiveSubTab('fks')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              activeSubTab === 'fks'
                ? 'bg-[#2A2E3D] text-white shadow-sm'
                : 'text-apple-text-secondary hover:text-white'
            }`}
          >
            Fremdschlüssel ({table.foreignKeys.length})
          </button>

          <button
            onClick={() => setActiveSubTab('ddl')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              activeSubTab === 'ddl'
                ? 'bg-[#2A2E3D] text-white shadow-sm'
                : 'text-apple-text-secondary hover:text-white'
            }`}
          >
            CREATE DDL
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-6 select-text">
        {/* Columns View */}
        {activeSubTab === 'columns' && (
          <div className="max-w-4xl mx-auto">
            <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#12141D]/70 backdrop-blur-md shadow-apple-sm">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-white/[0.04] border-b border-white/[0.08] text-apple-text-tertiary text-[11px] font-semibold uppercase tracking-wider">
                    <th className="px-4 py-3">CID</th>
                    <th className="px-4 py-3">Spaltenname</th>
                    <th className="px-4 py-3">Datentyp</th>
                    <th className="px-4 py-3">Primärschlüssel</th>
                    <th className="px-4 py-3">Not Null</th>
                    <th className="px-4 py-3">Standardwert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {table.columns.map((col) => (
                    <tr key={col.cid} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3 font-mono text-apple-text-tertiary text-[11px]">
                        {col.cid}
                      </td>
                      <td className="px-4 py-3 font-semibold text-white flex items-center space-x-2">
                        <span>{col.name}</span>
                        {col.pk === 1 && (
                          <span className="flex items-center space-x-1 text-[10px] text-apple-amber bg-apple-amber/10 px-1.5 py-0.5 rounded border border-apple-amber/20">
                            <KeyRound className="w-2.5 h-2.5" />
                            <span>PK</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs px-2 py-0.5 rounded bg-white/[0.06] text-apple-cyan border border-white/[0.06]">
                          {col.type || 'ANY'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {col.pk === 1 ? (
                          <span className="text-apple-amber font-medium">Ja</span>
                        ) : (
                          <span className="text-apple-text-muted">–</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {col.notnull === 1 ? (
                          <span className="text-apple-red font-medium">NOT NULL</span>
                        ) : (
                          <span className="text-apple-text-muted">NULL</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-apple-text-secondary text-[11px]">
                        {col.dflt_value === null ? (
                          <span className="text-apple-text-muted">keiner</span>
                        ) : (
                          col.dflt_value
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Indexes View */}
        {activeSubTab === 'indexes' && (
          <div className="max-w-4xl mx-auto">
            {table.indexes.length === 0 ? (
              <div className="text-center py-12 text-apple-text-tertiary">
                <ListTree className="w-8 h-8 mx-auto text-white/20 mb-2" />
                <p className="text-xs">Keine Indizes für diese Tabelle definiert.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#12141D]/70 backdrop-blur-md shadow-apple-sm">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-white/[0.04] border-b border-white/[0.08] text-apple-text-tertiary text-[11px] font-semibold uppercase tracking-wider">
                      <th className="px-4 py-3">Index Name</th>
                      <th className="px-4 py-3">Eindeutig (Unique)</th>
                      <th className="px-4 py-3">Indizierte Spalten</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {table.indexes.map((idx) => (
                      <tr key={idx.name} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3 font-mono text-white font-medium">
                          {idx.name}
                        </td>
                        <td className="px-4 py-3">
                          {idx.unique === 1 ? (
                            <span className="text-apple-green font-medium">Ja (Unique)</span>
                          ) : (
                            <span className="text-apple-text-tertiary">Nein</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {idx.columns && idx.columns.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {idx.columns.map((col) => (
                                <span
                                  key={col}
                                  className="font-mono text-[11px] bg-white/[0.06] text-apple-text-primary px-2 py-0.5 rounded border border-white/[0.06]"
                                >
                                  {col}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-apple-text-muted">Standard</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Foreign Keys View */}
        {activeSubTab === 'fks' && (
          <div className="max-w-4xl mx-auto">
            {table.foreignKeys.length === 0 ? (
              <div className="text-center py-12 text-apple-text-tertiary">
                <Link2 className="w-8 h-8 mx-auto text-white/20 mb-2" />
                <p className="text-xs">Keine Fremdschlüssel für diese Tabelle definiert.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#12141D]/70 backdrop-blur-md shadow-apple-sm">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-white/[0.04] border-b border-white/[0.08] text-apple-text-tertiary text-[11px] font-semibold uppercase tracking-wider">
                      <th className="px-4 py-3">Eigene Spalte</th>
                      <th className="px-4 py-3">Ziel-Tabelle</th>
                      <th className="px-4 py-3">Ziel-Spalte</th>
                      <th className="px-4 py-3">On Delete</th>
                      <th className="px-4 py-3">On Update</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {table.foreignKeys.map((fk, idx) => (
                      <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3 font-mono font-semibold text-apple-blue">
                          {fk.from}
                        </td>
                        <td className="px-4 py-3 font-medium text-white">
                          {fk.table}
                        </td>
                        <td className="px-4 py-3 font-mono text-apple-purple">
                          {fk.to || 'PRIMARY KEY'}
                        </td>
                        <td className="px-4 py-3 font-mono text-apple-text-secondary text-[11px]">
                          {fk.on_delete || 'NO ACTION'}
                        </td>
                        <td className="px-4 py-3 font-mono text-apple-text-secondary text-[11px]">
                          {fk.on_update || 'NO ACTION'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* DDL SQL View */}
        {activeSubTab === 'ddl' && (
          <div className="max-w-4xl mx-auto space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-apple-text-tertiary uppercase tracking-wider">
                Original SQLite DDL
              </span>
              <button
                onClick={handleCopyDdl}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs text-white border border-white/[0.08] transition-colors"
              >
                {copiedDdl ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-apple-green" />
                    <span>Kopiert!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-apple-text-secondary" />
                    <span>DDL Kopieren</span>
                  </>
                )}
              </button>
            </div>

            <div className="p-4 rounded-xl bg-[#0F1118] border border-white/[0.08] overflow-x-auto shadow-apple-sm">
              <pre className="font-mono text-xs text-apple-text-primary leading-relaxed whitespace-pre-wrap selection:bg-apple-blue/30">
                {table.sql || '-- Kein explizites DDL gefunden'}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
