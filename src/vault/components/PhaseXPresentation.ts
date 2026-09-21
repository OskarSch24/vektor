import type { PhaseXChild, PhaseXEdge, PhaseXNode } from '../services/redis/phaseX';

export type PhaseXDisplayMode = 'hierarchy' | 'graph' | 'json';
export type PhaseXGraphMode = 'structure' | 'all';

export interface PhaseXExplorerSnapshot {
  space: string;
  roots: string[];
  nodes: ReadonlyMap<string, PhaseXNode>;
  children: ReadonlyMap<string, PhaseXChild[]>;
  edges: ReadonlyMap<string, PhaseXEdge[]>;
  parents: ReadonlyMap<string, string>;
  truncatedChildren: ReadonlySet<string>;
  truncatedEdges: ReadonlySet<string>;
}

const TYPE_LABELS: Record<string, string> = {
  document: 'Dokument',
  doc: 'Dokument',
  chapter: 'Kapitel',
  paragraph: 'Abschnitt',
  subparagraph: 'Unterabschnitt',
  chunk: 'Textausschnitt',
  post: 'Beitrag',
  comment: 'Kommentar',
  author: 'Autor',
  person: 'Person',
  organization: 'Organisation',
  source: 'Quelle',
  page: 'Seite',
  topic: 'Thema',
  run: 'Workflow-Lauf',
  workflow: 'Workflow',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'Titel',
  name: 'Name',
  label: 'Bezeichnung',
  text: 'Inhalt',
  content: 'Inhalt',
  body: 'Inhalt',
  description: 'Beschreibung',
  summary: 'Zusammenfassung',
  author: 'Autor',
  created: 'Erstellt',
  created_at: 'Erstellt',
  updated: 'Aktualisiert',
  updated_at: 'Aktualisiert',
  captured_at: 'Erfasst',
  source: 'Quelle',
  source_url: 'Quelladresse',
  url: 'Adresse',
  language: 'Sprache',
  tags: 'Schlagwörter',
  score: 'Bewertung',
};

const RELATION_LABELS: Record<string, string> = {
  REPLIES_TO: 'antwortet auf',
  AUTHORED_BY: 'verfasst von',
  MENTIONS: 'erwähnt',
  SAME_AS: 'entspricht',
  SUPPORTS: 'unterstützt',
  CONTRADICTS: 'widerspricht',
  DERIVED_FROM: 'abgeleitet aus',
  OBSERVED_IN: 'beobachtet in',
  CONTAINS: 'enthält',
  HAS_CHILD: 'enthält',
  VERWEIST_AUF: 'verweist auf',
};

const CONTENT_FIELDS = ['summary', 'description', 'text', 'content', 'body'];
const TITLE_FIELDS = new Set(['title', 'name', 'label']);
export const TECHNICAL_FIELDS = new Set([
  'id', 'key', 'parent', 'node_type', 'type', 'kind', 'position', 'sequence_in_parent',
  'run_id', 'workflow_id', 'space',
]);

export function friendlyType(node: PhaseXNode | undefined): string {
  const raw = node?.nodeType.trim().toLowerCase() ?? '';
  if (!raw) return 'Eintrag';
  return TYPE_LABELS[raw] ?? sentenceCase(raw.replace(/[_-]+/g, ' '));
}

export function friendlyTitle(node: PhaseXNode | undefined): string {
  if (!node) return 'Eintrag wird geladen …';
  const clean = node.title.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  if (clean) return clean;

  for (const [field, value] of node.fields) {
    if (!TITLE_FIELDS.has(field.toLowerCase())) continue;
    const candidate = value.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    if (candidate) return candidate;
  }

  return `${friendlyType(node)} ohne Titel`;
}

export function shortTitle(node: PhaseXNode | undefined, max = 58): string {
  const title = friendlyTitle(node);
  return title.length <= max ? title : `${title.slice(0, Math.max(1, max - 1))}…`;
}

export function friendlyField(field: string): string {
  const normalised = field.toLowerCase();
  if (FIELD_LABELS[normalised]) return FIELD_LABELS[normalised];
  return sentenceCase(field.replace(/[_-]+/g, ' '));
}

export function friendlyRelation(relation: string): string {
  return RELATION_LABELS[relation] ?? sentenceCase(relation.replace(/[_-]+/g, ' ').toLowerCase());
}

export function primaryContent(node: PhaseXNode): { field: string; value: string } | null {
  for (const wanted of CONTENT_FIELDS) {
    const found = node.fields.find(([field]) => field.toLowerCase() === wanted);
    if (found?.[1].trim()) return { field: found[0], value: found[1] };
  }
  return null;
}

export function visibleFields(node: PhaseXNode): [string, string][] {
  const primary = primaryContent(node)?.field.toLowerCase();
  return node.fields.filter(([field, value]) => {
    const name = field.toLowerCase();
    return value.trim() !== '' && name !== primary && !TECHNICAL_FIELDS.has(name) && !TITLE_FIELDS.has(name);
  });
}

export function technicalFields(node: PhaseXNode): [string, string][] {
  return node.fields.filter(([field]) => TECHNICAL_FIELDS.has(field.toLowerCase()));
}

export function breadcrumbIds(id: string, parents: ReadonlyMap<string, string>): string[] {
  const path = [id];
  const seen = new Set(path);
  let current = id;
  while (parents.has(current) && path.length < 24) {
    const parent = parents.get(current)!;
    if (seen.has(parent)) break;
    seen.add(parent);
    path.unshift(parent);
    current = parent;
  }
  return path;
}

export function valueForTree(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export function jsonDocumentFor(
  node: PhaseXNode,
  snapshot: PhaseXExplorerSnapshot
): Record<string, unknown> {
  const childItems = snapshot.children.get(node.id) ?? [];
  const edgeItems = snapshot.edges.get(node.id) ?? [];
  return {
    id: node.id,
    type: node.nodeType || 'entry',
    title: friendlyTitle(node),
    fields: Object.fromEntries(node.fields.map(([field, value]) => [field, valueForTree(value)])),
    children: childItems.map((child) => ({
      id: child.id,
      title: friendlyTitle(snapshot.nodes.get(child.id)),
      position: child.position,
    })),
    connections: edgeItems.map((edge) => ({
      relation: edge.relation,
      target: edge.target,
      title: friendlyTitle(snapshot.nodes.get(edge.target)),
    })),
  };
}

function sentenceCase(value: string): string {
  const clean = value.trim();
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}` : 'Eintrag';
}
