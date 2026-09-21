import { useMemo, useState } from "react";
import { compareDatasets, type Dataset } from "../../services/dataViews";
import {
  detectFormat,
  FILE_INPUT_ACCEPT,
  importTables,
  type ImportedTable,
} from "../../services/importers";
import { Field, Empty } from "./common";

export function CompareView({ data }: { data: Dataset }) {
  const [tables, setTables] = useState<ImportedTable[]>([]),
    [otherTable, setOtherTable] = useState(0),
    [filename, setFilename] = useState("");
  const [key, setKey] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const comparison = useMemo(() => {
    const table = tables[otherTable];
    if (!table) return null;
    try {
      return {
        changes: compareDatasets(
          data,
          {
            columns: table.columns.map((c) => c.name),
            values: table.rows,
            totalCount: table.rows.length,
          },
          data.columns[key],
        ),
        error: "",
      };
    } catch (e) {
      return { changes: [], error: String((e as Error).message) };
    }
  }, [data, tables, otherTable, key]);
  async function open(file: File) {
    setLoading(true);
    setError("");
    try {
      const format = detectFormat(file.name);
      if (
        !format ||
        format === "sqlite" ||
        format === "connection" ||
        format === "duckdb"
      )
        throw new Error(
          "Für den Vergleich CSV, JSON, YAML, XML, TOML, Excel, Parquet oder Arrow wählen.",
        );
      const result = await importTables(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        format,
      );
      setTables(result);
      setOtherTable(0);
      setFilename(file.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <Field
          label="Eindeutiger Schlüssel"
          columns={data.columns}
          value={key}
          onChange={setKey}
        />
        <label className="dv-file-button">
          Vergleichsdatei öffnen
          <input
            aria-label="Vergleichsdatei"
            type="file"
            accept={FILE_INPUT_ACCEPT}
            onChange={(e) => {
              if (e.target.files?.[0]) void open(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </label>
        {tables.length > 1 && (
          <Field
            label="Vergleichstabelle"
            columns={tables.map((t) => t.name)}
            value={otherTable}
            onChange={setOtherTable}
          />
        )}
      </div>
      {(error || comparison?.error) && (
        <p role="alert" className="dv-error">
          {error || comparison?.error}
        </p>
      )}
      {loading ? (
        <Empty>Vergleich wird geladen…</Empty>
      ) : !comparison ? (
        <Empty>
          Zweite Datei öffnen. Die aktuelle Tabelle ist der alte Stand, die
          Vergleichsdatei der neue Stand.
        </Empty>
      ) : (
        <>
          <p className="dv-note">
            {filename} · {comparison.changes.length} Unterschiede
            {data.totalCount > data.values.length
              ? " · Vergleich bezieht sich nur auf die geladenen Zeilen der aktuellen Quelle"
              : ""}
          </p>
          {comparison.changes.slice(0, 300).map((change) => (
            <details className="dv-diff" key={change.key}>
              <summary>
                <b data-status={change.status}>{change.status}</b>
                <code>{change.key}</code>
              </summary>
              <div>
                <pre>{JSON.stringify(change.before, null, 2) ?? "—"}</pre>
                <pre>{JSON.stringify(change.after, null, 2) ?? "—"}</pre>
              </div>
            </details>
          ))}
          {!comparison.changes.length && !comparison.error && (
            <Empty>Keine Unterschiede.</Empty>
          )}
          {comparison.changes.length > 300 && (
            <p className="dv-note">Erste 300 Unterschiede.</p>
          )}
        </>
      )}
    </div>
  );
}
