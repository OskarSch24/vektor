export type Row = unknown[];
export interface Dataset {
  columns: string[];
  values: Row[];
  totalCount: number;
  error?: string;
}
export function display(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Uint8Array) return `${value.length} Bytes`;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function numberValue(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  )
    return null;
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}
export function dateValue(value: unknown): Date | null {
  if (typeof value === "number")
    return value >= 1e11 && Number.isFinite(new Date(value).getTime())
      ? new Date(value)
      : null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d(?:[T ]|$)/.test(value))
    return null;
  const date = new Date(value);
  const calendarDay = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (
    !Number.isFinite(calendarDay.getTime()) ||
    calendarDay.toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    return null;
  return Number.isFinite(date.getTime()) ? date : null;
}
export function vectorValue(value: unknown): number[] | null {
  try {
    const a = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(a) &&
      a.length > 0 &&
      a.length <= 4096 &&
      a.every((v) => typeof v === "number" && Number.isFinite(v))
      ? a
      : null;
  } catch {
    return null;
  }
}
export function cosine(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : null;
}
export function histogram(values: unknown[], binCount = 12) {
  const nums = values.map(numberValue).filter((n): n is number => n !== null);
  if (!nums.length) return [];
  let min = Infinity,
    max = -Infinity;
  for (const n of nums) {
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  const count = min === max ? 1 : Math.max(1, Math.min(50, binCount));
  const width = (max - min) / count || 1;
  const bins = Array.from({ length: count }, (_, i) => ({
    from: min + i * width,
    to: min === max ? max : min + (i + 1) * width,
    count: 0,
  }));
  for (const n of nums)
    bins[Math.min(count - 1, Math.floor((n - min) / width))].count++;
  return bins;
}
export function pivot(
  rows: Row[],
  groupIndex: number,
  categoryIndex: number,
  valueIndex: number,
  operation: "count" | "sum" | "avg",
) {
  const groups = new Map<
    string,
    Map<string, { total: number; count: number }>
  >();
  const categories = new Set<string>();
  const allGroups = new Set<string>();
  const allCategories = new Set<string>();
  for (const row of rows) {
    const group = display(row[groupIndex]),
      category = categoryIndex < 0 ? "Gesamt" : display(row[categoryIndex]);
    allGroups.add(group);
    allCategories.add(category);
    // Bound the displayed matrix before materializing it: distinct keys on
    // both axes otherwise turn a small input into billions of empty cells.
    if (!categories.has(category) && categories.size >= 100) continue;
    categories.add(category);
    if (!groups.has(group)) {
      if (groups.size >= 500) continue;
      groups.set(group, new Map());
    }
    const cells = groups.get(group)!;
    const cell = cells.get(category) ?? { total: 0, count: 0 };
    const number = numberValue(row[valueIndex]);
    if (operation === "count" || number !== null) {
      cell.count++;
      cell.total += operation === "count" ? 1 : number!;
    }
    cells.set(category, cell);
  }
  return {
    totalGroups: allGroups.size,
    totalCategories: allCategories.size,
    categories: [...categories],
    rows: [...groups].map(([group, cells]) => ({
      group,
      values: [...categories].map((category) => {
        const cell = cells.get(category);
        return !cell || !cell.count
          ? operation === "avg"
            ? null
            : 0
          : operation === "avg"
            ? cell.total / cell.count
            : cell.total;
      }),
    })),
  };
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(v instanceof Uint8Array)
    )
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, v[k]]),
      );
    return v;
  }) ?? "undefined";
export function compareDatasets(before: Dataset, after: Dataset, key: string) {
  const index = (data: Dataset) => {
    const keyIndex = data.columns.indexOf(key);
    if (keyIndex < 0)
      throw new Error(`Schlüsselspalte „${key}“ fehlt in einer Quelle.`);
    const result = new Map<string, Record<string, unknown>>();
    for (const row of data.values) {
      if (row[keyIndex] === null || row[keyIndex] === undefined)
        throw new Error("Die Schlüsselspalte enthält leere Werte.");
      const id = canonical(row[keyIndex]);
      if (result.has(id))
        throw new Error(
          "Die Schlüsselspalte ist nicht eindeutig. Bitte einen eindeutigen Schlüssel wählen.",
        );
      result.set(
        id,
        Object.fromEntries(data.columns.map((column, i) => [column, row[i]])),
      );
    }
    return result;
  };
  const a = index(before),
    b = index(after);
  return [...new Set([...a.keys(), ...b.keys()])].flatMap((id) => {
    const old = a.get(id),
      next = b.get(id);
    if (old && next && canonical(old) === canonical(next)) return [];
    return [
      {
        key: id,
        status: !old ? "Neu" : !next ? "Gelöscht" : "Geändert",
        before: old,
        after: next,
      },
    ];
  });
}
export function profile(data: Dataset) {
  return data.columns.map((column, index) => {
    const values = data.values.map((row) => row[index]);
    const present = values.filter(
      (v) => v !== null && v !== undefined && v !== "",
    );
    const distinct = new Set(present.map(canonical)).size;
    const numbers = present
      .map(numberValue)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    const q = (p: number) => numbers[Math.floor((numbers.length - 1) * p)] ?? 0;
    const spread = q(0.75) - q(0.25);
    return {
      column,
      missing: values.length - present.length,
      distinct,
      repeated: present.length - distinct,
      numeric: numbers.length,
      min: numbers[0],
      max: numbers[numbers.length - 1],
      mean: numbers.length
        ? numbers.reduce((a, b) => a + b, 0) / numbers.length
        : null,
      outliers: numbers.filter(
        (n) => n < q(0.25) - 1.5 * spread || n > q(0.75) + 1.5 * spread,
      ).length,
    };
  });
}
