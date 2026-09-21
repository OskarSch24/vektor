import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Combine,
  FilePlus2,
  Files,
  LoaderCircle,
  Trash2,
} from 'lucide-react';
import type { SqlValue } from 'sql.js';
import type { ImportedTable } from '../services/importers';
import { tableNameFrom } from '../services/importers/tables';
import {
  defaultMergeFilename,
  loadFilesForMerge,
  MERGE_FILE_INPUT_ACCEPT,
  normaliseMergeFilename,
  type LoadedMergeFiles,
} from '../services/importers/mergeFiles';
import {
  mergeImportedTables,
  unionColumns,
  type MergeTablesResult,
} from '../services/importers/mergeTables';
import { Modal } from './Modal';

const PREVIEW_ROWS = 7;

export interface MergeFilesReport extends Omit<MergeTablesResult, 'tables'> {
  targetFilename: string;
  sourceFilenames: string[];
  totalBytes: number;
}

export interface MergeFilesModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Receives the in-memory table plus useful UI/reporting metadata. */
  onMerged: (
    tables: ImportedTable[],
    report: MergeFilesReport
  ) => void | Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

function previewValue(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `<${value.byteLength} Bytes>`;
  return String(value);
}

function fileIdentity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export const MergeFilesModal: React.FC<MergeFilesModalProps> = ({
  isOpen,
  onClose,
  onMerged,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const readGeneration = useRef(0);
  const [files, setFiles] = useState<File[]>([]);
  const [loaded, setLoaded] = useState<LoadedMergeFiles | null>(null);
  const [targetName, setTargetName] = useState('zusammengefuehrt.sqlite');
  const [removeDuplicates, setRemoveDuplicates] = useState(false);
  const [dedupeColumns, setDedupeColumns] = useState<Set<string>>(new Set());
  const [isReading, setIsReading] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columns = useMemo(
    () => (loaded ? unionColumns(loaded.sources) : []),
    [loaded]
  );
  const preview = useMemo(() => {
    if (!loaded) return null;
    return mergeImportedTables(loaded.sources, {
      // The target name does not change the data. Keeping it out of this memo
      // prevents a complete large-file merge on every input keystroke.
      targetName: 'zusammengefuehrt',
      deduplicateBy: removeDuplicates ? [...dedupeColumns] : [],
    });
  }, [dedupeColumns, loaded, removeDuplicates]);

  const readFiles = async (nextFiles: File[]) => {
    const generation = ++readGeneration.current;
    setFiles(nextFiles);
    setError(null);

    if (nextFiles.length === 0) {
      setLoaded(null);
      setDedupeColumns(new Set());
      setIsReading(false);
      return;
    }

    setIsReading(true);
    try {
      const nextLoaded = await loadFilesForMerge(nextFiles);
      if (generation !== readGeneration.current) return;
      const nextColumns = unionColumns(nextLoaded.sources);
      setLoaded(nextLoaded);
      setDedupeColumns(new Set(nextColumns.map((column) => column.name)));
      setTargetName(defaultMergeFilename(nextFiles));
    } catch (cause) {
      if (generation !== readGeneration.current) return;
      setLoaded(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === readGeneration.current) setIsReading(false);
    }
  };

  const handlePickedFiles = (picked: FileList | null) => {
    if (!picked) return;
    const byIdentity = new Map(files.map((file) => [fileIdentity(file), file]));
    for (const file of Array.from(picked)) byIdentity.set(fileIdentity(file), file);
    void readFiles([...byIdentity.values()]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeFile = (file: File) => {
    void readFiles(files.filter((candidate) => fileIdentity(candidate) !== fileIdentity(file)));
  };

  const toggleDedupeColumn = (name: string) => {
    setDedupeColumns((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const finishMerge = async () => {
    if (!loaded || !preview) return;
    if (files.length < 2) {
      setError('Bitte wähle mindestens zwei Dateien aus.');
      return;
    }
    if (removeDuplicates && dedupeColumns.size === 0) {
      setError('Wähle mindestens eine Spalte für die Dublettenerkennung aus.');
      return;
    }

    setIsMerging(true);
    setError(null);
    try {
      const targetFilename = normaliseMergeFilename(targetName);
      const targetTables = preview.tables.map((table, index) =>
        index === 0 ? { ...table, name: tableNameFrom(targetFilename) } : table
      );
      await onMerged(targetTables, {
        targetFilename,
        sourceFilenames: loaded.filenames,
        totalBytes: loaded.totalBytes,
        inputRows: preview.inputRows,
        outputRows: preview.outputRows,
        duplicatesRemoved: preview.duplicatesRemoved,
        sourceFiles: files.length,
        sourceTables: preview.sourceTables,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsMerging(false);
    }
  };

  const close = () => {
    readGeneration.current += 1;
    setIsReading(false);
    onClose();
  };

  const cannotMerge =
    !preview ||
    files.length < 2 ||
    isReading ||
    isMerging ||
    targetName.trim() === '' ||
    (removeDuplicates && dedupeColumns.size === 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      labelledBy="merge-files-title"
      className="max-w-[920px] max-h-[min(86vh,780px)]"
      header={
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] border border-[#3b454b] bg-[#20282c] text-[#9fc1d1]">
            <Combine className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <h2 id="merge-files-title" className="text-[12px] font-medium text-[#ededed]">
              Dateien zusammenführen
            </h2>
            <p className="mt-0.5 text-[10px] text-[#858585]">
              Spalten vereinigen, Vorschau prüfen und als eine Tabelle öffnen
            </p>
          </div>
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <p className="min-w-0 truncate font-mono text-[9.5px] text-[#737373]">
            {preview
              ? `${preview.outputRows.toLocaleString('de-DE')} Zeilen · ${columns.length} Spalten · lokal`
              : 'Keine Daten geladen'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-[4px] px-3 py-1.5 text-[11px] text-[#b5b5b5] transition-colors hover:bg-white/[0.055] hover:text-white"
            >
              Abbrechen
            </button>
            <button
              type="button"
              disabled={cannotMerge}
              onClick={() => void finishMerge()}
              className="flex min-w-[142px] items-center justify-center gap-1.5 rounded-[4px] border border-[#55738a] bg-[#31546b] px-3 py-1.5 text-[11px] font-medium text-[#f4f7f9] shadow-[inset_0_1px_rgba(255,255,255,0.07)] transition-colors hover:bg-[#3a6079] disabled:cursor-not-allowed disabled:border-[#383838] disabled:bg-[#292929] disabled:text-[#686868]"
            >
              {isMerging ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Zusammenführen
            </button>
          </div>
        </div>
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={MERGE_FILE_INPUT_ACCEPT}
        onChange={(event) => handlePickedFiles(event.target.files)}
        className="hidden"
      />

      <div className="grid min-h-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4 lg:border-r lg:border-white/[0.075] lg:pr-4">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[#777]">
                Quelldateien
              </h3>
              {files.length > 0 && (
                <span className="font-mono text-[9px] text-[#666]">{files.length}</span>
              )}
            </div>

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={isReading}
              className="flex w-full items-center gap-2 rounded-[5px] border border-[#3a3a3a] bg-[#202020] px-2.5 py-2 text-left text-[10.5px] text-[#c8c8c8] transition-colors hover:border-[#4b4b4b] hover:bg-[#242424] disabled:cursor-wait disabled:opacity-60"
            >
              {isReading ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#8eb5ca]" />
              ) : (
                <FilePlus2 className="h-3.5 w-3.5 text-[#8eb5ca]" />
              )}
              {files.length > 0 ? 'Weitere Dateien wählen' : 'Dateien wählen'}
            </button>

            {files.length === 0 ? (
              <div className="mt-2 rounded-[5px] border border-dashed border-[#343434] px-3 py-5 text-center">
                <Files className="mx-auto h-4 w-4 text-[#626262]" />
                <p className="mt-2 text-[10px] leading-4 text-[#737373]">
                  Mindestens zwei CSV-, TSV-, JSON- oder Excel-Dateien auswählen.
                </p>
              </div>
            ) : (
              <div className="mt-2 max-h-40 space-y-px overflow-y-auto rounded-[5px] border border-[#303030] bg-[#191919] p-1">
                {files.map((file) => (
                  <div
                    key={fileIdentity(file)}
                    className="group flex min-w-0 items-center gap-2 rounded-[3px] px-2 py-1.5 hover:bg-white/[0.04]"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#73a0b6]" />
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-[#c7c7c7]" title={file.name}>
                      {file.name}
                    </span>
                    <span className="shrink-0 font-mono text-[8.5px] text-[#626262]">
                      {formatBytes(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(file)}
                      aria-label={`${file.name} entfernen`}
                      className="shrink-0 rounded-[3px] p-1 text-[#555] opacity-0 transition-colors hover:bg-white/[0.06] hover:text-[#d37b86] group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <label
              htmlFor="merge-target-name"
              className="mb-2 block font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[#777]"
            >
              Zieldokument
            </label>
            <input
              id="merge-target-name"
              value={targetName}
              onChange={(event) => setTargetName(event.target.value)}
              spellCheck={false}
              className="h-8 w-full rounded-[4px] border border-[#383838] bg-[#1d1d1d] px-2.5 font-mono text-[10.5px] text-[#d8d8d8] placeholder:text-[#595959] focus:border-[#617f94] focus:outline-none"
              placeholder="zusammengefuehrt.sqlite"
            />
          </section>

          <section>
            <label className="flex cursor-pointer items-center gap-2 text-[10.5px] text-[#bcbcbc]">
              <input
                type="checkbox"
                checked={removeDuplicates}
                onChange={(event) => setRemoveDuplicates(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-[#4a4a4a] bg-[#222] accent-[#638ca4]"
              />
              Dubletten entfernen
            </label>
            <p className="mt-1 pl-[22px] text-[9.5px] leading-4 text-[#666]">
              Die erste gefundene Zeile bleibt erhalten.
            </p>
          </section>
        </aside>

        <div className="min-w-0 space-y-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-[5px] border border-[#6f3b42] bg-[#3a2024] px-3 py-2 text-[10.5px] leading-4 text-[#e1a1a9]">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loaded && preview ? (
            <>
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[#777]">
                    Gemeinsames Schema
                  </h3>
                  <span className="font-mono text-[9px] text-[#626262]">
                    {loaded.sources.length} Tabellen · {columns.length} Spalten
                  </span>
                </div>
                <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                  {columns.map((column) => {
                    const selected = dedupeColumns.has(column.name);
                    return (
                      <button
                        key={column.name}
                        type="button"
                        disabled={!removeDuplicates}
                        aria-pressed={removeDuplicates && selected}
                        onClick={() => toggleDedupeColumn(column.name)}
                        title={removeDuplicates ? 'Für Dublettenerkennung verwenden' : 'Zuerst Dublettenerkennung aktivieren'}
                        className={`flex items-center gap-1.5 rounded-[4px] border px-2 py-1 font-mono text-[9px] transition-colors ${
                          removeDuplicates && selected
                            ? 'border-[#4f7186] bg-[#253742] text-[#a9cad9]'
                            : 'border-[#353535] bg-[#202020] text-[#888]'
                        } disabled:cursor-default`}
                      >
                        {removeDuplicates && (
                          <span className={`h-1.5 w-1.5 rounded-full ${selected ? 'bg-[#82b2c7]' : 'bg-[#4b4b4b]'}`} />
                        )}
                        <span>{column.name}</span>
                        <span className="text-[8px] text-[#606060]">{column.type}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-[#777]">
                    Vorschau
                  </h3>
                  <span className="text-[9.5px] text-[#6f6f6f]">
                    {preview.duplicatesRemoved > 0
                      ? `${preview.duplicatesRemoved.toLocaleString('de-DE')} Dubletten entfernt`
                      : `Erste ${Math.min(PREVIEW_ROWS, preview.outputRows)} Zeilen`}
                  </span>
                </div>
                <div className="max-h-[310px] overflow-auto rounded-[5px] border border-[#303030] bg-[#161616]">
                  <table className="min-w-full border-separate border-spacing-0 text-left font-mono text-[9.5px]">
                    <thead className="sticky top-0 z-10 bg-[#202020] text-[#a9a9a9] shadow-[0_1px_#303030]">
                      <tr>
                        <th className="border-r border-[#303030] px-2 py-1.5 font-normal text-[#555]">#</th>
                        {columns.map((column) => (
                          <th key={column.name} className="whitespace-nowrap border-r border-[#303030] px-2.5 py-1.5 font-medium last:border-r-0">
                            {column.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.tables[0].rows.slice(0, PREVIEW_ROWS).map((row, rowIndex) => (
                        <tr key={rowIndex} className="hover:bg-white/[0.025]">
                          <td className="border-b border-r border-[#292929] px-2 py-1.5 text-[#505050]">
                            {rowIndex + 1}
                          </td>
                          {row.map((value, columnIndex) => (
                            <td
                              key={columnIndex}
                              className={`max-w-48 truncate whitespace-nowrap border-b border-r border-[#292929] px-2.5 py-1.5 last:border-r-0 ${
                                value === null ? 'italic text-[#535353]' : 'text-[#bcbcbc]'
                              }`}
                              title={previewValue(value)}
                            >
                              {previewValue(value)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : !error && (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-[6px] border border-dashed border-[#313131] bg-[#191919] text-center">
              {isReading ? (
                <LoaderCircle className="h-5 w-5 animate-spin text-[#83a9bd]" />
              ) : (
                <Combine className="h-5 w-5 text-[#575757]" />
              )}
              <p className="mt-3 text-[11px] text-[#858585]">
                {isReading ? 'Dateien werden analysiert…' : 'Dateien wählen, um das gemeinsame Schema zu sehen.'}
              </p>
              <p className="mt-1 text-[9.5px] text-[#5e5e5e]">Die Verarbeitung bleibt vollständig auf diesem Gerät.</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
