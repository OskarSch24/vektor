import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const workerSource = fs.readFileSync(
  path.join(root, 'extension/background/service-worker.js'),
  'utf8'
);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.match(manifest.name, /^Vektor/);
assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));

let messageListener;
const requests = [];
const fakeChrome = {
  runtime: {
    lastError: null,
    getManifest: () => manifest,
    onMessage: { addListener: (listener) => { messageListener = listener; } },
    onInstalled: { addListener: () => undefined },
  },
  storage: {
    sync: {
      get: async (defaults) => ({ ...defaults, port: 8787 }),
    },
  },
  scripting: {
    executeScript: async () => [{ result: { url: 'https://example.test', title: 'Example' } }],
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
  },
  contextMenus: {
    create: () => undefined,
    onClicked: { addListener: () => undefined },
  },
};

const responseFor = (url) => {
  if (url.endsWith('/status')) return { ok: true, app: 'Database Studio', version: '1.0.0' };
  if (url.endsWith('/projects')) return { projects: [] };
  if (url.endsWith('/targets')) return { targets: [] };
  if (url.endsWith('/ingest')) return { accepted: true, url: 'https://example.test' };
  throw new Error(`Unexpected endpoint: ${url}`);
};

const context = {
  chrome: fakeChrome,
  AbortController,
  console,
  fetch: async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(responseFor(url)),
    };
  },
  setTimeout: () => 1,
  clearTimeout: () => undefined,
};

vm.runInNewContext(workerSource, context, { filename: 'service-worker.js' });
assert.equal(typeof messageListener, 'function');

function send(message) {
  return new Promise((resolve) => {
    assert.equal(messageListener(message, {}, resolve), true);
  });
}

for (const type of ['status', 'projects', 'targets']) {
  const response = await send({ type });
  assert.equal(response.ok, true, `${type} should succeed`);
}

const ingestResponse = await send({ type: 'convert', tabId: 7, mapSite: false });
assert.equal(ingestResponse.ok, true);

assert.deepEqual(
  requests.map(({ url, options }) => [new URL(url).pathname, options.method]),
  [
    ['/status', 'GET'],
    ['/projects', 'GET'],
    ['/targets', 'GET'],
    ['/ingest', 'POST'],
  ]
);

for (const { url, options } of requests) {
  assert.equal(new URL(url).port, '8787');
  assert.equal(
    options.headers['X-Database-Studio-Client'],
    `Database Studio Extension/${manifest.version}`
  );
}

const ingestRequest = requests.at(-1);
assert.equal(JSON.parse(ingestRequest.options.body).url, 'https://example.test');
console.log('browser extension contract: ok');
