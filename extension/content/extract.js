/**
 * Page extraction, injected on demand by the popup.
 *
 * This script only ever *reads*. It ships raw material — readable text,
 * metadata, structured data, media references — and leaves every judgement
 * about what any of it means to the app, where the models and the API keys are.
 *
 * It is injected through chrome.scripting rather than declared as a content
 * script, so it runs on the page the user explicitly asked about and nowhere
 * else.
 */

(() => {
  /** Elements that never contain the content someone came to read. */
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
    '.advertisement',
    '.cookie-banner',
    '#cookie-banner',
  ].join(',');

  /** Containers a site is likely to put its actual article in. */
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

  // MARK: - Metadata

  function collectMeta() {
    const meta = {};

    for (const element of document.querySelectorAll('meta[name], meta[property]')) {
      const key = element.getAttribute('property') || element.getAttribute('name');
      const value = element.getAttribute('content');
      if (!key || !value) continue;
      // Keep the first value: later duplicates are usually per-platform
      // variants of the same thing.
      if (meta[key] === undefined) meta[key] = value.slice(0, 2000);
    }

    // Sites publish these as relative paths often enough that a consumer
    // cannot use them as-is; resolving here means neither the popup nor the
    // graph has to know where the value came from.
    for (const key of ['og:image', 'og:video', 'og:video:url', 'twitter:image']) {
      if (!meta[key]) continue;
      try {
        meta[key] = new URL(meta[key], location.href).toString();
      } catch {
        delete meta[key];
      }
    }

    const language = document.documentElement.lang || meta['og:locale'];
    if (language) meta.language = language;

    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical?.href) meta.canonical = canonical.href;

    return meta;
  }

  function collectJsonLd() {
    const blocks = [];
    for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        blocks.push(JSON.parse(element.textContent || ''));
      } catch {
        // Malformed JSON-LD is common enough that it is not worth reporting.
      }
    }
    return blocks;
  }

  // MARK: - Readable text

  /**
   * Picks the densest plausible content container. Text length per element is a
   * crude signal, but a reliable one: navigation has many elements and little
   * text, an article has the opposite.
   */
  function findContentRoot() {
    let best = null;
    let bestScore = 0;

    for (const selector of CONTENT_SELECTORS) {
      for (const candidate of document.querySelectorAll(selector)) {
        const text = candidate.innerText || '';
        if (text.length < 200) continue;
        const elements = candidate.querySelectorAll('*').length || 1;
        const score = text.length / Math.sqrt(elements);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }

    return best ?? document.body;
  }

  function extractText() {
    const root = findContentRoot();
    if (!root) return '';

    // Work on a copy so removing boilerplate does not disturb the live page.
    const clone = root.cloneNode(true);
    for (const element of clone.querySelectorAll(BOILERPLATE)) element.remove();

    const text = (clone.innerText || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text.slice(0, MAX_TEXT);
  }

  function collectLinks() {
    const links = [];
    const seen = new Set();

    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.href;
      if (!href.startsWith('http') || seen.has(href)) continue;
      seen.add(href);
      links.push({
        href,
        text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 200),
        rel: anchor.getAttribute('rel') || undefined,
      });
      if (links.length >= 300) break;
    }

    return links;
  }

  function collectImages() {
    const images = [];
    for (const image of document.querySelectorAll('img[src]')) {
      // Tracking pixels and icons carry no information worth a graph node.
      if (image.naturalWidth > 0 && image.naturalWidth < 120) continue;
      images.push({ src: image.src, alt: (image.alt || '').slice(0, 300) });
      if (images.length >= 60) break;
    }
    return images;
  }

  // MARK: - Platform specifics

  const PLATFORMS = {
    'youtube.com': extractYouTube,
    'youtu.be': extractYouTube,
    'x.com': extractX,
    'twitter.com': extractX,
    'instagram.com': extractInstagram,
    'tiktok.com': extractTikTok,
    'linkedin.com': extractLinkedIn,
    'reddit.com': extractReddit,
  };

  function platformOf() {
    const host = location.hostname.replace(/^www\./, '');
    for (const key of Object.keys(PLATFORMS)) {
      if (host === key || host.endsWith(`.${key}`)) return key;
    }
    return null;
  }

  function text(selector, root = document) {
    const element = root.querySelector(selector);
    return element ? (element.innerText || element.textContent || '').trim() : '';
  }

  /** Turns "1.2K", "3,4 Mio." and "12 345" into a number, or undefined. */
  function parseCount(value) {
    if (!value) return undefined;
    const cleaned = value.replace(/\s| /g, '').replace(/,/g, '.');
    const match = cleaned.match(/([\d.]+)\s*([KkMmBbTt]|Mio|Mrd)?/);
    if (!match) return undefined;

    const base = Number.parseFloat(match[1]);
    if (Number.isNaN(base)) return undefined;

    const suffix = (match[2] || '').toLowerCase();
    if (suffix === 'k' || suffix === 't') return Math.round(base * 1_000);
    if (suffix === 'm' || suffix === 'mio') return Math.round(base * 1_000_000);
    if (suffix === 'b' || suffix === 'mrd') return Math.round(base * 1_000_000_000);
    return Math.round(base);
  }

  function collectTags(body) {
    const hashtags = [...(body.match(/#[\p{L}\p{N}_]+/gu) || [])];
    const mentions = [...(body.match(/@[\p{L}\p{N}_.]+/gu) || [])];
    return { hashtags: [...new Set(hashtags)], mentions: [...new Set(mentions)] };
  }

  function extractYouTube(meta) {
    const body = text('#description-inline-expander') || meta.description || '';
    return {
      kind: 'video',
      post: {
        platform: 'youtube',
        author: text('#upload-info #channel-name a') || text('#owner #channel-name'),
        authorUrl: document.querySelector('#upload-info a[href^="/@"]')?.href,
        body,
        views: parseCount(text('#info span')),
        ...collectTags(body),
      },
      video: {
        platform: 'youtube',
        pageUrl: location.href,
        durationSeconds: Math.round(document.querySelector('video')?.duration || 0) || undefined,
        thumbnail: meta['og:image'],
      },
    };
  }

  function extractX(meta) {
    const article = document.querySelector('article[data-testid="tweet"]');
    const body = article ? text('[data-testid="tweetText"]', article) : meta.description || '';
    const groups = article?.querySelectorAll('[data-testid="User-Name"] a');

    return {
      kind: 'social',
      post: {
        platform: 'x',
        author: article ? text('[data-testid="User-Name"] span', article) : undefined,
        authorHandle: groups?.[groups.length - 1]?.getAttribute('href')?.replace('/', '@'),
        publishedAt: article?.querySelector('time')?.getAttribute('datetime') || undefined,
        body,
        replies: parseCount(article?.querySelector('[data-testid="reply"]')?.getAttribute('aria-label')),
        reposts: parseCount(article?.querySelector('[data-testid="retweet"]')?.getAttribute('aria-label')),
        likes: parseCount(article?.querySelector('[data-testid="like"]')?.getAttribute('aria-label')),
        ...collectTags(body),
      },
    };
  }

  function extractInstagram(meta) {
    const body = text('h1') || meta['og:description'] || '';
    const isReel = /\/(reel|reels)\//.test(location.pathname);

    return {
      kind: isReel ? 'video' : 'social',
      post: {
        platform: 'instagram',
        author: document.querySelector('header a[role="link"]')?.innerText?.trim(),
        authorUrl: document.querySelector('header a[role="link"]')?.href,
        publishedAt: document.querySelector('time')?.getAttribute('datetime') || undefined,
        body,
        ...collectTags(body),
      },
      video: isReel
        ? { platform: 'instagram', pageUrl: location.href, thumbnail: meta['og:image'] }
        : undefined,
    };
  }

  function extractTikTok(meta) {
    const body = text('[data-e2e="browse-video-desc"]') || meta.description || '';
    return {
      kind: 'video',
      post: {
        platform: 'tiktok',
        author: text('[data-e2e="browse-username"]'),
        authorHandle: text('[data-e2e="browse-username"]'),
        body,
        likes: parseCount(text('[data-e2e="browse-like-count"]')),
        replies: parseCount(text('[data-e2e="browse-comment-count"]')),
        ...collectTags(body),
      },
      video: { platform: 'tiktok', pageUrl: location.href, thumbnail: meta['og:image'] },
    };
  }

  function extractLinkedIn(meta) {
    const body = text('.feed-shared-update-v2__description') || meta.description || '';
    return {
      kind: 'social',
      post: {
        platform: 'linkedin',
        author: text('.update-components-actor__title'),
        body,
        ...collectTags(body),
      },
    };
  }

  function extractReddit(meta) {
    const body = text('[data-test-id="post-content"] [data-click-id="text"]') || meta.description || '';
    return {
      kind: 'social',
      post: {
        platform: 'reddit',
        author: text('[data-testid="post_author_link"]'),
        body,
        ...collectTags(body),
      },
    };
  }

  // MARK: - Generic video detection

  function detectVideo(meta) {
    if (meta['og:video'] || meta['og:video:url'] || meta['og:type'] === 'video.other') {
      return {
        platform: location.hostname.replace(/^www\./, ''),
        pageUrl: location.href,
        mediaUrl: meta['og:video'] || meta['og:video:url'],
        thumbnail: meta['og:image'],
      };
    }

    // A player big enough to be the point of the page, rather than an
    // autoplaying background clip.
    const video = document.querySelector('video');
    if (video && (video.videoWidth >= 320 || video.duration > 20)) {
      return {
        platform: location.hostname.replace(/^www\./, ''),
        pageUrl: location.href,
        mediaUrl: video.currentSrc || undefined,
        durationSeconds: Math.round(video.duration) || undefined,
        thumbnail: video.poster || meta['og:image'],
      };
    }

    return null;
  }

  // MARK: - Assembly

  const meta = collectMeta();
  const platform = platformOf();
  const specific = platform ? PLATFORMS[platform](meta) : {};

  const video = specific.video ?? detectVideo(meta);
  const kind = specific.kind ?? (video ? 'video' : 'website');

  return {
    kind,
    url: meta.canonical || location.href,
    title: document.title || meta['og:title'] || location.href,
    text: extractText(),
    meta,
    jsonLd: collectJsonLd(),
    links: collectLinks(),
    images: collectImages(),
    post: specific.post,
    video: video ?? undefined,
    capturedAt: new Date().toISOString(),
  };
})();
