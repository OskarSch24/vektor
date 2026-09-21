#!/usr/bin/env node
/**
 * codewiki.mjs — collector for codewiki.google
 *
 * Standalone Node script, no dependencies (needs Node >= 18 for global fetch).
 *
 *   node codewiki.mjs list  [--limit N] [--expand] [--out FILE]
 *   node codewiki.mjs fetch [--from FILE | owner/repo ...] [--concurrency N] [--limit N]
 *                           [--out DIR] [--force]
 *
 * Staged output contract (read by a downstream tool — do not change lightly):
 *
 *   <out>/<owner>__<repo>/raw.json       unwrapped RPC payload, verbatim
 *   <out>/<owner>__<repo>/wiki.md        full markdown document (payload[2])
 *   <out>/<owner>__<repo>/sections.json  [{index,title,level,description,
 *                                          sourceFiles,markdown,diagramDot,diagramSvg}]
 *   <out>/<owner>__<repo>/meta.json      {owner,name,repoSlug,githubUrl,codewikiUrl,
 *                                         commitSha,capturedAt,checksum,sectionCount,
 *                                         markdownChars,hasWiki}
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

const ENDPOINT = 'https://codewiki.google/_/BoqAngularSdlcAgentsUi/data/batchexecute';
const RPC_WIKI = 'VSX6ub';
const RPC_LIST = 'vyWDAf';

const MAX_CONCURRENCY = 4;          // hard cap — observed 502s beyond this
const DEFAULT_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 90_000;  // cold repos take up to ~40 s
const WORKER_PAUSE_MS = 400;        // politeness pause per worker between requests
const RETRIES = 3;
const BACKOFF_MS = [2_000, 6_000, 15_000];

/* ------------------------------------------------------------------ RPC */

class RetryableError extends Error {}

/**
 * Google batchexecute chunked response -> parsed payload of the given rpcid.
 *
 * The body is `)]}'`, then alternating length lines and JSON lines. Besides the
 * data chunk `[["wrb.fr", rpcid, "<json string>", …]]` every response also carries
 * trailer chunks (`di`, `af.httprm`, `e`) — those are protocol bookkeeping, not
 * errors. A real RPC failure is a wrb.fr whose payload slot is null and whose
 * slot 5 holds the status code (e.g. [13] when the argument is not a full
 * GitHub URL). Responses that carry only trailers happen under load and are
 * transient, so they are reported as retryable.
 */
function unwrapBatchExecute(text, rpcid) {
  const stripped = text.replace(/^\)\]\}'\s*/, '');
  let sawTruncated = false;

  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('[')) continue; // length lines / blanks
    let outer;
    try {
      outer = JSON.parse(line);
    } catch {
      // a data chunk that does not parse means the stream was cut short
      if (line.startsWith('[["wrb.fr')) sawTruncated = true;
      continue;
    }
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== rpcid) continue;
      if (typeof entry[2] === 'string') return JSON.parse(entry[2]);
      const code = Array.isArray(entry[5]) ? entry[5][0] : entry[5];
      const msg = `RPC rejected the call (status ${JSON.stringify(code)})`;
      // gRPC INTERNAL / DEADLINE_EXCEEDED / UNAVAILABLE: the backend sheds load
      // with these when a query is too heavy, so they are worth another try.
      // (13 is also what a malformed argument returns — that surfaces after the
      // retries are exhausted.)
      throw [4, 13, 14].includes(code) ? new RetryableError(msg) : new Error(msg);
    }
  }

  throw new RetryableError(
    sawTruncated
      ? `truncated ${rpcid} response (${text.length} bytes)`
      : `no ${rpcid} payload in response (${text.length} bytes)`,
  );
}

