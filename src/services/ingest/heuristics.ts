import { GraphEdge, GraphNode } from '../../types/graph';
import { IngestPayload } from '../../types/ingest';
import { edgeId, entityId, urlId } from '../../lib/graph';

/**
 * The structural pass: everything that can be derived from a page without
 * asking a model. It runs first and always, so an ingest still produces a
 * usable graph when no API key is configured or the budget is spent — the AI
 * pass then only adds the entities that need reading comprehension.
 */

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The node the source itself is represented by — the AI pass links to it. */
  rootId: string;
  /** Plain text the AI pass should read, already assembled and trimmed. */
  text: string;
}

/** German and English function words, which carry no topical signal. */
const STOPWORDS = new Set([
  'aber','alle','allem','allen','aller','alles','als','also','am','an','ander','andere','anderem',
  'anderen','anderer','anderes','auch','auf','aus','bei','bin','bis','bist','da','damit','dann',
  'das','dass','dein','deine','dem','den','der','des','dessen','dich','die','dies','diese','diesem',
  'diesen','dieser','dieses','dir','doch','dort','du','durch','ein','eine','einem','einen','einer',
  'eines','er','es','etwas','euer','eure','für','gegen','gewesen','hab','habe','haben','hat','hatte',
  'hatten','hier','hin','hinter','ich','ihr','ihre','im','in','ins','ist','ja','jede','jedem','jeden',
  'jeder','jedes','jene','jetzt','kann','kein','keine','können','könnte','machen','man','manche',
  'mein','meine','mit','muss','musste','nach','nicht','nichts','noch','nun','nur','ob','oder','ohne',
  'schon','sehr','sein','seine','selbst','sich','sie','sind','so','solche','soll','sollte','sondern',
  'sonst','über','um','und','uns','unser','unter','viel','vom','von','vor','war','waren','warum',
  'was','weg','weil','weiter','welche','wenn','werde','werden','wie','wieder','will','wir','wird',
  'wirst','wo','wollen','wollte','würde','würden','zu','zum','zur','zwar','zwischen',
  'a','about','after','all','also','an','and','any','are','as','at','be','because','been','before',
  'being','but','by','can','could','did','do','does','for','from','get','had','has','have','he','her',
  'here','him','his','how','i','if','in','into','is','it','its','just','like','me','more','most','my',
  'no','not','now','of','on','one','only','or','other','our','out','over','said','same','she','should',
  'so','some','such','than','that','the','their','them','then','there','these','they','this','those',
  'through','to','too','up','very','was','we','were','what','when','where','which','while','who','why',
  'will','with','would','you','your',
]);

/** Schema.org types worth turning into their own node. */
const SCHEMA_LABELS: Record<string, string> = {
  Person: 'Person',
  Organization: 'Organization',
  Corporation: 'Organization',
  NewsMediaOrganization: 'Organization',
  Place: 'Place',
  LocalBusiness: 'Organization',
  Product: 'Product',
  Event: 'Event',
  CreativeWork: 'Work',
  Article: 'Work',
  NewsArticle: 'Work',
  BlogPosting: 'Work',
  VideoObject: 'Work',
  Recipe: 'Work',
  Book: 'Work',
  Movie: 'Work',
};

