import React, { useMemo } from 'react';
import { Activity, GitBranch, Layers, Link2, Share2, Unlink } from 'lucide-react';
import { GraphEdge, GraphNode } from '../types/graph';
import { formatCount, labelColor, nodeTitle } from '../lib/graph';

interface StatsViewerProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Numbers about the graph itself, computed on the fly. Two of them are worth
 * more than the rest: the degree distribution — which says whether the graph
 * has real structure or is a star around a single page — and the count of
 * isolated nodes, which is the usual sign that an extraction produced entities
 * it could not connect to anything.
 */
export const StatsViewer: React.FC<StatsViewerProps> = ({ nodes, edges }) => {
  const stats = useMemo(() => {
    const degree = new Map<string, number>();
    for (const node of nodes) degree.set(node.id, 0);
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    const degrees = [...degree.values()];
    const isolated = degrees.filter((value) => value === 0).length;
    const average = degrees.length > 0 ? degrees.reduce((a, b) => a + b, 0) / degrees.length : 0;

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const hubs = [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .flatMap(([id, value]) => {
        const node = nodeById.get(id);
        return node && value > 0 ? [{ node, degree: value }] : [];
      });

    // The number of connected components tells you whether the graph is one
    // body of knowledge or several unrelated ones that happen to share a file.
    const adjacency = new Map<string, string[]>();
    const connect = (from: string, to: string) => {
      const existing = adjacency.get(from);
      if (existing) existing.push(to);
      else adjacency.set(from, [to]);
    };
    for (const edge of edges) {
      connect(edge.from, edge.to);
      connect(edge.to, edge.from);
    }

    const seen = new Set<string>();
    let components = 0;
    let largestComponent = 0;

    for (const node of nodes) {
      if (seen.has(node.id)) continue;
      components += 1;
      let size = 0;
      // Iterative flood fill — a recursive one overflows the stack on a graph
      // with a few thousand connected nodes.
      const stack = [node.id];
      seen.add(node.id);
      while (stack.length > 0) {
        const current = stack.pop()!;
        size += 1;
        for (const neighbour of adjacency.get(current) ?? []) {
          if (seen.has(neighbour)) continue;
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
      largestComponent = Math.max(largestComponent, size);
    }

    const density =
      nodes.length > 1 ? (2 * edges.length) / (nodes.length * (nodes.length - 1)) : 0;

    return { isolated, average, hubs, components, largestComponent, density };
  }, [nodes, edges]);

  const buckets = useMemo(() => {
    const degree = new Map<string, number>();
    for (const node of nodes) degree.set(node.id, 0);
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    const ranges = [
      { label: '0', test: (d: number) => d === 0 },
      { label: '1', test: (d: number) => d === 1 },
      { label: '2–3', test: (d: number) => d >= 2 && d <= 3 },
      { label: '4–7', test: (d: number) => d >= 4 && d <= 7 },
      { label: '8–15', test: (d: number) => d >= 8 && d <= 15 },
      { label: '16+', test: (d: number) => d >= 16 },
    ];

    const values = [...degree.values()];
    const counts = ranges.map((range) => ({
      label: range.label,
      count: values.filter((value) => range.test(value)).length,
    }));
    const max = Math.max(1, ...counts.map((entry) => entry.count));
    return { counts, max };
  }, [nodes, edges]);

  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-apple-text-muted">Noch keine Daten für Statistiken.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-5">
      <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={<Share2 className="w-3.5 h-3.5" />} label="Knoten" value={formatCount(nodes.length)} tone="blue" />
        <StatCard icon={<Link2 className="w-3.5 h-3.5" />} label="Kanten" value={formatCount(edges.length)} tone="purple" />
        <StatCard
          icon={<Activity className="w-3.5 h-3.5" />}
          label="Ø Grad"
          value={stats.average.toFixed(2)}
          tone="cyan"
        />
        <StatCard
          icon={<Layers className="w-3.5 h-3.5" />}
          label="Komponenten"
          value={formatCount(stats.components)}
          tone="green"
        />
        <StatCard
          icon={<GitBranch className="w-3.5 h-3.5" />}
          label="Größte Komponente"
          value={formatCount(stats.largestComponent)}
          tone="amber"
        />
        <StatCard
          icon={<Unlink className="w-3.5 h-3.5" />}
          label="Isolierte Knoten"
          value={formatCount(stats.isolated)}
          tone={stats.isolated > nodes.length * 0.3 ? 'red' : 'green'}
        />
      </div>

      <section className="glass-card rounded-xl p-4">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary select-none">
          Gradverteilung
        </h2>
        <div className="space-y-1.5">
          {buckets.counts.map((bucket) => (
            <div key={bucket.label} className="flex items-center gap-2.5">
              <span className="w-10 shrink-0 text-[11px] font-mono text-apple-text-tertiary text-right tabular-nums">
                {bucket.label}
              </span>
              <div className="flex-1 h-4 rounded bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full bg-apple-blue/70 rounded transition-[width] duration-500"
                  style={{ width: `${(bucket.count / buckets.max) * 100}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-[11px] font-mono text-apple-text-secondary tabular-nums">
                {formatCount(bucket.count)}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-apple-text-muted">
          Dichte {(stats.density * 100).toFixed(3)} % — Anteil der tatsächlich vorhandenen an allen
          möglichen Verbindungen.
        </p>
      </section>

      <section className="glass-card rounded-xl p-4">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-apple-text-tertiary select-none">
          Am stärksten vernetzt
        </h2>
        <div className="space-y-1">
          {stats.hubs.map((entry) => (
            <div key={entry.node.id} className="flex items-center gap-2.5">
              <span
                className="w-2 h-2 rounded-full shrink-0 ring-1 ring-inset ring-black/40"
                style={{ backgroundColor: labelColor(entry.node.labels[0] ?? 'Node') }}
              />
              <span className="flex-1 text-xs text-apple-text-primary truncate">
                {nodeTitle(entry.node)}
              </span>
              <span className="text-[10px] text-apple-text-muted shrink-0">
                {entry.node.labels[0]}
              </span>
              <span className="w-8 text-right text-[11px] font-mono text-apple-text-secondary tabular-nums">
                {entry.degree}
              </span>
            </div>
          ))}
          {stats.hubs.length === 0 && (
            <p className="text-[11px] text-apple-text-muted">Keine verbundenen Knoten.</p>
          )}
        </div>
      </section>
    </div>
  );
};

const TONES = {
  blue: 'text-apple-blue bg-apple-blue/10 border-apple-blue/25',
  purple: 'text-apple-purple bg-apple-purple/10 border-apple-purple/25',
  green: 'text-apple-green bg-apple-green/10 border-apple-green/25',
  amber: 'text-apple-amber bg-apple-amber/10 border-apple-amber/25',
  cyan: 'text-apple-cyan bg-apple-cyan/10 border-apple-cyan/25',
  red: 'text-apple-red bg-apple-red/10 border-apple-red/25',
} as const;

const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: keyof typeof TONES;
}> = ({ icon, label, value, tone }) => (
  <div className="glass-card rounded-xl p-3">
    <div className={`w-7 h-7 rounded-lg border flex items-center justify-center mb-2 ${TONES[tone]}`}>
      {icon}
    </div>
    <p className="text-lg font-semibold text-apple-text-primary tabular-nums leading-none">{value}</p>
    <p className="mt-1 text-[11px] text-apple-text-tertiary">{label}</p>
  </div>
);
