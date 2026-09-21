import { useMemo, useState } from "react";
import {
  display,
  histogram,
  numberValue,
  type Dataset,
} from "../../services/dataViews";
import { Empty, Field } from "./common";

const color = "#83b6c7";
export function ChartView({ data }: { data: Dataset }) {
  const [kind, setKind] = useState("bar");
  const [x, setX] = useState(0);
  const [y, setY] = useState(
    Math.max(
      0,
      data.columns.findIndex((_, i) =>
        data.values.some((row) => numberValue(row[i]) !== null),
      ),
    ),
  );
  const points = useMemo(() => {
    if (kind === "histogram")
      return histogram(data.values.map((row) => row[y])).map((bin, i) => ({
        x: i,
        y: bin.count,
        label: `${bin.from.toPrecision(4)} – ${bin.to.toPrecision(4)}`,
      }));
    return data.values
      .flatMap((row, i) => {
        const n = numberValue(row[y]),
          nx = kind === "scatter" ? numberValue(row[x]) : i;
        return n === null || nx === null
          ? []
          : [{ x: nx, y: n, label: display(row[x]) }];
      })
      .slice(0, 300);
  }, [data, kind, x, y]);
  const maxY = Math.max(0, ...points.map((p) => p.y)),
    minY = Math.min(0, ...points.map((p) => p.y));
  const minX = Math.min(...points.map((p) => p.x)),
    maxX = Math.max(...points.map((p) => p.x));
  const sx = (v: number) => 65 + ((v - minX) / (maxX - minX || 1)) * 810;
  const sy = (v: number) => 360 - ((v - minY) / (maxY - minY || 1)) * 310;
  const width = Math.min(45, 750 / Math.max(1, points.length));
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <label>
          Diagramm
          <select
            aria-label="Diagrammtyp"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="bar">Balken</option>
            <option value="line">Linie</option>
            <option value="scatter">Streudiagramm</option>
            <option value="histogram">Histogramm</option>
          </select>
        </label>
        {kind !== "histogram" && (
          <Field
            label="X-Achse"
            columns={data.columns}
            value={x}
            onChange={setX}
          />
        )}
        <Field
          label={kind === "histogram" ? "Werte" : "Y-Achse"}
          columns={data.columns}
          value={y}
          onChange={setY}
        />
      </div>
      {!points.length ? (
        <Empty>Die ausgewählte Spalte enthält keine passenden Zahlen.</Empty>
      ) : (
        <>
          <svg
            className="dv-chart"
            viewBox="0 0 950 430"
            role="img"
            aria-label={`${kind} aus ${data.columns[y]}`}
          >
            {Array.from(
              { length: 5 },
              (_, i) => minY + (i * (maxY - minY)) / 4,
            ).map((n, i) => (
              <g key={i}>
                <line x1={65} x2={900} y1={sy(n)} y2={sy(n)} stroke="#30363c" />
                <text x={55} y={sy(n) + 4} textAnchor="end">
                  {n.toLocaleString("de-DE", { maximumFractionDigits: 2 })}
                </text>
              </g>
            ))}
            {kind === "line" && (
              <polyline
                points={points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={2}
              />
            )}
            {points.map((p, i) => (
              <g key={i}>
                <title>
                  {p.label}: {p.y}
                </title>
                {kind === "bar" || kind === "histogram" ? (
                  <rect
                    x={sx(p.x) - width / 2}
                    y={Math.min(sy(p.y), sy(0))}
                    width={width}
                    height={Math.max(1, Math.abs(sy(p.y) - sy(0)))}
                    fill={color}
                  />
                ) : (
                  <circle
                    cx={sx(p.x)}
                    cy={sy(p.y)}
                    r={kind === "scatter" ? 4 : 2}
                    fill={color}
                    opacity={0.8}
                  />
                )}
                {i % Math.max(1, Math.ceil(points.length / 8)) === 0 && (
                  <text x={sx(p.x)} y={385} textAnchor="middle">
                    {p.label.slice(0, 16)}
                  </text>
                )}
              </g>
            ))}
            <text x={475} y={419} textAnchor="middle">
              {kind === "histogram" ? data.columns[y] : data.columns[x]}
            </text>
          </svg>
          <p className="dv-note">
            {kind === "histogram"
              ? "Häufigkeiten aller geladenen gültigen Zahlen."
              : "Bis zu 300 gültige Datenpunkte in Zeilenreihenfolge. Für gruppierte Summen die Pivotansicht verwenden."}
          </p>
        </>
      )}
    </div>
  );
}