export function buildStructuralGraph(payload: IngestPayload): SubGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addNode = (node: GraphNode): GraphNode => {
    const existing = nodes.get(node.id);
    if (existing) {
      for (const label of node.labels) {
        if (!existing.labels.includes(label)) existing.labels.push(label);
      }
      Object.assign(existing.properties, prune(node.properties));
      return existing;
    }
    const created = { ...node, properties: prune(node.properties) };
    nodes.set(created.id, created);
    return created;
  };

  const addEdge = (from: string, type: string, to: string, properties: GraphEdge['properties'] = {}) => {
    if (from === to) return;
    const id = edgeId(from, type, to);
    if (edges.has(id)) return;
    edges.set(id, { id, type, from, to, properties });
  };

  // MARK: The source node

  const rootLabel = payload.kind === 'video' ? 'Video' : payload.kind === 'social' ? 'Post' : 'Page';
  const rootId = urlId(rootLabel.toLowerCase(), payload.url);
  const meta = payload.meta ?? {};

  addNode({
    id: rootId,
    labels: [rootLabel, 'Source'],
    properties: {
      title: payload.title || meta['og:title'] || payload.url,
      url: payload.url,
      description: meta.description || meta['og:description'] || '',
      language: meta.language || '',
      publishedAt: meta['article:published_time'] || payload.post?.publishedAt || '',
      capturedAt: payload.capturedAt,
      kind: payload.kind,
      wordCount: payload.text ? countWords(payload.text) : 0,
      durationSeconds: payload.video?.durationSeconds ?? 0,
      thumbnail: payload.video?.thumbnail || meta['og:image'] || '',
    },
  });

  // MARK: Site

  const host = safeHost(payload.url);
  if (host) {
    const siteId = entityId('Site', host);
    addNode({
      id: siteId,
      labels: ['Site'],
      properties: {
        name: meta['og:site_name'] || host,
        domain: host,
        url: `https://${host}`,
      },
    });
    addEdge(rootId, 'VEROEFFENTLICHT_AUF', siteId);
  }

  // MARK: Author and social metrics

  const post = payload.post;
  const authorName = post?.author || meta.author || meta['article:author'] || '';
  if (authorName) {
    const authorId = entityId('Person', post?.authorHandle || authorName);
    addNode({
      id: authorId,
      labels: ['Person', 'Author'],
      properties: {
        name: authorName,
        handle: post?.authorHandle || '',
        url: post?.authorUrl || '',
        platform: post?.platform || host || '',
      },
    });
    addEdge(rootId, 'VERFASST_VON', authorId);
  }

  if (post) {
    const root = nodes.get(rootId)!;
    Object.assign(
      root.properties,
      prune({
        platform: post.platform,
        body: post.body ?? '',
        likes: post.likes ?? 0,
        reposts: post.reposts ?? 0,
        replies: post.replies ?? 0,
      })
    );

    for (const tag of post.hashtags ?? []) {
      const clean = tag.replace(/^#/, '').trim();
      if (!clean) continue;
      const topicId = entityId('Topic', clean);
      addNode({ id: topicId, labels: ['Topic'], properties: { name: clean, source: 'hashtag' } });
      addEdge(rootId, 'GETAGGT_MIT', topicId);
    }

    for (const mention of post.mentions ?? []) {
      const clean = mention.replace(/^@/, '').trim();
      if (!clean) continue;
      const personId = entityId('Person', clean);
      addNode({
        id: personId,
        labels: ['Person'],
        properties: { name: clean, handle: `@${clean}`, platform: post.platform },
      });
      addEdge(rootId, 'ERWAEHNT', personId);
    }
  }

  // MARK: JSON-LD
  //
  // Structured data a site publishes about itself is more reliable than
  // anything extracted from prose, so it is taken at face value.

  for (const block of payload.jsonLd ?? []) {
    for (const entry of flattenJsonLd(block)) {
      const type = firstType(entry);
      const label = type ? SCHEMA_LABELS[type] : undefined;
      const name = typeof entry.name === 'string' ? entry.name : (entry.headline as string | undefined);
      if (!label || !name) continue;

      const id = entityId(label, name);
      addNode({
        id,
        labels: [label],
        properties: {
          name,
          description: asString(entry.description),
          url: asString(entry.url),
          source: 'json-ld',
          schemaType: type ?? '',
        },
      });
      addEdge(rootId, label === 'Person' || label === 'Organization' ? 'NENNT' : 'BESCHREIBT', id);
    }
  }

  // MARK: Outgoing links
  //
  // Only links leaving the current host are kept. In-site navigation would add
  // hundreds of edges that say nothing beyond "this site has a menu".

  const seenTargets = new Set<string>();
  for (const link of payload.links ?? []) {
    const targetHost = safeHost(link.href);
    if (!targetHost || targetHost === host) continue;
    if (seenTargets.size >= 40) break;
    if (seenTargets.has(targetHost)) continue;
    seenTargets.add(targetHost);

    const siteId = entityId('Site', targetHost);
    addNode({
      id: siteId,
      labels: ['Site'],
      properties: { name: targetHost, domain: targetHost, url: `https://${targetHost}` },
    });
    addEdge(rootId, 'VERLINKT_AUF', siteId, { anchor: link.text.slice(0, 120) });
  }

  // MARK: Keyword topics
  //
  // A cheap fallback so a page without JSON-LD and without an AI pass still
  // gets topical structure.

  const text = assembleText(payload);
  for (const keyword of topKeywords(text, 12)) {
    const topicId = entityId('Topic', keyword.term);
    addNode({
      id: topicId,
      labels: ['Topic'],
      properties: { name: keyword.term, source: 'keyword' },
    });
    addEdge(rootId, 'HANDELT_VON', topicId, { occurrences: keyword.count });
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], rootId, text };
}

