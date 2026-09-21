import React, { useEffect, useState } from 'react';
import { Code, Database, Download, FileText } from 'lucide-react';
import { DatabaseMetadata } from '../types/sqlite';
import { dbEngine } from '../services/dbEngine';
import { quoteIdent, toCsvField, toJsonValue, toSqlLiteral } from '../lib/sql';
import { Modal } from './Modal';

type ExportFormat = 'sqlite' | 'csv' | 'json' | 'sql';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  metadata: DatabaseMetadata | null;
  activeTable: string | null;
  onDatabaseExported?: () => void;
}

const FORMATS: Array<{
  id: ExportFormat;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'sqlite',
    label: 'SQLite DB',
    hint: 'Komplette .sqlite Datei',
    icon: <Database className="w-4 h-4 text-apple-blue shrink-0" />,
  },
  {
    id: 'csv',
    label: 'CSV Datei',
    hint: 'Tabellendaten (Excel)',
    icon: <FileText className="w-4 h-4 text-apple-green shrink-0" />,
  },
  {
    id: 'json',
    label: 'JSON',
    hint: 'Strukturierte Daten',
    icon: <Code className="w-4 h-4 text-apple-amber shrink-0" />,
  },
  {
    id: 'sql',
    label: 'SQL INSERTs',
    hint: 'SQL Dump Statements',
    icon: <FileText className="w-4 h-4 text-apple-purple shrink-0" />,
  },
];

function downloadFile(content: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before dropping the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Strips characters that are illegal or awkward in a download filename. */
function safeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  onError,
  metadata,
  activeTable,
  onDatabaseExported,
}) => {
  const [format, setFormat] = useState<ExportFormat>('sqlite');
  const [targetTable, setTargetTable] = useState<string>('');

  // Follow the table the user is looking at each time the dialog opens, rather
  // than freezing whichever table happened to be active on first mount.
  useEffect(() => {
    if (isOpen) {
      setFormat('sqlite');
      setTargetTable(activeTable ?? metadata?.tables[0]?.name ?? '');
    }
  }, [isOpen, activeTable, metadata]);

  if (!metadata) return null;

  const baseName = safeFilename(metadata.filename.replace(/\.[^/.]+$/, '')) || 'database';

  const exportWholeDatabase = () => {
    const exported = dbEngine.exportDatabase();
    // Copy out of the WebAssembly heap so the Blob owns plain memory.
    const bytes = new Uint8Array(exported.byteLength);
    bytes.set(exported);
    downloadFile(bytes, `${baseName}.sqlite`, 'application/x-sqlite3');
  };

  const exportTable = (table: string) => {
    const { columns, values } = dbEngine.getAllRows(table);
    const file = safeFilename(table);

    if (format === 'csv') {
      const lines = [
        columns.map((column) => toCsvField(column)).join(','),
        ...values.map((row) => row.map(toCsvField).join(',')),
      ];
      // The BOM makes Excel read the file as UTF-8 instead of mangling umlauts.
      downloadFile(`﻿${lines.join('\r\n')}`, `${file}.csv`, 'text/csv;charset=utf-8;');
      return;
    }

    if (format === 'json') {
      const rows = values.map((row) =>
        Object.fromEntries(columns.map((column, i) => [column, toJsonValue(row[i])]))
      );
      downloadFile(JSON.stringify(rows, null, 2), `${file}.json`, 'application/json');
      return;
    }

    const columnList = columns.map(quoteIdent).join(', ');
    const inserts = values.map(
      (row) =>
        `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${row
          .map(toSqlLiteral)
          .join(', ')});`
    );
    const header = [
      '-- Exportiert mit Vektor',
      `-- Tabelle: ${table}`,
      `-- Zeilen: ${values.length}`,
      '',
      'BEGIN TRANSACTION;',
    ];
    downloadFile(
      [...header, ...inserts, 'COMMIT;', ''].join('\n'),
      `${file}_dump.sql`,
      'text/plain;charset=utf-8;'
    );
  };

  const handleExport = () => {
    try {
      if (format === 'sqlite') {
        exportWholeDatabase();
        onDatabaseExported?.();
      } else if (!targetTable) {
        onError('Bitte wähle eine Tabelle aus.');
        return;
      } else {
        exportTable(targetTable);
      }
      onClose();
    } catch (err: any) {
      onError(`Export fehlgeschlagen: ${err?.message || err}`);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy="export-title"
      header={
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-apple-green/15 border border-apple-green/30 flex items-center justify-center text-apple-green shrink-0">
            <Download className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 id="export-title" className="text-sm font-semibold text-white">
              Daten exportieren
            </h3>
            <p className="text-[11px] text-apple-text-tertiary">
              Format und Ziel für den Download wählen
            </p>
          </div>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-apple-text-secondary hover:text-white hover:bg-white/[0.05] transition-colors"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-apple-blue hover:bg-apple-blue-hover shadow-sm transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Jetzt herunterladen</span>
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-xs">
        <fieldset>
          <legend className="block text-[11px] font-semibold text-apple-text-tertiary uppercase tracking-wider mb-2">
            Export-Format
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {FORMATS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={format === option.id}
                onClick={() => setFormat(option.id)}
                className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                  format === option.id
                    ? 'bg-apple-blue/15 border-apple-blue text-white shadow-sm'
                    : 'bg-white/[0.03] border-white/[0.08] text-apple-text-secondary hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                {option.icon}
                <span className="min-w-0">
                  <span className="block font-medium text-xs">{option.label}</span>
                  <span className="block text-[10px] text-apple-text-tertiary">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        {format !== 'sqlite' && (
          <div>
            <label
              htmlFor="export-table"
              className="block text-[11px] font-semibold text-apple-text-tertiary uppercase tracking-wider mb-2"
            >
              Tabelle auswählen
            </label>
            <select
              id="export-table"
              value={targetTable}
              onChange={(e) => setTargetTable(e.target.value)}
              className="w-full bg-[#1A1D27] text-apple-text-primary px-3 py-2 rounded-lg border border-white/[0.08] focus:border-apple-blue focus:outline-none"
            >
              {metadata.tables.map((table) => (
                <option key={table.name} value={table.name}>
                  {table.name}
                  {table.rowCount === null
                    ? ' (View)'
                    : ` (${table.rowCount.toLocaleString('de-DE')} Zeilen)`}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[11px] text-apple-text-tertiary">
              Binärspalten (BLOB) werden
              {format === 'sql' ? " als X'…'-Literal" : ' Base64-kodiert'} exportiert.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
};
