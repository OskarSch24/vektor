import { detectFormat, importTables } from './index';
import type { MergeTableSource } from './mergeTables';

export const MERGE_FILE_INPUT_ACCEPT = '.csv,.tsv,.json,.jsonl,.ndjson,.xlsx,.xlsm';

export interface MergeFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface LoadedMergeFiles {
  sources: MergeTableSource[];
  filenames: string[];
  totalBytes: number;
}

/** Reads browser Files through the existing format-specific importers. */
export async function loadFilesForMerge(
  files: readonly MergeFileLike[]
): Promise<LoadedMergeFiles> {
  if (files.length === 0) {
    throw new Error('Bitte wähle mindestens eine Datei aus.');
  }

  const loaded = await Promise.all(
    files.map(async (file) => {
      const format = detectFormat(file.name);
      if (format === null || format === 'sqlite') {
        throw new Error(
          `„${file.name}“ kann hier nicht zusammengeführt werden. Unterstützt werden CSV, TSV, JSON, JSONL und Excel.`
        );
      }
      const tables = await importTables(new Uint8Array(await file.arrayBuffer()), file.name, format);
      return tables.map((table) => ({ filename: file.name, table }));
    })
  );

  return {
    sources: loaded.flat(),
    filenames: files.map((file) => file.name),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export function defaultMergeFilename(files: readonly Pick<MergeFileLike, 'name'>[]): string {
  if (files.length === 0) return 'zusammengefuehrt.sqlite';
  const firstBase = files[0].name.replace(/\.[^./\\]+$/, '').replace(/(?:[_-]?\d+)$/, '');
  const clean = firstBase.trim().replace(/[_-]+$/, '') || 'zusammengefuehrt';
  return `${clean}_zusammengefuehrt.sqlite`;
}

export function normaliseMergeFilename(value: string): string {
  const clean = value.trim().replace(/[/\\:*?"<>|]/g, '_');
  if (clean === '') return 'zusammengefuehrt.sqlite';
  return /\.sqlite$/i.test(clean) ? clean : `${clean}.sqlite`;
}

