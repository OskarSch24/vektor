import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  jsonText,
  type SourceDocument,
} from "../../services/importers/documents";

export function DocumentView({ document }: { document: SourceDocument }) {
  const [mode, setMode] = useState("tree");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState({
    path: "/",
    value: document.value,
  });
  const [copied, setCopied] = useState(false);
  const matches = useMemo(() => {
    if (!search.trim()) return [];
    const found: { path: string; value: unknown }[] = [];
    const pending = [{ path: "", value: document.value }];
    const seen = new Set<object>();
    while (pending.length && found.length < 200) {
      const item = pending.pop()!;
      if (
        item.path.toLowerCase().includes(search.toLowerCase()) ||
        (typeof item.value !== "object" &&
          String(item.value).toLowerCase().includes(search.toLowerCase()))
      )
        found.push(item);
      if (
        item.value &&
        typeof item.value === "object" &&
        !seen.has(item.value)
      ) {
        seen.add(item.value);
        for (const [key, value] of Object.entries(item.value).reverse())
          pending.push({ path: `${item.path}/${escapePointer(key)}`, value });
      }
    }
    return found;
  }, [document, search]);
  return (
    <div className="dv-document">
      <div className="dv-controls">
        <input
          aria-label="Dokument durchsuchen"
          placeholder="Schlüssel, Wert oder Pfad suchen…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Dokumentdarstellung"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="tree">Struktur</option>
          <option value="raw">
            Original · {document.format.toUpperCase()}
          </option>
        </select>
      </div>
      {mode === "raw" ? (
        <pre className="dv-raw">{document.text}</pre>
      ) : (
        <div className="dv-document-columns">
          <div className="dv-tree" role="tree" aria-label="Dokumentstruktur">
            {search ? (
              <>
                {matches.length === 200 && (
                  <p className="dv-note">Erste 200 Treffer</p>
                )}
                {matches.map((item) => (
                  <button
                    key={item.path}
                    className="dv-search-result"
                    onClick={() => setSelected(item)}
                  >
                    <code>{item.path || "/"}</code>
                    <span>{preview(item.value)}</span>
                  </button>
                ))}
                {!matches.length && <p className="dv-note">Keine Treffer.</p>}
              </>
            ) : (
              <TreeNode
                name="$"
                value={document.value}
                path=""
                depth={0}
                ancestors={[]}
                onSelect={setSelected}
              />
            )}
          </div>
          <div className="dv-document-detail">
            <div className="dv-controls">
              <code className="dv-path">{selected.path || "/"}</code>
              <button
                aria-label="Wert kopieren"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(jsonText(selected.value))
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                }}
              >
                <Copy size={13} />
                {copied ? "Kopiert" : "Kopieren"}
              </button>
            </div>
            <pre className="dv-raw">{jsonText(selected.value)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");
function preview(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array · ${value.length} Elemente`;
  if (typeof value === "object")
    return `Objekt · ${Object.keys(value).length} Felder`;
  return String(value).slice(0, 160);
}
function TreeNode({
  name,
  value,
  path,
  depth,
  ancestors,
  onSelect,
}: {
  name: string;
  value: unknown;
  path: string;
  depth: number;
  ancestors: object[];
  onSelect: (item: { path: string; value: unknown }) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [limit, setLimit] = useState(100);
  const object = value !== null && typeof value === "object";
  const circular = object && ancestors.includes(value as object);
  const entries = object && !circular ? Object.entries(value) : [];
  return (
    <div role="treeitem" aria-expanded={object ? open : undefined}>
      <div
        className="dv-tree-row"
        style={{ paddingLeft: Math.min(depth, 20) * 16 + 8 }}
      >
        <button
          aria-label={`${open ? "Schließen" : "Aufklappen"} ${name}`}
          disabled={!object || circular}
          onClick={() => setOpen(!open)}
        >
          {object && !circular ? (
            open ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span className="dv-dot" />
          )}
        </button>
        <button
          className="dv-tree-value"
          onClick={() => onSelect({ path, value })}
        >
          <strong>{name}</strong>
          <span className={object ? "" : `dv-type-${typeof value}`}>
            {circular ? "Zyklischer Verweis" : preview(value)}
          </span>
        </button>
      </div>
      {open &&
        entries
          .slice(0, limit)
          .map(([key, child]) => (
            <TreeNode
              key={key}
              name={key}
              value={child}
              path={`${path}/${escapePointer(key)}`}
              depth={depth + 1}
              ancestors={[...ancestors, value as object]}
              onSelect={onSelect}
            />
          ))}
      {open && entries.length > limit && (
        <button className="dv-more" onClick={() => setLimit(limit + 100)}>
          Weitere 100 anzeigen ({entries.length - limit} verbleibend)
        </button>
      )}
    </div>
  );
}
