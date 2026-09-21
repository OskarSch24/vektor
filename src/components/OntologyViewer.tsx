import React from 'react';
import { ArrowRight, Waypoints } from 'lucide-react';
import { GraphSchema } from '../types/graph';
import { formatCount, labelColor } from '../lib/graph';

interface OntologyViewerProps {
  schema: GraphSchema;
}

/**
 * The schema view. A property graph has no declared schema, so this is derived
 * from the data: which labels exist, which properties they carry, and which
 * relationship types connect which labels.
 */
export const OntologyViewer: React.FC<OntologyViewerProps> = ({ schema }) => {
  if (schema.labels.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
        <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-3">
          <Waypoints className="w-5 h-5 text-apple-text-tertiary" />
        </div>
        <p className="text-xs text-apple-text-secondary">Der Graph ist leer.</p>
        <p className="mt-1 text-[11px] text-apple-text-muted">
          Die Ontologie ergibt sich aus den Daten — importiere zuerst etwas.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-6">
      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary select-none">
          Knotentypen
          <span className="ml-1.5 font-mono text-apple-text-muted">{schema.labels.length}</span>
        </h2>

        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {schema.labels.map((entry) => (
            <article key={entry.label} className="glass-card rounded-xl p-3.5">
              <header className="flex items-center gap-2 mb-2.5">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-inset ring-black/40"
                  style={{ backgroundColor: labelColor(entry.label) }}
                />
                <h3 className="flex-1 text-xs font-semibold text-apple-text-primary truncate">
                  {entry.label}
                </h3>
                <span className="text-[11px] font-mono text-apple-text-tertiary tabular-nums">
                  {formatCount(entry.count)}
                </span>
              </header>

              <div className="flex flex-wrap gap-1">
                {entry.propertyKeys.slice(0, 14).map((key) => (
                  <span
                    key={key}
                    className="px-1.5 py-0.5 rounded text-[10px] font-mono text-apple-text-secondary bg-white/[0.05] border border-white/[0.06]"
                  >
                    {key}
                  </span>
                ))}
                {entry.propertyKeys.length > 14 && (
                  <span className="px-1.5 py-0.5 text-[10px] text-apple-text-muted">
                    +{entry.propertyKeys.length - 14}
                  </span>
                )}
                {entry.propertyKeys.length === 0 && (
                  <span className="text-[10px] text-apple-text-muted">keine Eigenschaften</span>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary select-none">
          Beziehungstypen
          <span className="ml-1.5 font-mono text-apple-text-muted">
            {schema.relationshipTypes.length}
          </span>
        </h2>

        <div className="glass-card rounded-xl divide-y divide-white/[0.05] overflow-hidden">
          {schema.relationshipTypes.map((entry) => (
            <div key={entry.type} className="px-3.5 py-3">
              <div className="flex items-baseline gap-2 mb-2">
                <h3 className="text-[11px] font-mono font-semibold text-apple-text-primary">
                  {entry.type}
                </h3>
                <span className="text-[11px] font-mono text-apple-text-tertiary tabular-nums">
                  {formatCount(entry.count)}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {entry.pairs.slice(0, 8).map((pair) => (
                  <span
                    key={`${pair.from}-${pair.to}`}
                    className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[10px]"
                  >
                    <span style={{ color: labelColor(pair.from) }}>{pair.from}</span>
                    <ArrowRight className="w-2.5 h-2.5 text-apple-text-muted" />
                    <span style={{ color: labelColor(pair.to) }}>{pair.to}</span>
                    <span className="font-mono text-apple-text-muted tabular-nums">{pair.count}</span>
                  </span>
                ))}
                {entry.pairs.length > 8 && (
                  <span className="px-1.5 py-0.5 text-[10px] text-apple-text-muted">
                    +{entry.pairs.length - 8} weitere Kombinationen
                  </span>
                )}
              </div>
            </div>
          ))}

          {schema.relationshipTypes.length === 0 && (
            <p className="px-3.5 py-3 text-[11px] text-apple-text-muted">
              Noch keine Beziehungen im Graphen.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary select-none">
          Eigenschaftsschlüssel
          <span className="ml-1.5 font-mono text-apple-text-muted">
            {schema.propertyKeys.length}
          </span>
        </h2>
        <div className="flex flex-wrap gap-1">
          {schema.propertyKeys.map((key) => (
            <span
              key={key}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono text-apple-text-secondary bg-white/[0.05] border border-white/[0.06]"
            >
              {key}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
};
