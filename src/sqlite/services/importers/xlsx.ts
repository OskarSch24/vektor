import { buildTable, ImportedTable, RawCell, tableNameFrom } from './tables';

/**
 * Reads every sheet of a workbook into its own table. The parser is imported
 * lazily so its code only reaches the app when someone actually opens a
 * spreadsheet.
 */
export async function importXlsx(bytes: Uint8Array, filename: string): Promise<ImportedTable[]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');

  let sheets;
  try {
    // `slice()` detaches the view from the fetch buffer that produced it.
    sheets = await readXlsxFile(new Blob([bytes.slice()]));
  } catch (err: any) {
    throw new Error(`"${filename}" konnte nicht gelesen werden: ${err?.message || err}`);
  }

  const tables: ImportedTable[] = [];
  const usedNames = new Set<string>();

  for (const { sheet, data } of sheets) {
    // Skip empty sheets rather than creating a table without columns.
    if (data.length === 0) continue;

    let name = tableNameFrom(sheet);
    while (usedNames.has(name)) name = `${name}_2`;
    usedNames.add(name);

    const [header, ...body] = data as unknown as RawCell[][];
    tables.push(buildTable(name, header, body));
  }

  if (tables.length === 0) {
    throw new Error(`"${filename}" enthält keine Tabellenblätter mit Daten.`);
  }
  return tables;
}