async function rpcOnce(rpcid, args) {
  const body = new URLSearchParams({
    'f.req': JSON.stringify([[[rpcid, JSON.stringify(args), null, 'generic']]]),
  }).toString();

  let res;
  try {
    res = await fetch(`${ENDPOINT}?rpcids=${rpcid}&rt=c`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RetryableError(`network/timeout: ${err.message}`);
  }

  if (res.status >= 500 || res.status === 429) {
    throw new RetryableError(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  return unwrapBatchExecute(text, rpcid);
}

async function rpc(rpcid, args, attempts = RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await rpcOnce(rpcid, args);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof RetryableError) || attempt === attempts - 1) break;
      await sleep(BACKOFF_MS[attempt] ?? 15_000);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- utils */

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

/** owner/repo, github URL or codewiki URL -> "owner/repo" */
function normalizeSlug(input) {
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  s = s.replace(/^https?:\/\/codewiki\.google\//i, '');
  s = s.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`cannot parse repo: ${input}`);
  return `${parts[0]}/${parts[1]}`;
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const dirNameFor = (slug) => slug.replace('/', '__');

/** write via temp file + rename so Ctrl-C never leaves a half-written file */
async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;

/* ---------------------------------------------------- payload -> staged */

/**
 * Field indices inside one section (verified against live responses):
 *   [0] title          [1] level (1-4)     [2] description
 *   [3] source files   [[path], [path]]    [4] plain markdown (no links)
 *   [5] linkified markdown (this is what wiki.md / payload[2] contains)
 *   [6] unknown flag (always 1 so far)
 *   [7] visuals: [ [meta, tableVariant|null, diagramVariant|null], ... ]
 *                 diagramVariant = [graphvizDot, svg]
 *   [8] unknown (always null so far)       [9] anchor (#slug)
 */
function extractSections(payload) {
  const rawSections = payload?.[0]?.[1] ?? [];
  return rawSections.map((s, index) => {
    const sourceFiles = Array.isArray(s[3])
      ? s[3].map((f) => (Array.isArray(f) ? f[0] : f)).filter((f) => typeof f === 'string')
      : [];

    let diagramDot = null;
    let diagramSvg = null;
    for (const visual of Array.isArray(s[7]) ? s[7] : []) {
      const diagram = Array.isArray(visual) ? visual[2] : null;
      if (Array.isArray(diagram) && typeof diagram[0] === 'string') {
        diagramDot = diagram[0];
        diagramSvg = typeof diagram[1] === 'string' ? diagram[1] : null;
        break; // first diagram wins; raw.json keeps any extras
      }
    }

    return {
      index,
      title: typeof s[0] === 'string' ? s[0] : '',
      level: typeof s[1] === 'number' ? s[1] : null,
      description: typeof s[2] === 'string' ? s[2] : '',
      sourceFiles,
      markdown: typeof s[5] === 'string' ? s[5] : typeof s[4] === 'string' ? s[4] : '',
      diagramDot,
      diagramSvg,
    };
  });
}

/** A staged dir counts as complete when meta.json is valid and its files are intact. */
async function isComplete(dir) {
  const metaPath = path.join(dir, 'meta.json');
  if (!existsSync(metaPath)) return false;
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return false;
  }
  if (!meta.capturedAt || !meta.repoSlug) return false;
  if (meta.hasWiki === false) return true; // remembered as "no wiki" — don't retry
  for (const f of ['raw.json', 'wiki.md', 'sections.json']) {
    if (!existsSync(path.join(dir, f))) return false;
  }
  try {
    const md = await readFile(path.join(dir, 'wiki.md'), 'utf8');
    if (meta.checksum && sha256(md) !== meta.checksum) return false;
  } catch {
    return false;
  }
  return true;
}

async function stageRepo(slug, outRoot) {
  const githubUrl = `https://github.com/${slug}`;
  const payload = await rpc(RPC_WIKI, [githubUrl]);

  const [owner, name] = slug.split('/');
  const dir = path.join(outRoot, dirNameFor(slug));
  await mkdir(dir, { recursive: true });

  const capturedAt = new Date().toISOString();
  const base = {
    owner,
    name,
    repoSlug: slug,
    githubUrl,
    // Die Route ist `:public_host/:repo_owner/:repo_name` — der Host gehoert in
    // den Pfad. Ohne ihn zeigt der Link auf "Not Found".
    codewikiUrl: `https://codewiki.google/github.com/${slug}`,
    capturedAt,
  };

  // No 404 exists on this service: a missing wiki shows up as payload[0] === null.
  if (payload?.[0] == null) {
    await writeAtomic(path.join(dir, 'raw.json'), JSON.stringify(payload, null, 2));
    await writeAtomic(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        { ...base, commitSha: null, checksum: null, sectionCount: 0, markdownChars: 0, hasWiki: false },
        null,
        2,
      ),
    );
    return { hasWiki: false, sectionCount: 0, markdownChars: 0, bytes: 0 };
  }

  const [repoSlugFromApi, commitSha] = payload[0][0] ?? [slug, null];
  const sections = extractSections(payload);
  const wikiMd = typeof payload[2] === 'string' ? payload[2] : '';
  const rawJson = JSON.stringify(payload);

  // meta.json is written last, so an interrupted run never looks complete.
  await writeAtomic(path.join(dir, 'raw.json'), rawJson);
  await writeAtomic(path.join(dir, 'wiki.md'), wikiMd);
  await writeAtomic(path.join(dir, 'sections.json'), JSON.stringify(sections, null, 2));
  await writeAtomic(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      {
        ...base,
        repoSlug: repoSlugFromApi || slug,
        commitSha: commitSha ?? null,
        checksum: sha256(wikiMd),
        sectionCount: sections.length,
        markdownChars: wikiMd.length,
        hasWiki: true,
      },
      null,
      2,
    ),
  );

  return {
    hasWiki: true,
    sectionCount: sections.length,
    markdownChars: wikiMd.length,
    bytes: Buffer.byteLength(rawJson),
  };
}

