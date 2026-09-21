import { useMemo, useState } from "react";
import { feature } from "topojson-client";
import { geoEquirectangular, geoPath } from "d3-geo";
import world from "world-atlas/land-110m.json";
import type { Topology, GeometryCollection } from "topojson-specification";
import {
  cosine,
  display,
  numberValue,
  vectorValue,
  type Dataset,
} from "../../services/dataViews";
import type { SourceDocument } from "../../services/importers/documents";
import { Empty, Field, Grid } from "./common";

const topology = world as unknown as Topology<{ land: GeometryCollection }>;
const land = feature(topology, topology.objects.land);
const point = ([lon, lat]: number[]) => [
  500 + (lon / 180) * 500,
  250 - (lat / 90) * 250,
];
function geometryPath(geometry: any): string {
  if (!geometry || !Array.isArray(geometry.coordinates)) return "";
  const line = (coordinates: number[][], close: boolean) =>
    !Array.isArray(coordinates) || !coordinates.every(validPosition)
      ? ""
      : coordinates
          .map((p, i) => `${i ? "L" : "M"}${point(p).join(",")}`)
          .join(" ") + (close ? "Z" : "");
  if (geometry.type === "Polygon")
    return geometry.coordinates.map((c: number[][]) => line(c, true)).join(" ");
  if (geometry.type === "MultiPolygon")
    return geometry.coordinates
      .flatMap((polygon: number[][][]) =>
        Array.isArray(polygon) ? polygon.map((c) => line(c, true)) : [],
      )
      .join(" ");
  if (geometry.type === "LineString") return line(geometry.coordinates, false);
  if (geometry.type === "MultiLineString")
    return geometry.coordinates
      .map((c: number[][]) => line(c, false))
      .join(" ");
  return "";
}
const landPath =
  geoPath(
    geoEquirectangular()
      .scale(1000 / (2 * Math.PI))
      .translate([500, 250]),
  )(land) ?? "";