/** Everything readable about the source, in the order a reader would see it. */
export function assembleText(payload: IngestPayload): string {
  const parts = [
    payload.title,
    payload.meta?.description ?? payload.meta?.['og:description'] ?? '',
    payload.post?.body ?? '',
    payload.text ?? '',
  ];
  return parts
    .filter((part) => part && part.trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Frequency-ranked terms, used as topics when no model has read the text.
 *
 * The filter that does the real work is capitalisation: German capitalises
 * nouns, so a term written in upper case in the majority of its occurrences is
 * almost always a thing, while verbs and adjectives — "bleiben", "sichtbar" —
 * stay lower case except at the start of a sentence. In English the same rule
 * selects proper nouns. It is a heuristic, not grammar: it will miss a topic
 * that only ever appears sentence-initially, and that is the price of not
 * shipping a parser.
 */
export function topKeywords(text: string, limit: number): Array<{ term: string; count: number }> {
  interface Tally {
    term: string;
    count: number;
    capitalised: number;
  }
  const counts = new Map<string, Tally>();

  for (const raw of text.split(/[^\p{L}\p{N}_-]+/u)) {
    const token = raw.trim();
    if (token.length < 4 || token.length > 32) continue;
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/^\d+$/.test(lower)) continue;

    const isCapitalised = /^\p{Lu}/u.test(token);
    const existing = counts.get(lower);

    if (existing) {
      existing.count += 1;
      if (isCapitalised) {
        existing.capitalised += 1;
        // Keep the capitalised spelling as the display form.
        if (!/^\p{Lu}/u.test(existing.term)) existing.term = token;
      }
    } else {
      counts.set(lower, { term: token, count: 1, capitalised: isCapitalised ? 1 : 0 });
    }
  }

  return [...counts.values()]
    .filter((entry) => entry.count >= 2 && entry.capitalised * 2 > entry.count)
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map(({ term, count }) => ({ term, count }));
}

// MARK: - Helpers

function prune(properties: GraphNode['properties']): GraphNode['properties'] {
  const result: GraphNode['properties'] = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === '' || value === null || value === undefined) continue;
    if (typeof value === 'number' && value === 0) continue;
    result[key] = value;
  }
  return result;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstType(entry: Record<string, unknown>): string | null {
  const type = entry['@type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type) && typeof type[0] === 'string') return type[0];
  return null;
}

/** JSON-LD nests entities in `@graph` and in arrays; this flattens one level. */
function flattenJsonLd(block: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(block)) return block.flatMap(flattenJsonLd);
  if (!block || typeof block !== 'object') return [];

  const entry = block as Record<string, unknown>;
  if (Array.isArray(entry['@graph'])) {
    return [entry, ...entry['@graph'].flatMap(flattenJsonLd)].filter(
      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null
    );
  }
  return [entry];
}