/* ------------------------------------------------------------ cmd: list */

function normalizeListEntry(e) {
  if (!Array.isArray(e)) return null;
  const slug = e[0];
  if (typeof slug !== 'string' || !slug.includes('/')) return null;
  const detail = Array.isArray(e[5]) ? e[5] : [];
  const ts = Array.isArray(e[4]) ? e[4][0] : null;
  return {
    repoSlug: slug,
    githubUrl: Array.isArray(e[3]) ? e[3][1] ?? `https://github.com/${slug}` : `https://github.com/${slug}`,
    description: typeof detail[0] === 'string' ? detail[0] : null,
    avatarUrl: typeof detail[1] === 'string' ? detail[1] : null,
    stars: typeof detail[2] === 'number' ? detail[2] : null,
    rank: typeof e[2] === 'number' ? e[2] : null,
    updatedAt: typeof ts === 'number' ? new Date(ts * 1000).toISOString() : null,
  };
}

async function queryList(query, limit, attempts = 2) {
  // 4th argument is NOT an offset — passing anything but 0 returns zero hits.
  const payload = await rpc(RPC_LIST, [query, limit, query, 0], attempts);
  const items = (payload?.[0] ?? []).map(normalizeListEntry).filter(Boolean);
  const total = typeof payload?.[1] === 'number' ? payload[1] : null;
  return { items, total };
}

/**
 * The gateway kills the request at 60 s and a big limit is slow
 * (20000 ≈ 44 s, 31000 → 502). Halve the limit and retry on failure.
 */
async function queryListAdaptive(query, limit) {
  let l = limit;
  for (;;) {
    try {
      return await queryList(query, l);
    } catch (err) {
      if (l <= 500) throw err;
      l = Math.floor(l / 2);
      console.log(`  query "${query}" failed (${err.message}) — retrying with limit ${l}`);
    }
  }
}

const EXPAND_QUERIES = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').concat(['-', '_', '.']);

