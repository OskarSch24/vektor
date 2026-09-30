import { buildTable, ImportedTable, RawCell, tableNameFrom } from './tables';

/**
 * Legacy Excel (`.xls`), OpenDocument (`.ods`) and Apple Numbers workbooks.
 * `.xlsx` keeps its smaller dedicated reader; SheetJS is loaded lazily and only
 * for the formats that reader cannot open.
 */
export async function importSpreadsheet(bytes: Uint8Array, filename: string): Promise<ImportedTable[]> {
  const XLSX = await import('xlsx');

  let workbook;
  try {
    // Formulas are read as their cached results; macros and external links
    // are never evaluated.
    workbook = XLSX.read(bytes, { type: 'array', cellDates: true, cellFormula: false, cellHTML: false });
  } catch (err: any) {
    throw new Error(`"${filename}" konnte nicht gelesen werden: ${err?.message || err}`);
  }

  const tables: ImportedTable[] = [];
  const usedNames = new Set<string>();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const data = XLSX.utils.sheet_to_json<RawCell[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
    if (data.length === 0) continue;

    let name = tableNameFrom(sheetName);
    while (usedNames.has(name)) name = `${name}_2`;
    usedNames.add(name);

    const [header, ...body] = data;
    tables.push(buildTable(name, header, body));
  }

  if (tables.length === 0) {
    throw new Error(`"${filename}" enthält keine Tabellenblätter mit Daten.`);
  }
  return tables;
}
