/** Options page: the port, and a way to prove the app answers on it. */

const portInput = document.getElementById('port');
const status = document.getElementById('status');
const statusText = document.getElementById('status-text');
const CLIENT_ID = `Database Studio Extension/${chrome.runtime.getManifest().version}`;

function setStatus(tone, text, busy = false) {
  status.className = `status${tone ? ` ${tone}` : ''}`;
  status.firstElementChild.className = busy ? 'spinner' : 'dot';
  statusText.textContent = text;
}

async function load() {
  const stored = await chrome.storage.sync.get({ port: 8787 });
  portInput.value = stored.port;
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    setStatus('error', 'Bitte einen Port zwischen 1024 und 65535 angeben.');
    return;
  }
  await chrome.storage.sync.set({ port });
  setStatus('ok', `Gespeichert — die Erweiterung sendet jetzt an 127.0.0.1:${port}.`);
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus('', 'Wird geprüft…', true);

  // The port under test is the one in the field, not the saved one, so a value
  // can be tried out before committing to it.
  const port = Number(portInput.value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: controller.signal,
      headers: { 'X-Database-Studio-Client': CLIENT_ID },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setStatus(
      'ok',
      `${payload.app ?? 'Vektor'} ${payload.version ?? ''} antwortet` +
        (payload.graphName ? ` — offener Graph: ${payload.graphName}` : '')
    );
  } catch (err) {
    setStatus(
      'error',
      err.name === 'AbortError'
        ? 'Zeitüberschreitung — auf diesem Port antwortet nichts.'
        : 'Keine Verbindung. Läuft Vektor, und stimmt der Port?'
    );
  } finally {
    clearTimeout(timer);
  }
});

void load();
