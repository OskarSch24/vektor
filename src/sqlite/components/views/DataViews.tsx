import { useMemo, useState, type ReactNode } from "react";
import { dbEngine, type TablePage } from "../../services/dbEngine";
import type { DatabaseMetadata } from "../../types/sqlite";
import { DocumentView } from "./DocumentView";
import { ChartView } from "./ChartView";
import { ERView, PivotView, QualityView, RecordView } from "./RelationalViews";
import { KanbanView, TimeView } from "./TimeViews";
import { CompareView } from "./CompareView";
import { MapView, VectorView } from "./SpatialViews";
import { GalleryView } from "./GalleryView";
import { Empty } from "./common";
import "./views.css";

const MODES = [
  ["table", "Tabelle"],
  ["document", "Dokumentstruktur"],
  ["record", "Datensatz"],
  ["er", "Tabellenbeziehungen"],
  ["chart", "Diagramm"],
  ["pivot", "Pivot"],
  ["timeline", "Zeitstrahl"],
  ["calendar", "Kalender"],
  ["kanban", "Kanban"],
  ["map", "Karte"],
  ["gallery", "Galerie"],
  ["compare", "Vergleich"],
  ["quality", "Datenqualität"],
  ["vector", "Vektoren"],
];
export function DataViews({
  metadata,
  tableName,
  schemaVersion,
  sourcePath,
  onSelectTable,
  children,
}: {
  metadata: DatabaseMetadata;
  tableName: string | null;
  schemaVersion: number;
  sourcePath?: string | null;
  onSelectTable: (name: string) => void;
  children: ReactNode;
}) {
  const document = dbEngine.sourceDocument;
  const [mode, setMode] = useState(
    document && !Array.isArray(document.value) ? "document" : "table",
  );
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(10000);
  const documentMap =
    mode === "map" &&
    document?.value &&
    typeof document.value === "object" &&
    "type" in document.value;
  const data = useMemo<TablePage>(() => {
    if (!tableName || mode === "table" || mode === "document" || mode === "er")
      return { columns: [], values: [], totalCount: 0, executionTimeMs: 0 };
    return dbEngine.getTableData(tableName, {
      pageSize: limit,
      searchTerm: documentMap ? "" : search,
    });
  }, [tableName, schemaVersion, mode, search, limit, documentMap]);
  const documentValue = document ?? {
    format: "json",
    value: data.values.map((row) =>
      Object.fromEntries(data.columns.map((column, i) => [column, row[i]])),
    ),
    text: JSON.stringify(data.values),
  };
  const sourceInfo = tableName ? dbEngine.sourceInfo[tableName] : null;
  return (
    <div className="dv-root" data-source-name={metadata.filename}>
      <div className="dv-viewbar">
        <label>
          Ansicht
          <select
            aria-label="Datenansicht"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            {MODES.filter(([id]) => id !== "document" || document).map(
              ([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        <span className="dv-viewbar-source">
          {document?.format.toUpperCase() ?? "DATEN"} ·{" "}
          {tableName ?? metadata.filename}
        </span>
        {!documentMap && !["table", "document", "er"].includes(mode) && (
          <input
            aria-label="Ansicht durchsuchen"
            placeholder="Datensätze filtern…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {sourceInfo && <p className="dv-source-info">{sourceInfo}</p>}
      {data.error ? (
        <p role="alert" className="dv-error">
          {data.error}
        </p>
      ) : (
        <>
          {!documentMap && !["table", "document", "er"].includes(mode) && (
            <div className="dv-scope">
              <span>
                {data.values.length.toLocaleString("de-DE")} /{" "}
                {data.totalCount.toLocaleString("de-DE")} Zeilen
                {data.values.length < data.totalCount
                  ? " · begrenzter Ausschnitt"
                  : ""}
              </span>
              <select
                aria-label="Analyseumfang"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              >
                <option value={1000}>Bis 1.000 Zeilen</option>
                <option value={10000}>Bis 10.000 Zeilen</option>
                <option value={100000}>Bis 100.000 Zeilen</option>
              </select>
            </div>
          )}
          {mode === "table" ? (
            children
          ) : mode === "document" ? (
            <DocumentView
              key={metadata.filename + schemaVersion}
              document={documentValue}
            />
          ) : mode === "er" ? (
            <ERView
              metadata={metadata}
              onSelect={(name) => {
                onSelectTable(name);
                setMode("table");
              }}
            />
          ) : !data.columns.length ? (
            <Empty>Keine Tabelle ausgewählt.</Empty>
          ) : (
            <>
              {mode === "record" && <RecordView data={data} />}
              {mode === "chart" && <ChartView data={data} />}
              {mode === "pivot" && <PivotView data={data} />}
              {mode === "timeline" && <TimeView data={data} />}
              {mode === "calendar" && <TimeView data={data} calendar />}
              {mode === "kanban" && <KanbanView data={data} />}
              {mode === "map" && <MapView data={data} document={document} />}
              {mode === "gallery" && (
                <GalleryView data={data} sourcePath={sourcePath} />
              )}
              {mode === "compare" && <CompareView data={data} />}
              {mode === "quality" && <QualityView data={data} />}
              {mode === "vector" && <VectorView data={data} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
