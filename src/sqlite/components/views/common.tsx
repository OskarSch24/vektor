import type { ReactNode } from "react";
import { display } from "../../services/dataViews";
export function Field({
  label,
  value,
  onChange,
  columns,
  optional = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  columns: string[];
  optional?: boolean;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {optional && <option value={-1}>Keine</option>}
        {columns.map((column, i) => (
          <option key={column} value={i}>
            {column}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="dv-empty">{children}</div>;
}
export function Grid({
  columns,
  rows,
}: {
  columns: string[];
  rows: unknown[][];
}) {
  return (
    <div className="dv-grid-scroll">
      <table className="dv-grid">
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th key={i}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 500).map((row, i) => (
            <tr key={i}>
              {row.map((value, j) => (
                <td key={j} title={display(value)}>
                  {display(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 500 && (
        <p className="dv-note">Erste 500 von {rows.length} Ergebniszeilen.</p>
      )}
    </div>
  );
}
