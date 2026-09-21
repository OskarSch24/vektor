import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def load_native_bridge_mock() -> str:
    smoke_path = Path(__file__).with_name("cursor_functional_smoke.py")
    spec = importlib.util.spec_from_file_location("cursor_functional_smoke", smoke_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Smoke-Test-Fixture konnte nicht geladen werden")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NATIVE_BRIDGE_MOCK + READINESS_PROBE


READINESS_PROBE = r"""
(() => {
  const encode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const resolve = (id, data) => setTimeout(() => {
    window.databaseStudio?.__resolve?.(id, encode({ ok: true, data }));
  }, 0);
  const encodeCall = (path) => encode({
    method: 'GET',
    path,
    query: {},
    body: '',
  });

  window.__workspaceReadiness = {
    readyMessages: [],
    hooksAtReady: null,
    dispatchedAtReady: [],
    dispatchErrors: [],
    replies: {},
  };

  window.webkit.messageHandlers.api.postMessage = (message) => {
    const { id, method, params = {} } = message;
    if (method === 'reply') {
      window.__workspaceReadiness.replies[String(params.callId)] = {
        status: params.status,
        json: params.json,
      };
      resolve(id, null);
      return;
    }
    if (method === 'status' || method === 'start' || method === 'setAllowWrites') {
      resolve(id, {
        running: true,
        port: 8793,
        token: 'readiness-test-token',
        descriptorPath: '/tmp/database-studio-readiness-api.json',
        allowWrites: false,
        allowWritesByAdapter: { graph: false, sqlite: false, vault: false },
      });
      return;
    }
    resolve(id, null);
  };

  window.webkit.messageHandlers.appReady.postMessage = (message) => {
    const bridge = window.databaseStudio;
    const probe = window.__workspaceReadiness;
    probe.readyMessages.push(message);
    probe.hooksAtReady = {
      apiRequest: typeof bridge?.__apiRequest === 'function',
      graphIngest: typeof bridge?.onIngest === 'function',
      nativeOpen: typeof bridge?.openFile === 'function',
    };

    const healthCalls = [
      [9801, '/api/v1/sqlite/health'],
      [9802, '/api/v1/graph/health'],
      [9803, '/api/v1/vault/health'],
    ];
    for (const [id, path] of healthCalls) {
      try {
        bridge.__apiRequest(id, encodeCall(path));
        probe.dispatchedAtReady.push({ id, path });
      } catch (error) {
        probe.dispatchErrors.push(`${path}: ${error?.message || error}`);
      }
    }
  };
})();
"""


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1024, "height": 700})
        browser_errors: list[str] = []
        page.on("pageerror", lambda error: browser_errors.append(str(error)))
        page.on(
            "console",
            lambda message: browser_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.add_init_script(load_native_bridge_mock())
        page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))

        page.wait_for_function(
            """
            () => {
              const probe = window.__workspaceReadiness;
              return probe?.readyMessages.length === 1
                && Object.keys(probe.replies).length === 3;
            }
            """,
            timeout=15_000,
        )
        probe = page.evaluate("() => window.__workspaceReadiness")
        browser.close()

    assert probe["readyMessages"] == [{"status": "ready"}], probe
    assert probe["hooksAtReady"] == {
        "apiRequest": True,
        "graphIngest": True,
        "nativeOpen": True,
    }, probe
    assert probe["dispatchErrors"] == [], probe
    assert [call["path"] for call in probe["dispatchedAtReady"]] == [
        "/api/v1/sqlite/health",
        "/api/v1/graph/health",
        "/api/v1/vault/health",
    ], probe

    for adapter, request_id in (("sqlite", 9801), ("graph", 9802), ("vault", 9803)):
        reply = probe["replies"].get(str(request_id))
        assert reply is not None, f"{adapter} health hat bei appReady nicht geantwortet: {probe}"
        payload = json.loads(reply["json"])
        serialized = json.dumps(payload, ensure_ascii=False).lower()
        assert "noch nicht bereit" not in serialized, (
            f"{adapter} war bei appReady noch nicht bereit: {reply}"
        )

    assert not browser_errors, "Browser errors: " + " | ".join(browser_errors)
    print("workspace readiness regression: ok")


if __name__ == "__main__":
    main()
