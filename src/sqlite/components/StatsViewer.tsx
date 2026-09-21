import React, { useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  Database,
  Layers,
  Cpu,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { DatabaseMetadata } from '../types/sqlite';
import { dbEngine } from '../services/dbEngine';
import { formatBytes } from '../lib/sql';

interface StatsViewerProps {
  metadata: DatabaseMetadata;
}

export const StatsViewer: React.FC<StatsViewerProps> = ({ metadata }) => {
  const [integrity, setIntegrity] = useState<{ ok: boolean; message: string } | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const runIntegrityCheck = () => {
    setIsChecking(true);
    // Yield one frame so the button can render its spinner before the
    // synchronous WebAssembly check blocks the main thread.
    requestAnimationFrame(() => {
      setIntegrity(dbEngine.checkIntegrity());
      setIsChecking(false);
    });
  };

  const tables = metadata.tables.filter((t) => t.type === 'table');
  const maxRows = Math.max(...tables.map((t) => t.rowCount ?? 0), 1);

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#0A0C11] text-xs select-text">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header Title */}
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">
            Datenbank Statistiken & Diagnose
          </h2>
          <p className="text-apple-text-secondary text-xs mt-0.5">
            Übersicht über Tabellengrößen, Zeilenverteilung und SQLite Engine-Parameter
          </p>
        </div>

        {/* Quick KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-4 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm">
            <div className="flex items-center justify-between text-apple-text-tertiary mb-2">
              <span className="text-[11px] font-medium uppercase tracking-wider">Tabellen</span>
              <Database className="w-4 h-4 text-apple-blue" />
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              {metadata.tableCount}
            </div>
            <div className="text-[10px] text-apple-text-muted mt-1">
              + {metadata.viewCount} Views
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm">
            <div className="flex items-center justify-between text-apple-text-tertiary mb-2">
              <span className="text-[11px] font-medium uppercase tracking-wider">Gesamt-Zeilen</span>
              <Layers className="w-4 h-4 text-apple-purple" />
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              {metadata.totalRows.toLocaleString('de-DE')}
            </div>
            <div className="text-[10px] text-apple-text-muted mt-1">
              in allen Tabellen
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm">
            <div className="flex items-center justify-between text-apple-text-tertiary mb-2">
              <span className="text-[11px] font-medium uppercase tracking-wider">Dateigröße</span>
              <HardDrive className="w-4 h-4 text-apple-green" />
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              {formatBytes(metadata.fileSize)}
            </div>
            <div className="text-[10px] text-apple-text-muted mt-1">
              Page Size: {metadata.pageSize.toLocaleString('de-DE')} Bytes
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm">
            <div className="flex items-center justify-between text-apple-text-tertiary mb-2">
              <span className="text-[11px] font-medium uppercase tracking-wider">SQLite Version</span>
              <Cpu className="w-4 h-4 text-apple-cyan" />
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              v{metadata.sqliteVersion}
            </div>
            <div className="text-[10px] text-apple-text-muted mt-1">
              WebAssembly Core
            </div>
          </div>
        </div>

        {/* Row Count Distribution Bar Chart */}
        <div className="p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <BarChart3 className="w-4 h-4 text-apple-blue" />
              <h3 className="text-sm font-semibold text-white">
                Zeilenverteilung nach Tabelle
              </h3>
            </div>
            <span className="text-[11px] text-apple-text-tertiary">
              {tables.length} Tabellen
            </span>
          </div>

          <div className="space-y-3 pt-1">
            {tables.map((t) => {
              const rowCount = t.rowCount ?? 0;
              const percentage = Math.round((rowCount / maxRows) * 100);
              const shareOfTotal =
                metadata.totalRows > 0 ? Math.round((rowCount / metadata.totalRows) * 100) : 0;
              return (
                <div key={t.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-apple-text-primary">{t.name}</span>
                    <span className="font-mono text-apple-text-secondary text-[11px]">
                      {rowCount.toLocaleString('de-DE')} Zeilen ({shareOfTotal}%)
                    </span>
                  </div>
                  <div className="h-2 w-full bg-white/[0.05] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-apple-blue to-apple-cyan rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(percentage, 2)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* SQLite Pragmas & Health Check */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Pragmas table */}
          <div className="p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm space-y-3">
            <h3 className="text-sm font-semibold text-white">
              SQLite Pragma Einstellungen
            </h3>
            <div className="divide-y divide-white/[0.06] text-xs">
              <div className="py-2 flex items-center justify-between">
                <span className="text-apple-text-tertiary font-mono">encoding</span>
                <span className="font-mono text-white">{metadata.encoding}</span>
              </div>
              <div className="py-2 flex items-center justify-between">
                <span className="text-apple-text-tertiary font-mono">journal_mode</span>
                <span className="font-mono text-apple-green uppercase">{metadata.journalMode}</span>
              </div>
              <div className="py-2 flex items-center justify-between">
                <span className="text-apple-text-tertiary font-mono">page_size</span>
                <span className="font-mono text-white">{metadata.pageSize.toLocaleString('de-DE')} Bytes</span>
              </div>
              <div className="py-2 flex items-center justify-between">
                <span className="text-apple-text-tertiary font-mono">page_count</span>
                <span className="font-mono text-white">{metadata.pageCount.toLocaleString('de-DE')}</span>
              </div>
            </div>
          </div>

          {/* Integrity Check */}
          <div className="p-5 rounded-xl bg-[#141722]/80 border border-white/[0.08] shadow-apple-sm flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center space-x-2 mb-1">
                <ShieldCheck className="w-4 h-4 text-apple-green" />
                <h3 className="text-sm font-semibold text-white">
                  Datenbank-Integritätsprüfung
                </h3>
              </div>
              <p className="text-[11px] text-apple-text-secondary leading-relaxed">
                Überprüft die SQLite B-Trees, Freelist-Seiten und Index-Konsistenz mit <code className="text-apple-text-primary">PRAGMA integrity_check</code>.
              </p>
            </div>

            {integrity && (
              <div
                className={`p-3 rounded-lg border text-xs font-mono flex items-start gap-2 ${
                  integrity.ok
                    ? 'bg-apple-green/10 border-apple-green/30 text-apple-green'
                    : 'bg-apple-red/10 border-apple-red/30 text-apple-red'
                }`}
              >
                {integrity.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span className="break-words whitespace-pre-wrap select-text">
                  {integrity.message}
                </span>
              </div>
            )}

            <button
              onClick={runIntegrityCheck}
              disabled={isChecking}
              className="flex items-center justify-center space-x-2 w-full py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white font-medium text-xs transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Wird geprüft...' : 'Integrität prüfen'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