async function cmdList(flags) {
  const limit = Number(flags.limit ?? 20_000);
  const expandLimit = Number(flags['expand-limit'] ?? 5_000);
  const outFile = flags.out ? path.resolve(String(flags.out)) : path.join(TOOL_DIR, 'repos.json');
  const expand = Boolean(flags.expand);
  const t0 = Date.now();

  console.log(`list: query="" limit=${limit}`);
  const first = await queryListAdaptive('', limit);
  const bySlug = new Map(first.items.map((i) => [i.repoSlug, i]));
  const total = first.total;
  console.log(`  base query -> ${first.items.length} repos (server reports ${total} total)`);

  if (expand && bySlug.size < (total ?? Infinity)) {
    console.log(
      `expanding with ${EXPAND_QUERIES.length} letter/digit queries ` +
        `(limit ${expandLimit}, concurrency 3)…`,
    );
    const queue = [...EXPAND_QUERIES];
    const worker = async () => {
      while (queue.length) {
        const q = queue.shift();
        try {
          const r = await queryListAdaptive(q, expandLimit);
          let added = 0;
          for (const it of r.items) {
            if (!bySlug.has(it.repoSlug)) {
              bySlug.set(it.repoSlug, it);
              added++;
            }
          }
          console.log(`  "${q}" -> ${r.items.length} hits, +${added} new (union ${bySlug.size})`);
        } catch (err) {
          console.log(`  "${q}" -> FAILED ${err.message}`);
        }
        await sleep(WORKER_PAUSE_MS);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  const repos = [...bySlug.values()].sort((a, b) => a.repoSlug.localeCompare(b.repoSlug));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeAtomic(
    outFile,
    JSON.stringify(
      { fetchedAt: new Date().toISOString(), reportedTotal: total, count: repos.length, repos },
      null,
      2,
    ),
  );

  console.log(
    `\nlist done in ${fmtMs(Date.now() - t0)}: ${repos.length} unique repos` +
      (total ? ` of ${total} reported (${((repos.length / total) * 100).toFixed(1)}%)` : '') +
      `\nwritten to ${outFile}`,
  );
}

/* ----------------------------------------------------------- cmd: fetch */

async function loadRepoList(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const arr = Array.isArray(parsed) ? parsed : parsed.repos ?? [];
  return arr.map((r) => normalizeSlug(typeof r === 'string' ? r : r.repoSlug ?? r.githubUrl));
}

async function cmdFetch(flags, positional) {
  const outRoot = flags.out ? path.resolve(String(flags.out)) : path.join(TOOL_DIR, 'staged');
  let concurrency = Number(flags.concurrency ?? DEFAULT_CONCURRENCY);
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = DEFAULT_CONCURRENCY;
  if (concurrency > MAX_CONCURRENCY) {
    console.log(`concurrency ${concurrency} capped to ${MAX_CONCURRENCY}`);
    concurrency = MAX_CONCURRENCY;
  }
  const force = Boolean(flags.force);

  let slugs = positional.map(normalizeSlug);
  if (flags.from) slugs = slugs.concat(await loadRepoList(path.resolve(String(flags.from))));
  slugs = [...new Set(slugs)];
  if (flags.limit) slugs = slugs.slice(0, Number(flags.limit));

  if (!slugs.length) {
    console.error('fetch: no repos given (use --from FILE or pass owner/repo arguments)');
    process.exit(2);
  }

  await mkdir(outRoot, { recursive: true });
  console.log(`fetch: ${slugs.length} repos, concurrency ${concurrency}, out ${outRoot}\n`);

  const stats = { fetched: 0, skipped: 0, noWiki: 0, failed: 0 };
  const failures = [];
  const queue = slugs.map((slug, i) => ({ slug, i }));
  const t0 = Date.now();
  const pad = String(slugs.length).length;

  const worker = async () => {
    while (queue.length) {
      const { slug, i } = queue.shift();
      const tag = `[${String(i + 1).padStart(pad)}/${slugs.length}] ${slug}`;
      const dir = path.join(outRoot, dirNameFor(slug));

      if (!force && (await isComplete(dir))) {
        stats.skipped++;
        console.log(`${tag}  SKIP (already staged)`);
        continue;
      }

      const t = Date.now();
      try {
        const r = await stageRepo(slug, outRoot);
        if (r.hasWiki) {
          stats.fetched++;
          console.log(
            `${tag}  OK ${r.sectionCount} sections, ${r.markdownChars} md chars, ` +
              `${fmtBytes(r.bytes)} raw  (${fmtMs(Date.now() - t)})`,
          );
        } else {
          stats.noWiki++;
          console.log(`${tag}  NO WIKI (${fmtMs(Date.now() - t)})`);
        }
      } catch (err) {
        stats.failed++;
        failures.push({ slug, error: err.message });
        console.log(`${tag}  FAIL ${err.message} (${fmtMs(Date.now() - t)})`);
      }
      await sleep(WORKER_PAUSE_MS);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, slugs.length) }, worker));

  console.log(
    `\nsummary: fetched ${stats.fetched} | skipped ${stats.skipped} | ` +
      `no wiki ${stats.noWiki} | failed ${stats.failed}  in ${fmtMs(Date.now() - t0)}`,
  );
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  ${f.slug}: ${f.error}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

/* ------------------------------------------------------------------ cli */

const USAGE = `codewiki.mjs — collector for codewiki.google

  node codewiki.mjs list  [--limit N] [--expand] [--expand-limit N] [--out FILE]
      --limit N         result cap for the base query (default 20000; the gateway
                        times out at 60 s, so ~25000 is the hard ceiling)
      --expand          union extra a-z/0-9 queries (there is no offset parameter)
      --expand-limit N  result cap per expansion query (default 5000)
      --out FILE        default <tool dir>/repos.json

  node codewiki.mjs fetch [owner/repo ...] [--from FILE] [--concurrency N]
                          [--limit N] [--out DIR] [--force]
      --from FILE       repo list written by \`list\` (or a plain JSON array)
      --concurrency N   default 3, hard cap 4
      --limit N         only process the first N repos
      --out DIR         default <tool dir>/staged
      --force           restage even if already complete
`;

const [, , cmd, ...rest] = process.argv;
const { flags, positional } = parseArgs(rest);

try {
  if (cmd === 'list') await cmdList(flags);
  else if (cmd === 'fetch') await cmdFetch(flags, positional);
  else {
    console.log(USAGE);
    process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
