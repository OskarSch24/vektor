import { parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { importJson } from "./json";
import type { ImportedTable } from "./tables";

export interface SourceDocument {
  format: string;
  text: string;
  value: unknown;
}

export function parseSourceDocument(
  bytes: Uint8Array,
  filename: string,
): SourceDocument | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (
    ![
      "json",
      "jsonl",
      "ndjson",
      "yaml",
      "yml",
      "toml",
      "xml",
      "geojson",
    ].includes(ext ?? "")
  )
    return null;
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  let value: unknown;
  if (ext === "yaml" || ext === "yml") {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    value = doc.toJS({ maxAliasCount: 100 });
  } else if (ext === "toml") value = parseToml(text);
  else if (ext === "xml") {
    const valid = XMLValidator.validate(text);
    if (valid !== true)
      throw new Error(`XML: ${valid.err.msg} (Zeile ${valid.err.line})`);
    value = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      // Accept DOCTYPE metadata without resolving DTDs or expanding entities.
      // The parser rejects external entity declarations itself.
      processEntities: false,
    }).parse(text);
  } else if (ext === "jsonl" || ext === "ndjson") {
    value = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`Ungültiges JSON in Zeile ${i + 1}.`);
        }
      });
  } else value = JSON.parse(text);
  return { text, value, format: ext === "yml" ? "yaml" : ext! };
}

export function jsonText(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) ?? "null"
  );
}

export function documentTables(
  document: SourceDocument,
  filename: string,
): ImportedTable[] {
  return importJson(
    new TextEncoder().encode(jsonText(document.value)),
    filename.replace(/\.[^.]+$/, ".json"),
  );
}