function validPosition(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}
export function MapView({
  data,
  document,
}: {
  data: Dataset;
  document: SourceDocument | null;
}) {
  const [latitude, setLatitude] = useState(
    data.columns.findIndex((c) => /^(lat|latitude|breitengrad)$/i.test(c)),
  );
  const [longitude, setLongitude] = useState(
    data.columns.findIndex((c) => /^(lon|lng|longitude|längengrad)$/i.test(c)),
  );
  const [label, setLabel] = useState(0),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const doc = document?.value as any;
  const sourceFeatures =
    doc?.type === "FeatureCollection" && Array.isArray(doc.features)
      ? doc.features
      : doc?.type === "Feature"
        ? [doc]
        : doc?.type && doc?.coordinates
          ? [{ geometry: doc, properties: {} }]
          : [];
  const features = sourceFeatures
    .filter((f: any) => f && typeof f === "object" && f.geometry)
    .slice(0, 10000);
  const points = data.values.flatMap((row, i) => {
    const lat = numberValue(row[latitude]),
      lon = numberValue(row[longitude]);
    return lat !== null &&
      lon !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
      ? [
          {
            x: point([lon, lat])[0],
            y: point([lon, lat])[1],
            title: display(row[label]),
            id: i,
          },
        ]
      : [];
  });
  const geoPoints = features.flatMap((f: any, i: number) =>
    f.geometry?.type === "Point" && validPosition(f.geometry.coordinates)
      ? [
          {
            x: point(f.geometry.coordinates)[0],
            y: point(f.geometry.coordinates)[1],
            title: display(f.properties?.name ?? f.properties ?? i),
            id: i,
          },
        ]
      : [],
  );
  const shown: { x: number; y: number; title: string; id: number }[] =
    features.length ? geoPoints : points;
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        {!features.length && (
          <>
            <Field
              label="Breitengrad"
              optional
              columns={data.columns}
              value={latitude}
              onChange={setLatitude}
            />
            <Field
              label="Längengrad"
              optional
              columns={data.columns}
              value={longitude}
              onChange={setLongitude}
            />
            <Field
              label="Ortsname"
              columns={data.columns}
              value={label}
              onChange={setLabel}
            />
          </>
        )}
        <button
          aria-label="Karte vergrößern"
          onClick={() => setZoom(Math.min(16, zoom * 1.5))}
        >
          +
        </button>
        <button
          aria-label="Karte verkleinern"
          onClick={() => setZoom(Math.max(1, zoom / 1.5))}
        >
          −
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          Zurücksetzen
        </button>
      </div>
      <svg
        className="dv-map"
        viewBox="0 0 1000 500"
        role="img"
        aria-label="Geografische Karte"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) {
            const bounds = e.currentTarget.getBoundingClientRect();
            setPan((p) => ({
              x: p.x + (e.movementX * 1000) / bounds.width,
              y: p.y + (e.movementY * 500) / bounds.height,
            }));
          }
        }}
      >
        <rect width={1000} height={500} fill="#17232b" />
        <g
          transform={`translate(${500 + pan.x},${250 + pan.y}) scale(${zoom}) translate(-500,-250)`}
        >
          <path
            d={landPath}
            fill="#34434a"
            stroke="#667e87"
            strokeWidth={0.4 / zoom}
          />
          {features.map((f: any, i: number) => (
            <path
              key={i}
              d={geometryPath(f.geometry)}
              fill={/Polygon/.test(f.geometry?.type) ? "#80bccc55" : "none"}
              stroke="#d1b374"
              strokeWidth={1.5 / zoom}
            >
              <title>{display(f.properties)}</title>
            </path>
          ))}
          {shown.map((p) => (
            <circle
              key={p.id}
              cx={p.x}
              cy={p.y}
              r={4 / Math.sqrt(zoom)}
              fill="#b7d7dc"
              stroke="#182328"
              strokeWidth={1 / zoom}
            >
              <title>{p.title}</title>
            </circle>
          ))}
        </g>
      </svg>
      <p className="dv-note">
        {features.length
          ? `${features.length} dargestellte von ${sourceFeatures.length} GeoJSON-Features`
          : `${points.length} gültige Koordinaten · ${data.values.length - points.length} nicht darstellbar`}{" "}
        · Karte durch Ziehen verschieben. Offline-Kartengrundlage: Natural
        Earth.
      </p>
    </div>
  );
}
export function VectorView({ data }: { data: Dataset }) {
  const [column, setColumn] = useState(
    Math.max(
      0,
      data.columns.findIndex((_, i) =>
        data.values.slice(0, 1000).some((row) => vectorValue(row[i])),
      ),
    ),
  );
  const [reference, setReference] = useState(0),
    [x, setX] = useState(0),
    [y, setY] = useState(1);
  const vectors = useMemo(
    () =>
      data.values.slice(0, 1000).flatMap((row, i) => {
        const vector = vectorValue(row[column]);
        return vector ? [{ index: i, vector, title: display(row[0]) }] : [];
      }),
    [data, column],
  );
  const selected = vectors[Math.min(reference, vectors.length - 1)];
  const neighbors = selected
    ? vectors
        .filter((v) => v.index !== selected.index)
        .map((v) => ({ ...v, score: cosine(selected.vector, v.vector) }))
        .filter((v) => v.score !== null)
        .sort((a, b) => b.score! - a.score!)
    : [];
  const same = vectors
    .filter((v) => v.vector.length === selected?.vector.length)
    .slice(0, 1000);
  const dx = Math.min(x, (selected?.vector.length ?? 1) - 1),
    dy = Math.min(y, (selected?.vector.length ?? 1) - 1);
  const xs = same.map((v) => v.vector[dx]),
    ys = same.map((v) => v.vector[dy]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <Field
          label="Vektorspalte"
          columns={data.columns}
          value={column}
          onChange={(v) => {
            setColumn(v);
            setReference(0);
          }}
        />
        {selected && (
          <>
            <Field
              label="Referenz"
              columns={vectors.map((v) => `${v.index + 1} · ${v.title}`)}
              value={Math.min(reference, vectors.length - 1)}
              onChange={setReference}
            />
            <Field
              label="X-Dimension"
              columns={selected.vector.map((_, i) => String(i + 1))}
              value={dx}
              onChange={setX}
            />
            <Field
              label="Y-Dimension"
              columns={selected.vector.map((_, i) => String(i + 1))}
              value={dy}
              onChange={setY}
            />
          </>
        )}
      </div>
      {!selected ? (
        <Empty>
          Eine Spalte mit Zahlenarrays auswählen, zum Beispiel [0.2, 0.8, -0.1].
        </Empty>
      ) : (
        <>
          <svg
            className="dv-vector"
            viewBox="0 0 800 300"
            role="img"
            aria-label="Vektordimensionen"
          >
            <line x1={40} x2={760} y1={270} y2={270} stroke="#45535d" />
            <line x1={40} x2={40} y1={20} y2={270} stroke="#45535d" />
            {same.map((v) => (
              <circle
                key={v.index}
                cx={40 + ((v.vector[dx] - minX) / (maxX - minX || 1)) * 710}
                cy={260 - ((v.vector[dy] - minY) / (maxY - minY || 1)) * 230}
                r={v.index === selected.index ? 6 : 3}
                fill={v.index === selected.index ? "#e2b96e" : "#80b4c8"}
                onClick={() => setReference(vectors.indexOf(v))}
              >
                <title>
                  {v.title} · {v.vector[dx]}, {v.vector[dy]}
                </title>
              </circle>
            ))}
          </svg>
          <p className="dv-note">
            {vectors.length} Vektoren in den ersten{" "}
            {Math.min(1000, data.values.length)} geladenen Zeilen · Referenz mit{" "}
            {selected.vector.length} Dimensionen. Diagramm: zwei gewählte
            Originaldimensionen, bis zu 1.000 Punkte. Rangfolge:
            Kosinusähnlichkeit über alle Dimensionen; ungleiche Dimensionen und
            Nullvektoren werden ausgeschlossen.
          </p>
          <Grid
            columns={["Rang", "Datensatz", "Kosinusähnlichkeit"]}
            rows={neighbors
              .slice(0, 100)
              .map((v, i) => [i + 1, v.title, v.score?.toFixed(6)])}
          />
        </>
      )}
    </div>
  );
}
