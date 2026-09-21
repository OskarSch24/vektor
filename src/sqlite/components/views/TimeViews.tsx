import { useMemo, useState } from "react";
import { dateValue, display, type Dataset } from "../../services/dataViews";
import { Empty, Field } from "./common";

export function TimeView({
  data,
  calendar = false,
}: {
  data: Dataset;
  calendar?: boolean;
}) {
  const [dateColumn, setDateColumn] = useState(
    Math.max(
      0,
      data.columns.findIndex((_, i) =>
        data.values.some((row) => dateValue(row[i])),
      ),
    ),
  );
  const [titleColumn, setTitleColumn] = useState(0);
  const items = useMemo(
    () =>
      data.values
        .flatMap((row, i) => {
          const date = dateValue(row[dateColumn]);
          return date
            ? [{ date, title: display(row[titleColumn]), row: i }]
            : [];
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
    [data, dateColumn, titleColumn],
  );
  const [chosenMonth, setChosenMonth] = useState("");
  const month =
    chosenMonth ||
    items[0]?.date.toISOString().slice(0, 7) ||
    new Date().toISOString().slice(0, 7);
  const first = new Date(`${month}-01T00:00:00Z`);
  const days = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const start = (first.getUTCDay() + 6) % 7;
  const dayGroups = new Map<string, typeof items>();
  for (const item of items) {
    const day = item.date.toISOString().slice(0, 10);
    if (!dayGroups.has(day)) dayGroups.set(day, []);
    dayGroups.get(day)!.push(item);
  }
  const shiftMonth = (delta: number) =>
    setChosenMonth(
      new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + delta, 1))
        .toISOString()
        .slice(0, 7),
    );
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <Field
          label="Datumsspalte"
          columns={data.columns}
          value={dateColumn}
          onChange={(v) => {
            setDateColumn(v);
            setChosenMonth("");
          }}
        />
        <Field
          label="Beschriftung"
          columns={data.columns}
          value={titleColumn}
          onChange={setTitleColumn}
        />
        {calendar && (
          <>
            <button
              aria-label="Vorheriger Monat"
              onClick={() => shiftMonth(-1)}
            >
              ←
            </button>
            <input
              aria-label="Monat"
              type="month"
              value={month}
              onChange={(e) => {
                if (e.target.value) setChosenMonth(e.target.value);
              }}
            />
            <button aria-label="Nächster Monat" onClick={() => shiftMonth(1)}>
              →
            </button>
          </>
        )}
      </div>
      <p className="dv-note">
        {items.length} gültige Zeitstempel · {data.values.length - items.length}{" "}
        ohne gültiges ISO-Datum. Anzeige in UTC.
      </p>
      {!items.length ? (
        <Empty>
          Eine Spalte mit ISO-Datum auswählen, zum Beispiel 2026-09-13.
        </Empty>
      ) : calendar ? (
        <div className="dv-calendar">
          {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((day) => (
            <strong key={day}>{day}</strong>
          ))}
          {Array.from({ length: start }, (_, i) => (
            <div className="dv-calendar-blank" key={`blank${i}`} />
          ))}
          {Array.from({ length: days }, (_, i) => {
            const date = `${month}-${String(i + 1).padStart(2, "0")}`;
            return (
              <div className="dv-day" key={date}>
                <time>{i + 1}</time>
                {(dayGroups.get(date) ?? []).slice(0, 20).map((item) => (
                  <div
                    className="dv-event"
                    key={item.row}
                    title={`${item.title} · ${item.date.toISOString()}`}
                  >
                    {item.title}
                  </div>
                ))}
                {(dayGroups.get(date)?.length ?? 0) > 20 && (
                  <p className="dv-note">
                    + {dayGroups.get(date)!.length - 20} weitere Ereignisse
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <ol className="dv-timeline">
          {items.slice(0, 1000).map((item) => (
            <li key={item.row}>
              <time>
                {item.date
                  .toISOString()
                  .replace("T", " ")
                  .replace(".000Z", " UTC")}
              </time>
              <span>{item.title}</span>
            </li>
          ))}
          {items.length > 1000 && <li>Erste 1.000 Ereignisse.</li>}
        </ol>
      )}
    </div>
  );
}
export function KanbanView({ data }: { data: Dataset }) {
  const [group, setGroup] = useState(
    Math.max(
      0,
      data.columns.findIndex((name) => /status|state|kategorie/i.test(name)),
    ),
  );
  const [title, setTitle] = useState(0);
  const groups = useMemo(() => {
    const result = new Map<string, number[]>();
    data.values.forEach((row, i) => {
      const key = display(row[group]);
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push(i);
    });
    return [...result];
  }, [data, group]);
  return (
    <div className="dv-pane">
      <div className="dv-controls">
        <Field
          label="Gruppieren nach"
          columns={data.columns}
          value={group}
          onChange={setGroup}
        />
        <Field
          label="Kartentitel"
          columns={data.columns}
          value={title}
          onChange={setTitle}
        />
      </div>
      <div className="dv-kanban">
        {groups.slice(0, 50).map(([key, indices]) => (
          <section key={key}>
            <h3>
              {key}
              <span>{indices.length}</span>
            </h3>
            {indices.slice(0, 200).map((i) => (
              <article key={i}>
                <strong>{display(data.values[i][title])}</strong>
                {data.columns.map((column, j) =>
                  j !== group && j !== title ? (
                    <p key={column}>
                      <span>{column}</span>
                      {display(data.values[i][j]).slice(0, 100)}
                    </p>
                  ) : null,
                )}
              </article>
            ))}
            {indices.length > 200 && (
              <p className="dv-note">Erste 200 Karten.</p>
            )}
          </section>
        ))}
      </div>
      {groups.length > 50 && (
        <p className="dv-note">Erste 50 von {groups.length} Gruppen.</p>
      )}
    </div>
  );
}
