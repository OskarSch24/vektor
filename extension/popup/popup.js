/**
 * The popup. Three jobs, in this order: say whether the app is reachable, show
 * what will be sent, and send it.
 *
 * Everything expensive — reading the page, talking to the app — goes through
 * the service worker, so closing the popup mid-flight does not abort the send.
 */

const elements = {
  usage: document.getElementById('usage'),
  usageValue: document.getElementById('usage-value'),
  thumb: document.getElementById('thumb'),
  title: document.getElementById('page-title'),
  host: document.getElementById('page-host'),
  chips: document.getElementById('chips'),
  project: document.getElementById('project'),
  database: document.getElementById('database'),
  newDatabaseField: document.getElementById('new-database-field'),
  newDatabase: document.getElementById('new-database'),
  convert: document.getElementById('convert'),
  convertLabel: document.getElementById('convert-label'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  portLabel: document.getElementById('port-label'),
  options: document.getElementById('options'),
  mapSite: document.getElementById('map-site'),
};

/**
 * Platforms where whole-site mode is switched off, mirroring
 * `src/lib/socialSites.ts` in the app. This copy only greys out the toggle so
 * the reason is visible before clicking; the app makes the actual decision.
 */
const SOCIAL_HOSTS = {
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'threads.net': 'Threads',
  'threads.com': 'Threads',
  'tiktok.com': 'TikTok',
  'x.com': 'X',
  'twitter.com': 'X',
  'linkedin.com': 'LinkedIn',
  'reddit.com': 'Reddit',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'pinterest.com': 'Pinterest',
  'pinterest.de': 'Pinterest',
  'snapchat.com': 'Snapchat',
  'tumblr.com': 'Tumblr',
  'bsky.app': 'Bluesky',
  'mastodon.social': 'Mastodon',
  'twitch.tv': 'Twitch',
  'vk.com': 'VK',
  'weibo.com': 'Weibo',
  'telegram.org': 'Telegram',
  't.me': 'Telegram',
  'discord.com': 'Discord',
  'quora.com': 'Quora',
  'medium.com': 'Medium',
};

function socialPlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const [candidate, label] of Object.entries(SOCIAL_HOSTS)) {
    if (host === candidate || host.endsWith('.' + candidate)) return label;
  }
  return null;
}

const KIND_LABEL = { website: 'Website', video: 'Video', social: 'Social Post' };

let currentTab = null;
let extracted = null;
let projectList = [];
let targetList = [];

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: 'Keine Antwort vom Hintergrunddienst.' });
    });
  });
}

function setStatus(tone, text, busy = false) {
  elements.status.className = `status${tone ? ` ${tone}` : ''}`;
  elements.status.firstElementChild.className = busy ? 'spinner' : 'dot';
  elements.statusText.textContent = text;
}

