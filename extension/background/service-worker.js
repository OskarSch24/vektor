/**
 * The extension's only connection to the outside world: Vektor on
 * the loopback interface.
 *
 * Nothing here talks to a remote server. Page content goes to 127.0.0.1 and
 * nowhere else — which is the whole reason the model calls happen in the app
 * rather than in the browser.
 */

const DEFAULT_PORT = 8787;
const REQUEST_TIMEOUT_MS = 8000;
const CLIENT_ID = `Database Studio Extension/${chrome.runtime.getManifest().version}`;

async function endpoint() {
  const stored = await chrome.storage.sync.get({ port: DEFAULT_PORT });
  return `http://127.0.0.1:${stored.port}`;
}

/** fetch with a deadline — a hung app must not leave the popup spinning. */
async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${await endpoint()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Database-Studio-Client': CLIENT_ID,
        ...(options.headers ?? {}),
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status}: ${body.slice(0, 200) || response.statusText}`);
    }
    return body ? JSON.parse(body) : null;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Vektor antwortet nicht. Läuft die App?');
    }
    // A connection refused surfaces as a bare "Failed to fetch", which tells
    // the user nothing they can act on.
    if (err instanceof TypeError) {
      throw new Error('Vektor ist nicht erreichbar. App starten und Port prüfen.');
    }
    throw err;
  }
}

const api = {
  status: () => request('/status', { method: 'GET', timeoutMs: 2500 }),
  targets: () => request('/targets', { method: 'GET', timeoutMs: 2500 }),
  projects: () => request('/projects', { method: 'GET', timeoutMs: 4000 }),
  ingest: (payload) => request('/ingest', { method: 'POST', body: JSON.stringify(payload) }),
};

/** Runs the extraction script in a tab and returns its result. */
async function extract(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/extract.js'],
  });

  if (!result || result.result == null) {
    throw new Error('Diese Seite lässt sich nicht auslesen — Chrome blockiert interne Seiten.');
  }
  return result.result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // The listener has to return true synchronously for the async reply to be
  // delivered, so the work happens in a separate promise chain.
  (async () => {
    try {
      switch (message.type) {
        case 'status':
          sendResponse({ ok: true, data: await api.status() });
          break;
        case 'targets':
          sendResponse({ ok: true, data: await api.targets() });
          break;
        case 'projects':
          sendResponse({ ok: true, data: await api.projects() });
          break;
        case 'extract':
          sendResponse({ ok: true, data: await extract(message.tabId) });
          break;
        case 'convert': {
          const payload = await extract(message.tabId);
          const data = await api.ingest({
            ...payload,
            targetId: message.targetId,
            targetPath: message.targetPath,
            mapSite: message.mapSite === true,
          });
          await bumpBadge();
          sendResponse({ ok: true, data });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unbekannter Befehl: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

/** A short-lived badge confirming the send, since the popup closes on click. */
async function bumpBadge() {
  await chrome.action.setBadgeText({ text: '✓' });
  await chrome.action.setBadgeBackgroundColor({ color: '#30D158' });
  setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 3000);
}

// MARK: - Context menu

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'graph-studio-convert',
    title: 'An Vektor senden',
    contexts: ['page', 'video', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'graph-studio-convert' || !tab?.id) return;

  try {
    const payload = await extract(tab.id);
    // A right-click on a link means that link, not the page it sits on.
    if (info.linkUrl && info.linkUrl !== payload.url) {
      payload.url = info.linkUrl;
      payload.title = info.linkUrl;
      payload.kind = 'website';
      payload.text = undefined;
    }
    await api.ingest(payload);
    await bumpBadge();
  } catch (err) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF453A' });
    setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 4000);
    console.warn('Vektor:', err);
  }
});
