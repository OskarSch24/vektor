import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension } from 'marked';

/**
 * Markdown → sanitised HTML.
 *
 * The preview runs inside the app's own web view, next to the native bridge
 * that can write files. Everything a note contains is therefore treated as
 * untrusted: raw HTML is allowed for layout, scripts and handlers never are.
 */

export interface Frontmatter {
  raw: string;
  body: string;
}

/** Splits a leading YAML block (`---` … `---`) off the note. */
export function splitFrontmatter(text: string): Frontmatter | null {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  return { raw: match[1], body: text.slice(match[0].length) };
}

/** `[[Note]]` and `[[Note|Label]]`, as written in Obsidian-style vaults. */
const wikiLink: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  start: (src) => src.indexOf('[['),
  tokenizer(src) {
    const match = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (!match) return undefined;
    return {
      type: 'wikiLink',
      raw: match[0],
      target: match[1].trim(),
      label: (match[2] ?? match[1]).trim(),
    };
  },
  renderer(token) {
    const target = String(token.target);
    const [page, anchor] = target.split('#');
    const file = /\.[a-z0-9]+$/i.test(page) ? page : `${page}.md`;
    const href = `${encodeURI(file)}${anchor ? `#${slugify(anchor)}` : ''}`;
    return `<a href="${escapeAttribute(href)}" class="md-wikilink">${escapeHtml(String(token.label))}</a>`;
  },
};

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({ extensions: [wikiLink] });

const LOCAL_IMAGE_ATTRIBUTE = 'data-local-src';

// Without a DOM (unit tests) DOMPurify is an inert stub.
DOMPurify.isSupported && DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src');
    // Relative images are resolved against the note's folder later; the web
    // view's own origin would only answer them with a 404.
    if (src && isRelativeReference(src)) {
      node.setAttribute(LOCAL_IMAGE_ATTRIBUTE, src);
      node.removeAttribute('src');
    }
    node.setAttribute('loading', 'lazy');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  });
}

export function localImageSource(image: HTMLImageElement): string | null {
  return image.getAttribute(LOCAL_IMAGE_ATTRIBUTE);
}

export function isRelativeReference(reference: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference);
}

/** GitHub-style heading ids, so `[x](#some-heading)` links work. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Resolves `reference` (relative, `..`, or `/absolute`) against a folder. */
export function resolvePath(folder: string, reference: string): string {
  const decoded = safeDecode(reference.split('#')[0].split('?')[0]);
  const parts = (decoded.startsWith('/') ? decoded : `${folder}/${decoded}`).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join('/')}`;
}

export function folderOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function countWords(text: string): number {
  return text.match(/[\p{Letter}\p{Number}]+(?:['’-][\p{Letter}\p{Number}]+)*/gu)?.length ?? 0;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