function addChip(text, variant) {
  const chip = document.createElement('span');
  chip.className = variant ? `chip ${variant}` : 'chip';
  chip.textContent = text;
  elements.chips.appendChild(chip);
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// MARK: - Boot

async function init() {
  const stored = await chrome.storage.sync.get({ port: 8787, defaultTargetId: '' });
  elements.portLabel.textContent = `127.0.0.1:${stored.port}`;

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const readable = currentTab && /^https?:/.test(currentTab.url ?? '');

  if (readable) {
    elements.title.textContent = currentTab.title || currentTab.url;
    elements.host.textContent = hostOf(currentTab.url);
  } else {
    elements.title.textContent = 'Diese Seite lässt sich nicht auslesen';
    elements.host.textContent = currentTab?.url ?? '';
    elements.mapSite.disabled = true;
  }

  // The pickers describe the app, not the page, so they are filled even when
  // the current tab cannot be read — otherwise opening the popup on a
  // chrome:// page leaves them empty and looks like the app is out of sync.
  // Both halves are independent, so they run together.
  await Promise.all([
    checkApp(stored.defaultTargetId),
    readable ? readPage() : Promise.resolve(),
  ]);

  if (!readable) {
    setStatus('error', 'Chrome erlaubt keinen Zugriff auf interne Seiten.');
  }

  startLiveSync();
}

/**
 * Keeps the pickers current while the popup is open.
 *
 * A popup normally closes the moment it loses focus, so this rarely fires — but
 * it does when the popup is detached for inspection, and it costs one request
 * to the loopback interface. Adding a project in the app therefore shows up
 * here without reopening anything.
 */
function startLiveSync() {
  const timer = setInterval(async () => {
    if (userIsChoosing()) return;
    const before = describeDestinations();
    await loadDestinations(undefined, undefined, { quiet: true });
    if (describeDestinations() !== before) {
      setStatus('ok', 'Projektliste aktualisiert.');
    }
  }, 4000);

  window.addEventListener('unload', () => clearInterval(timer));
}

/**
 * True while the user is busy with the pickers.
 *
 * Refilling a `<select>` closes its open dropdown — on macOS the native menu
 * disappears the moment its options are replaced. With a refresh every four
 * seconds that reads as a menu that shuts itself, and half-typed names for a
 * new database were being wiped along with it. So the sync waits its turn.
 */
function userIsChoosing() {
  const active = document.activeElement;
  if (active === elements.project || active === elements.database || active === elements.newDatabase) {
    return true;
  }
  // Naming a new database is a state to protect even without focus: the field
  // is only on screen because `__new__` is selected, and a refresh hides it.
  if (elements.database.value === NEW_DATABASE) return true;
  return elements.newDatabase.value.trim() !== '';
}

/** A cheap fingerprint of the pickers, to notice when they really changed. */
function describeDestinations() {
  return [...elements.project.options].map((entry) => `${entry.value}:${entry.textContent}`).join('|');
}

async function checkApp(preferredTargetId) {
  setStatus('', 'Verbindung wird geprüft…', true);

  const status = await send({ type: 'status' });
  if (!status.ok) {
    // The button stays usable on purpose: a dead control tells the user
    // nothing, while pressing it reports exactly what went wrong.
    setStatus('error', status.error);
    return;
  }

  // A measurement, so it only ever grows and never changes colour: there is no
  // threshold at which the number means "you may not proceed".
  const tokens = status.data?.tokensUsed;
  if (typeof tokens === 'number') {
    elements.usageValue.textContent = compact(tokens);
    elements.usage.title = `${new Intl.NumberFormat('de-DE').format(tokens)} Token bisher verbraucht`;
  }

  const graphName = status.data?.graphName;
  const appName = status.data?.app || 'Vektor';
  setStatus('ok', graphName ? `Verbunden — offener Graph: ${graphName}` : `Mit ${appName} verbunden`);

  await loadDestinations(preferredTargetId, graphName);
}

/**
 * Fills the two pickers: a project on the left, the graph files inside it on
 * the right. Configured targets — a Neo4j instance, a fixed file — appear as
 * projects of their own, since from here they are just another destination.
 */
async function loadDestinations(preferredTargetId, graphName, options = {}) {
  const [projects, targets] = await Promise.all([
    send({ type: 'projects' }),
    send({ type: 'targets' }),
  ]);

  // A refresh that cannot reach the app leaves the pickers as they are rather
  // than emptying them.
  if (!projects.ok && options.quiet) return;

  projectList = projects.ok && Array.isArray(projects.data?.projects) ? projects.data.projects : [];
  targetList = targets.ok && Array.isArray(targets.data?.targets) ? targets.data.targets : [];

  // What the user picked survives a refresh; only a destination that has
  // actually disappeared falls back.
  const keepProject = options.quiet ? elements.project.value : '';
  const keepDatabase = options.quiet ? elements.database.value : '';

  const openGraph = graphName ?? projects.data?.openGraph ?? '';
  const nodeCount = projects.data?.nodeCount;
  // Saying how big the open graph is makes "which one is open?" answerable
  // from the popup, without switching to the app.
  const openLabel = openGraph
    ? `Offener Graph — ${openGraph}${typeof nodeCount === 'number' ? ` (${nodeCount} Knoten)` : ''}`
    : 'Offener Graph';

  elements.project.textContent = '';
  elements.project.appendChild(option('', openLabel));

  for (const project of projectList) {
    const count = project.graphs?.length ?? 0;
    elements.project.appendChild(
      option(`project:${project.id}`, `${project.name} (${count})`)
    );
  }

  for (const target of targetList) {
    elements.project.appendChild(option(`target:${target.id}`, target.name));
  }

  const stored = await chrome.storage.sync.get({ lastProject: '', lastDatabase: '' });
  const preferred =
    keepProject ||
    stored.lastProject ||
    (preferredTargetId ? `target:${preferredTargetId}` : '') ||
    (targets.data?.defaultTargetId ? `target:${targets.data.defaultTargetId}` : '');

  if (preferred && [...elements.project.options].some((entry) => entry.value === preferred)) {
    elements.project.value = preferred;
  }

  syncDatabases(keepDatabase || stored.lastDatabase);
}

/** The right-hand picker only means something for a project of graph files. */
function syncDatabases(preferredPath) {
  const value = elements.project.value;
  elements.database.textContent = '';

  if (!value.startsWith('project:')) {
    elements.database.appendChild(
      option('', value === '' ? 'der offene Graph' : 'vom Ziel bestimmt')
    );
    elements.database.disabled = true;
    return;
  }

  const project = projectList.find((entry) => `project:${entry.id}` === value);
  const graphs = project?.graphs ?? [];

  for (const graph of graphs) {
    elements.database.appendChild(option(graph.path, graph.name.replace(/\.graph$/i, '')));
  }
  // A project is a folder; a database is created by writing into it. So a new
  // one is always on offer — and the only choice in a folder that has none yet.
  elements.database.appendChild(option(NEW_DATABASE, '＋ Neue Datenbank…'));
  elements.database.disabled = false;

  if (preferredPath === NEW_DATABASE) {
    // "New database" is a choice like any other and has to survive a refresh —
    // otherwise the picker snaps back to an existing file mid-typing.
    elements.database.value = NEW_DATABASE;
  } else if (preferredPath && graphs.some((graph) => graph.path === preferredPath)) {
    elements.database.value = preferredPath;
  } else if (graphs.length === 0) {
    elements.database.value = NEW_DATABASE;
  }
  syncNewDatabaseField();
}

const NEW_DATABASE = '__new__';

function syncNewDatabaseField() {
  const wantsNew = elements.database.value === NEW_DATABASE && !elements.database.disabled;
  elements.newDatabaseField.classList.toggle('hidden', !wantsNew);
  if (wantsNew && !elements.newDatabase.value) elements.newDatabase.focus();
}

/** The absolute path the chosen database lives at, or will live at. */
function chosenDatabasePath() {
  const value = elements.database.value;
  if (!elements.project.value.startsWith('project:')) return undefined;
  if (value !== NEW_DATABASE) return value || undefined;

  const project = projectList.find((entry) => `project:${entry.id}` === elements.project.value);
  const name = elements.newDatabase.value.trim().replace(/\.graph$/i, '').replace(/[\/\\:]/g, '-');
  if (!project || !name) return undefined;
  return `${project.path.replace(/\/$/, '')}/${name}.graph`;
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

async function readPage() {
  const result = await send({ type: 'extract', tabId: currentTab.id });

  if (!result.ok) {
    elements.host.textContent = result.error;
    setStatus('error', result.error);
    return;
  }

  // Reading the page is the only hard requirement for converting.
  elements.convert.disabled = false;

  extracted = result.data;
  elements.title.textContent = extracted.title || currentTab.title;
  elements.host.textContent = hostOf(extracted.url);

  // The thumbnail starts hidden and only appears once it has actually decoded.
  // An <img> without a usable source renders as a broken-image glyph, which
  // looks like a fault in the extension rather than a page without a picture.
  const thumbnail = absoluteUrl(
    extracted.video?.thumbnail || extracted.meta?.['og:image'],
    extracted.url
  );
  if (thumbnail) {
    elements.thumb.onload = () => elements.thumb.classList.remove('hidden');
    elements.thumb.onerror = () => elements.thumb.classList.add('hidden');
    elements.thumb.src = thumbnail;
  }

  elements.chips.textContent = '';
  addChip(KIND_LABEL[extracted.kind] ?? extracted.kind, extracted.kind);

  if (extracted.video?.durationSeconds) {
    addChip(formatDuration(extracted.video.durationSeconds));
  }
  if (extracted.text) {
    addChip(`${new Intl.NumberFormat('de-DE').format(countWords(extracted.text))} Wörter`);
  }
  if (extracted.post?.author) {
    addChip(extracted.post.author.slice(0, 24));
  }
  if (extracted.jsonLd?.length) {
    addChip(`${extracted.jsonLd.length}× JSON-LD`);
  }

  // Videos are the expensive case; saying so up front beats a surprise later.
  if (extracted.kind === 'video') {
    elements.convertLabel.textContent = 'Video konvertieren';
  }

  // Whole-site mode is pointless on a platform with no bounded page count.
  const platform = socialPlatform(extracted.url);
  if (platform) {
    elements.mapSite.checked = false;
    elements.mapSite.disabled = true;
    elements.mapSite.closest('.toggle').classList.add('disabled');
    elements.mapSite.parentElement.querySelector('em').textContent =
      `Für ${platform} abgeschaltet — die Plattform hat keine abzählbare Zahl an Seiten. ` +
      'Dieser Beitrag lässt sich normal konvertieren.';
  }

  elements.mapSite.addEventListener('change', () => {
    elements.convertLabel.textContent = elements.mapSite.checked
      ? 'Website abbilden'
      : extracted.kind === 'video'
        ? 'Video konvertieren'
        : 'Konvertieren';
  });

}

// MARK: - Convert

elements.convert.addEventListener('click', async () => {
  if (elements.project.value.startsWith('project:') && !chosenDatabasePath()) {
    setStatus('error', 'Bitte einen Namen für die neue Datenbank angeben.');
    elements.newDatabase.focus();
    return;
  }
  elements.convert.disabled = true;
  elements.convertLabel.textContent = 'Wird gesendet…';
  setStatus('', 'Wird an Vektor übergeben…', true);

  const choice = elements.project.value;
  const result = await send({
    type: 'convert',
    tabId: currentTab.id,
    targetId: choice.startsWith('target:') ? choice.slice('target:'.length) : undefined,
    targetPath: chosenDatabasePath(),
    mapSite: elements.mapSite.checked,
  });

  if (!result.ok) {
    setStatus('error', result.error);
    elements.convert.disabled = false;
    elements.convertLabel.textContent = 'Erneut versuchen';
    return;
  }

  setStatus(
    'ok',
    elements.mapSite.checked
      ? 'Übergeben — die Seitenliste öffnet sich in der App unter „Import“.'
      : 'Übergeben — der Fortschritt steht in der App unter „Import“.'
  );
  elements.convertLabel.textContent = 'Gesendet';
  await chrome.storage.sync.set({
    lastProject: elements.project.value,
    lastDatabase: elements.database.value,
  });

  // Long enough to read the confirmation, short enough not to be in the way.
  setTimeout(() => window.close(), 1400);
});

elements.project.addEventListener('change', () => syncDatabases(''));
elements.database.addEventListener('change', syncNewDatabaseField);
elements.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

/** Resolves a possibly relative image path against the page it came from. */
function absoluteUrl(value, base) {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url ?? '';
  }
}

/** Short form for a counter that runs into the millions. */
function compact(value) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} Mio.`;
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

void init();
