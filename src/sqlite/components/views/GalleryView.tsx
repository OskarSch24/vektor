import { useEffect, useState } from "react";
import { files, isNativeHost } from "../../../services/nativeHost";
import { display, type Dataset } from "../../services/dataViews";
import { Field } from "./common";

export function GalleryView({
  data,
  sourcePath,
}: {
  data: Dataset;
  sourcePath?: string | null;
}) {
  const [column, setColumn] = useState(
    Math.max(
      0,
      data.columns.findIndex((c) =>
        /image|bild|url|photo|media|datei|file|blob/i.test(c),
      ),
    ),
  );
  const [title, setTitle] = useState(0);
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <Field
          label="Medienfeld"
          columns={data.columns}
          value={column}
          onChange={setColumn}
        />
        <Field
          label="Titel"
          columns={data.columns}
          value={title}
          onChange={setTitle}
        />
      </div>
      <div className="dv-gallery">
        {data.values.slice(0, 200).map((row, i) => (
          <MediaCard
            key={`${column}:${i}`}
            value={row[column]}
            title={display(row[title])}
            sourcePath={sourcePath}
          />
        ))}
      </div>
      {data.values.length > 200 && <p className="dv-note">Erste 200 Medien.</p>}
    </div>
  );
}
function MediaCard({
  value,
  title,
  sourcePath,
}: {
  value: unknown;
  title: string;
  sourcePath?: string | null;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const text = typeof value === "string" ? value : "";
  let type =
    /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#]|$)/i.test(text) ||
    /^data:image\/(png|jpeg|gif|webp);base64,/.test(text)
      ? "image"
      : /\.(mp4|webm|mov)(?:[?#]|$)/i.test(text)
        ? "video"
        : /\.(mp3|wav|ogg|m4a)(?:[?#]|$)/i.test(text)
          ? "audio"
          : "file";
  if (value instanceof Uint8Array) {
    if (
      (value[0] === 137 && value[1] === 80) ||
      (value[0] === 255 && value[1] === 216) ||
      (value[0] === 71 && value[1] === 73)
    )
      type = "image";
  }
  useEffect(
    () => () => {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    },
    [url],
  );
  async function preview() {
    try {
      if (value instanceof Uint8Array) {
        setUrl(URL.createObjectURL(new Blob([value.slice().buffer])));
        return;
      }
      if (
        /^https?:\/\//i.test(text) ||
        /^data:image\/(png|jpeg|gif|webp);base64,/.test(text)
      ) {
        setUrl(text);
        return;
      }
      if (text && !/^[a-z]+:/i.test(text) && isNativeHost()) {
        const path = text.startsWith("/")
          ? text
          : sourcePath
            ? `${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}/${text}`
            : "";
        if (path) {
          setUrl((await files.stage(path)).url);
          return;
        }
      }
      throw new Error("Kein unterstützter Medienpfad oder HTTP-Link.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <article>
      <div className="dv-media-preview">
        {url ? (
          type === "image" ? (
            <img
              src={url}
              alt={title}
              onError={() => setError("Bild konnte nicht geladen werden.")}
            />
          ) : type === "video" ? (
            <video controls src={url} />
          ) : type === "audio" ? (
            <audio controls src={url} />
          ) : (
            <a href={url} target="_blank" rel="noreferrer">
              Dokument öffnen ↗
            </a>
          )
        ) : (
          <button onClick={() => void preview()}>Vorschau öffnen</button>
        )}
      </div>
      <strong>{title}</strong>
      <p title={display(value)}>{display(value).slice(0, 120)}</p>
      {error && <p className="dv-error">{error}</p>}
    </article>
  );
}
