import { useMemo, useState } from "react";
import type { DatabaseMetadata } from "../../types/sqlite";
import {
  display,
  pivot,
  profile,
  type Dataset,
} from "../../services/dataViews";
import { Field, Grid, Empty } from "./common";

export function RecordView({ data }: { data: Dataset }) {
  const [rowIndex, setRowIndex] = useState(0);
  const index = Math.min(rowIndex, Math.max(0, data.values.length - 1));
  const row = data.values[index];
  if (!row) return <Empty>Keine Datensätze.</Empty>;
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <button disabled={index === 0} onClick={() => setRowIndex(index - 1)}>
          ← Vorheriger
        </button>
        <span>
          Datensatz {index + 1} / {data.values.length}
        </span>
        <button
          disabled={index === data.values.length - 1}
          onClick={() => setRowIndex(index + 1)}
        >
          Nächster →
        </button>
      </div>
      <dl className="dv-record">
        {data.columns.map((column, i) => (
          <div key={column}>
            <dt>{column}</dt>
            <dd>{display(row[i])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
export function PivotView({ data }: { data: Dataset }) {
  const [group, setGroup] = useState(0),
    [category, setCategory] = useState(-1),
    [value, setValue] = useState(Math.min(1, data.columns.length - 1));
  const [operation, setOperation] = useState<"count" | "sum" | "avg">("count");
  const result = useMemo(
    () => pivot(data.values, group, category, value, operation),
    [data, group, category, value, operation],
  );
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <Field
          label="Zeilengruppe"
          columns={data.columns}
          value={group}
          onChange={setGroup}
        />
        <Field
          label="Spaltengruppe"
          columns={data.columns}
          value={category}
          onChange={setCategory}
          optional
        />
        <Field
          label="Wertspalte"
          columns={data.columns}
          value={value}
          onChange={setValue}
        />
        <label>
          Berechnung
          <select
            aria-label="Berechnung"
            value={operation}
            onChange={(e) => setOperation(e.target.value as typeof operation)}
          >
            <option value="count">Anzahl</option>
            <option value="sum">Summe</option>
            <option value="avg">Durchschnitt</option>
          </select>
        </label>
      </div>
      <Grid
        columns={[data.columns[group], ...result.categories.slice(0, 100)]}
        rows={result.rows.map((row) => [
          row.group,
          ...row.values.slice(0, 100),
        ])}
      />
      {(result.totalCategories > 100 || result.totalGroups > 500) && (
        <p className="dv-note">
          Angezeigt: {result.rows.length} von {result.totalGroups} Zeilengruppen
          und {result.categories.length} von {result.totalCategories}{" "}
          Spaltengruppen. Werte der angezeigten Gruppen werden über alle
          geladenen Zeilen berechnet.
        </p>
      )}
    </div>
  );
}
export function QualityView({ data }: { data: Dataset }) {
  const result = useMemo(() => profile(data), [data]);
  const duplicates =
    data.values.length -
    new Set(data.values.map((row) => JSON.stringify(row))).size;
  return (
    <div className="dv-pane">
      <div className="dv-summary">
        <strong>{data.values.length.toLocaleString("de-DE")}</strong> geprüfte
        Zeilen <strong>{duplicates}</strong> vollständig doppelte Zeilen
      </div>
      <Grid
        columns={[
          "Spalte",
          "Leer",
          "Unterschiedlich",
          "Wiederholungen",
          "Zahlen",
          "Minimum",
          "Maximum",
          "Mittelwert",
          "Ausreißer",
        ]}
        rows={result.map((p) => [
          p.column,
          p.missing,
          p.distinct,
          p.repeated,
          p.numeric,
          p.min,
          p.max,
          p.mean,
          p.outliers,
        ])}
      />
      <p className="dv-note">
        Leer = NULL oder leerer Text. Wiederholungen beziehen sich auf einzelne
        Spalten. Ausreißer: außerhalb des 1,5-fachen Interquartilsabstands; ein
        Hinweis, kein Fehlernachweis.
      </p>
    </div>
  );
}
export function ERView({
  metadata,
  onSelect,
}: {
  metadata: DatabaseMetadata;
  onSelect: (name: string) => void;
}) {
  const tables = metadata.tables;
  const columns = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  const positions = new Map(
    tables.map((table, i) => [
      table.name,
      { x: 40 + (i % columns) * 300, y: 50 + Math.floor(i / columns) * 230 },
    ]),
  );
  const links = tables.flatMap((table) =>
    table.foreignKeys.map((fk) => ({ sourceName: table.name, ...fk })),
  );
  return (
    <div className="dv-pane">
      <p className="dv-note">
        {tables.length} Tabellen und Views · {links.length} Fremdschlüssel.
        Tabelle anklicken zum Öffnen.
      </p>
      <div className="dv-er-scroll">
        <svg
          width={columns * 300 + 40}
          height={Math.ceil(tables.length / columns) * 230 + 50}
          role="img"
          aria-label="Tabellen-Beziehungsdiagramm"
        >
          {links.map((link, i) => {
            const a = positions.get(link.sourceName),
              b = positions.get(link.table);
            if (!a || !b) return null;
            return (
              <g key={i}>
                <path
                  d={
                    link.sourceName === link.table
                      ? `M${a.x + 240},${a.y + 35} c80,-70 80,140 0,80`
                      : `M${a.x + 240},${a.y + 55} C${a.x + 280},${a.y + 55} ${b.x - 40},${b.y + 55} ${b.x},${b.y + 55}`
                  }
                  stroke="#689baf"
                  fill="none"
                />
                <title>
                  {link.sourceName}.{link.from} → {link.table}.{link.to}
                </title>
              </g>
            );
          })}
          {tables.map((table) => {
            const p = positions.get(table.name)!;
            return (
              <g
                key={table.name}
                transform={`translate(${p.x},${p.y})`}
                onClick={() => onSelect(table.name)}
                tabIndex={0}
                role="button"
                aria-label={`Tabelle ${table.name} öffnen`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(table.name);
                }}
                className="dv-er-table"
              >
                <rect
                  width={240}
                  height={180}
                  rx={6}
                  fill="#20262b"
                  stroke="#45535d"
                />
                <text x={14} y={25} fill="#dbe7ed" fontWeight={600}>
                  {table.name.slice(0, 28)}
                </text>
                <line x1={0} x2={240} y1={38} y2={38} stroke="#45535d" />
                {table.columns.slice(0, 6).map((column, i) => (
                  <text
                    key={column.name}
                    x={14}
                    y={60 + i * 18}
                    fill={column.pk ? "#d6b677" : "#9eacb5"}
                  >
                    {column.pk ? "◆ " : ""}
                    {column.name.slice(0, 21)}{" "}
                    <tspan fill="#6c818e">{column.type}</tspan>
                  </text>
                ))}
                {table.columns.length > 6 && (
                  <text x={14} y={169} fill="#748994">
                    + {table.columns.length - 6} weitere Spalten
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
