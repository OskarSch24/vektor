import { IngestPayload } from '../../types/ingest';

/**
 * Turns fetched HTML into the same payload shape the browser extension sends.
 *
 * The extension reads a live, rendered page; this reads what the server sent.
 * That is a real difference — a site that renders its article client-side gives
 * up little here — but it is what makes a pasted URL, and every address found
 * by the site map, worth more than a bare node with nothing in it.
 *
 * Parsing happens in the renderer rather than the host because `DOMParser` is
 * right here and a hand-written HTML parser in Swift would be a liability.
 */

const BOILERPLATE = [
  'nav',
  'header',
  'footer',
  'aside',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'form',
  'iframe',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
].join(',');

const CONTENT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '[itemprop="articleBody"]',
  '.post-content',
  '.article-body',
  '.entry-content',
  '#content',
];

const MAX_TEXT = 120_000;

export function extractFromHtml(html: string, url: string): IngestPayload {
  const document = new DOMParser().parseFromString(html, 'text/html');

  const meta = collectMeta(document, url);
  const canonical = meta.canonical || url;

  return {
    kind: meta['og:video'] || meta['og:type'] === 'video.other' ? 'video' : 'website',
    url: canonical,
    title: document.title || meta['og:title'] || url,
    text: extractText(document),
    meta,
    jsonLd: collectJsonLd(document),
    links: collectLinks(document, canonical),
    images: [],
    capturedAt: new Date().toISOString(),
  };
}

function collectMeta(document: Document, base: string): Record<string, string> {
  const meta: Record<string, string> = {};

  for (const element of document.querySelectorAll('meta[name], meta[property]')) {
    const key = element.getAttribute('property') || element.getAttribute('name');
    const value = element.getAttribute('content');
    if (!key || !value || meta[key] !== undefined) continue;
    meta[key] = value.slice(0, 2000);
  }

  for (const key of ['og:image', 'og:video', 'og:video:url', 'twitter:image']) {
    if (!meta[key]) continue;
    meta[key] = absolute(meta[key], base) ?? '';
    if (!meta[key]) delete meta[key];
  }

  const language = document.documentElement.getAttribute('lang') || meta['og:locale'];
  if (language) meta.language = language;

  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const resolved = canonical ? absolute(canonical, base) : null;
  if (resolved) meta.canonical = resolved;

  return meta;
}

function collectJsonLd(document: Document): unknown[] {
  const blocks: unknown[] = [];
  for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      blocks.push(JSON.parse(element.textContent ?? ''));
    } catch {
      // Malformed JSON-LD is too common to be worth reporting.
    }
  }
  return blocks;
}

/**
 * `innerText` does not exist on a parsed document — it depends on layout, and
 * nothing here is laid out. `textContent` on a cleaned subtree is the honest
 * substitute; block elements get a newline so paragraphs survive.
 */
function extractText(document: Document): string {
  const root = findContentRoot(document);
  if (!root) return '';

  const clone = root.cloneNode(true) as Element;
  for (const element of clone.querySelectorAll(BOILERPLATE)) element.remove();

  for (const element of clone.querySelectorAll('p, div, li, br, h1, h2, h3, h4, h5, h6, tr')) {
    element.append(document.createTextNode('\n'));
  }

  return (clone.textContent ?? '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

function findContentRoot(document: Document): Element | null {
  let best: Element | null = null;
  let bestScore = 0;

  for (const selector of CONTENT_SELECTORS) {
    for (const candidate of document.querySelectorAll(selector)) {
      const length = (candidate.textContent ?? '').length;
      if (length < 200) continue;
      // Text per element: navigation has many elements and little text, an
      // article the opposite.
      const score = length / Math.sqrt(candidate.querySelectorAll('*').length || 1);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  return best ?? document.body;
}

function collectLinks(document: Document, base: string): IngestPayload['links'] {
  const links: NonNullable<IngestPayload['links']> = [];
  const seen = new Set<string>();

  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = absolute(anchor.getAttribute('href') ?? '', base);
    if (!href || seen.has(href)) continue;
    seen.add(href);

    links.push({
      href,
      text: (anchor.textContent ?? '').trim().slice(0, 200),
      rel: anchor.getAttribute('rel') ?? undefined,
    });
    if (links.length >= 300) break;
  }

  return links;
}

function absolute(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
