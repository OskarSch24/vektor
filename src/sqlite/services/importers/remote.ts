import { callNative } from "../../../services/nativeHost";
import { importJson } from "./json";
import { jsonText } from "./documents";
import type { ImportedTable } from "./tables";

export async function importRemote(
  bytes: Uint8Array,
  filename: string,
  format: "duckdb" | "connection",
): Promise<ImportedTable[]> {
  let params: Record<string, unknown>;
  if (format === "connection")
    params = { format, config: JSON.parse(new TextDecoder().decode(bytes)) };
  else {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    params = { format, base64: btoa(binary) };
  }
  const result = await callNative<{
    tables: {
      name: string;
      records: unknown[];
      columns?: string[];
      truncated: boolean;
    }[];
    limit: number;
    omitted: number;
    readAt: string;
  }>("sources", "read", params);
  if (!result.tables.length)
    throw new Error(
      "Die Quelle enthält keine zugänglichen Tabellen oder Sammlungen.",
    );
  const used = new Set<string>();
  return result.tables.map((source) => {
    let name = source.name;
    while (used.has(name.toLowerCase())) name += "_";
    used.add(name.toLowerCase());
    const table = importJson(
      new TextEncoder().encode(jsonText(source.records)),
      `${name}.json`,
    )[0];
    table.name = name;
    if (!source.records.length && source.columns?.length)
      table.columns = source.columns.map((column) => ({
        name: column,
        type: "TEXT",
      }));
    table.sourceInfo = `${filename} · Lesestand ${new Date(result.readAt).toLocaleString("de-DE")} · ${source.truncated ? `erste ${result.limit.toLocaleString("de-DE")} Zeilen, weitere vorhanden` : "vollständig gelesen"}${result.omitted ? ` · ${result.omitted} weitere Tabellen nicht geladen (max. 50)` : ""}. Erneut öffnen aktualisiert den Lesestand; SQL arbeitet auf der lokalen Kopie.`;
    return table;
  });
}
