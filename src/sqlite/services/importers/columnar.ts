import { importJson } from "./json";
import { jsonText } from "./documents";
import type { ImportedTable } from "./tables";

export async function importColumnar(
  bytes: Uint8Array,
  filename: string,
  format: "parquet" | "arrow",
): Promise<ImportedTable[]> {
  let records: unknown[];
  if (format === "parquet") {
    const [{ parquetReadObjects, parquetMetadataAsync }, { compressors }] =
      await Promise.all([import("hyparquet"), import("hyparquet-compressors")]);
    records = await parquetReadObjects({
      file: bytes.slice().buffer,
      compressors,
    });
    if (!records.length) {
      const metadata = await parquetMetadataAsync(bytes.slice().buffer);
      const columns: { name: string; type: "TEXT" }[] = [];
      let index = 1;
      const skip = (): void => {
        const entry = metadata.schema[index++];
        for (let n = 0; n < (entry?.num_children ?? 0); n++) skip();
      };
      while (index < metadata.schema.length) {
        columns.push({ name: metadata.schema[index].name, type: "TEXT" });
        skip();
      }
      if (columns.length)
        return [
          {
            name:
              filename.replace(/\.[^.]+$/, "").replace(/\W/g, "_") || "daten",
            columns,
            rows: [],
          },
        ];
    }
  } else {
    const { tableFromIPC } = await import("apache-arrow");
    const table = tableFromIPC(bytes);
    records = Array.from(table, (row) => row.toJSON());
    if (!records.length && table.schema.fields.length) {
      return [
        {
          name: filename.replace(/\.[^.]+$/, "").replace(/\W/g, "_") || "daten",
          columns: table.schema.fields.map((field) => ({
            name: field.name,
            type: "TEXT",
          })),
          rows: [],
        },
      ];
    }
  }
  return importJson(
    new TextEncoder().encode(jsonText(records)),
    filename.replace(/\.[^.]+$/, ".json"),
  );
}
