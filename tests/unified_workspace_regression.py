import base64
import importlib.util
import json
import os
from pathlib import Path
from typing import Dict, Optional

from playwright.sync_api import Page, expect, sync_playwright


AOF_ERROR = "AOF-Speicherstände werden erkannt, aber nicht direkt gestartet."


def load_native_bridge_mock() -> str:
    smoke_path = Path(__file__).with_name("cursor_functional_smoke.py")
    spec = importlib.util.spec_from_file_location("cursor_functional_smoke", smoke_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Smoke-Test-Fixture konnte nicht geladen werden")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NATIVE_BRIDGE_MOCK + ENHANCED_NATIVE_FIXTURES


ENHANCED_NATIVE_FIXTURES = rf"""
(() => {{
  const now = Date.now();
  const baseRpc = window.webkit.messageHandlers.rpc.postMessage.bind(window.webkit.messageHandlers.rpc);
  const project = {{
    id: '/fixtures',
    name: 'Beispielprojekt',
    path: '/fixtures',
    fileCount: 5,
    redisDatabaseCount: 2,
    children: [
      {{ kind: 'file', id: '/fixtures/customers.csv', path: '/fixtures/customers.csv', name: 'customers.csv', fileType: 'csv', size: 120, modified: now }},
      {{ kind: 'file', id: '/fixtures/orders.csv', path: '/fixtures/orders.csv', name: 'orders.csv', fileType: 'csv', size: 120, modified: now }},
      {{ kind: 'file', id: '/fixtures/network.graph', path: '/fixtures/network.graph', name: 'network.graph', fileType: 'graph', size: 240, modified: now }},
      {{ kind: 'file', id: '/fixtures/snapshot.rdb', path: '/fixtures/snapshot.rdb', name: 'snapshot.rdb', fileType: 'redis-rdb', size: 2048, modified: now }},
      {{ kind: 'file', id: '/fixtures/appendonly.aof', path: '/fixtures/appendonly.aof', name: 'appendonly.aof', fileType: 'redis-aof', size: 1024, modified: now }},
    ],
    redisDatabases: [],
  }};

  const encode = (value) => {{
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }};
  const hostReply = (id, data, error = null) => setTimeout(() => {{
    window.databaseStudio?.__resolve?.(id, encode(error ? {{ ok: false, error }} : {{ ok: true, data }}));
  }}, 0);
  const bulk = (value) => ({{ t: 'bulk', v: String(value) }});
  const array = (values = []) => ({{ t: 'array', v: values }});
  const nil = () => ({{ t: 'nil' }});

  window.__apiReplies = {{}};
  window.__healthSnapshots = {{}};
  window.__vaultClosed = {{ projects: [], redis: [] }};
  window.webkit.messageHandlers.api.postMessage = (message) => {{
    const {{ id, method, params = {{}} }} = message;
    if (method === 'reply') {{
      window.__apiReplies[String(params.callId)] = {{ status: params.status, json: params.json }};
      hostReply(id, null);
      return;
    }}
    if (method === 'health') {{
      window.__healthSnapshots[params.adapter] = params.health;
      hostReply(id, null);
      return;
    }}
    if (method === 'status' || method === 'start' || method === 'setAllowWrites') {{
      hostReply(id, {{
        running: true,
        port: 8793,
        token: 'test-token',
        descriptorPath: '/tmp/database-studio-test-api.json',
        allowWrites: true,
        allowWritesByAdapter: {{ graph: true, sqlite: true, vault: true }},
      }});
      return;
    }}
    hostReply(id, null);
  }};

  window.webkit.messageHandlers.rpc.postMessage = (message) => {{
    const {{ id, channel, method, params = {{}} }} = message;
    if (channel === 'projects' && method === 'list') return hostReply(id, [project]);
    if (channel === 'projects' && method === 'refresh') return hostReply(id, project);
    if (channel === 'projects' && method === 'close') {{
      window.__vaultClosed.projects.push(params.sessionId);
      return hostReply(id, null);
    }}
    if (channel === 'projects' && method === 'open') {{
      if (params.path === '/fixtures/appendonly.aof') return hostReply(id, null, '{AOF_ERROR}');
      if (params.path === '/fixtures/snapshot.rdb') {{
        return hostReply(id, {{
          sessionId: 'snapshot-session',
          host: '127.0.0.1',
          port: 6401,
          db: 0,
          name: 'snapshot.rdb',
          temporary: true,
          immutable: true,
          databases: [{{ index: 0, keyCount: 0, expires: 0 }}],
        }});
      }}
    }}
    if (channel === 'redis' && method === 'connect') {{
      return hostReply(id, {{ connectionId: 'redis-snapshot', host: params.host, port: params.port, db: params.db ?? 0 }});
    }}
    if (channel === 'redis' && method === 'close') {{
      window.__vaultClosed.redis.push(params.connectionId);
      return hostReply(id, null);
    }}
    if (channel === 'redis' && method === 'command') {{
      const command = String(params.args?.[0] ?? '').toUpperCase();
      if (command === 'COMMAND') return hostReply(id, {{ value: array() }});
      if (command === 'SCAN') return hostReply(id, {{ value: array([bulk('0'), array()]) }});
      if (command === 'TYPE') return hostReply(id, {{ value: bulk('none') }});
      return hostReply(id, {{ value: nil() }});
    }}
    if (channel === 'redis' && method === 'pipeline') {{
      const commands = params.commands ?? [];
      const isFactsRead = String(commands[0]?.[0] ?? '').toUpperCase() === 'INFO';
      const values = isFactsRead
        ? [
            bulk('redis_version:7.4.0\nredis_mode:standalone\nrole:master\nused_memory:0\nused_memory_human:0B\nuptime_in_seconds:1\naof_enabled:0\nrdb_last_save_time:0\nrdb_changes_since_last_save:0'),
            array(),
            array([bulk('databases'), bulk('1')]),
          ]
        : commands.map(() => nil());
      return hostReply(id, {{ values }});
    }}
    return baseRpc(message);
  }};
}})();
"""


def encoded_call(method: str, path: str, body: Optional[Dict] = None) -> str:
    call = {
        "method": method,
        "path": path,
        "query": {},
        "body": json.dumps(body) if body is not None else "",
    }
    return base64.b64encode(json.dumps(call).encode()).decode()


def dispatch_api(page: Page, request_id: int, method: str, path: str, body: Optional[Dict] = None) -> dict:
    page.evaluate(
        "([id, payload]) => window.databaseStudio.__apiRequest(id, payload)",
        [request_id, encoded_call(method, path, body)],
    )
    page.wait_for_function(
        "id => Boolean(window.__apiReplies?.[String(id)])",
        arg=request_id,
        timeout=10_000,
    )
    reply = page.evaluate(
        "id => { const key = String(id); const value = window.__apiReplies[key]; delete window.__apiReplies[key]; return value; }",
        request_id,
    )
    return {"status": reply["status"], "payload": json.loads(reply["json"])}


def open_page(browser):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.add_init_script(load_native_bridge_mock())
    page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
    return page, errors


def node_ids(page: Page, request_id: int) -> set[str]:
    reply = dispatch_api(page, request_id, "GET", "/api/v1/graph/nodes")
    assert reply["status"] == 200, reply
    return {node["id"] for node in reply["payload"]["nodes"]}


def assert_pathless_graph_sessions(browser) -> None:
    page, errors = open_page(browser)

    page.locator('[data-source-path="/fixtures/network.graph"]').click()
    expect(page.get_by_role("tab", name="network.graph", exact=True)).to_have_attribute("aria-selected", "true")
    expect(page.get_by_text("Person", exact=True).first).to_be_visible(timeout=10_000)

    page.get_by_role("button", name="Neuen Graphen anlegen").click()
    expect(page.get_by_role("tab", name="Unbenannter Graph", exact=True)).to_have_attribute("aria-selected", "true")
    alpha = dispatch_api(
        page,
        9201,
        "POST",
        "/api/v1/graph/nodes",
        {"id": "alpha-only", "labels": ["AlphaSession"], "properties": {"name": "Alpha"}},
    )
    assert alpha["status"] == 201, alpha
    assert node_ids(page, 9202) == {"alpha-only"}

    page.get_by_test_id("new-tab").click()
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    page.locator('[data-source-path="/fixtures/network.graph"]').click()
    expect(page.get_by_text("Person", exact=True).first).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Neuen Graphen anlegen").click()
    beta = dispatch_api(
        page,
        9203,
        "POST",
        "/api/v1/graph/nodes",
        {"id": "beta-only", "labels": ["BetaSession"], "properties": {"name": "Beta"}},
    )
    assert beta["status"] == 201, beta
    assert node_ids(page, 9204) == {"beta-only"}

    pathless_tabs = page.get_by_role("tab", name="Unbenannter Graph", exact=True)
    expect(pathless_tabs).to_have_count(2)
    pathless_tabs.nth(0).click()
    expect(pathless_tabs.nth(0)).to_have_attribute("aria-selected", "true")
    page.wait_for_timeout(100)
    assert node_ids(page, 9205) == {"alpha-only"}

    pathless_tabs.nth(1).click()
    expect(pathless_tabs.nth(1)).to_have_attribute("aria-selected", "true")
    page.wait_for_timeout(100)
    assert node_ids(page, 9206) == {"beta-only"}

    if errors:
        raise AssertionError("Browser errors in graph regression: " + " | ".join(errors))
    page.close()


def assert_adaptive_redis_workspace(browser) -> None:
    page, errors = open_page(browser)

    page.locator('[data-source-path="/fixtures/snapshot.rdb"]').click()
    expect(page.get_by_role("tab", name="snapshot.rdb", exact=True)).to_have_attribute("aria-selected", "true")
    expect(page.get_by_text("Original geschützt", exact=True)).to_be_visible(timeout=10_000)
    expect(page.get_by_text("snapshot.rdb", exact=True).last).to_be_visible()
    expect(page.get_by_text("Speicherstand im Explorer auswählen", exact=True)).to_have_count(0)
    expect(page.get_by_text("Neue Verbindung", exact=False)).to_have_count(0)
    expect(page.get_by_text("Projektübersicht", exact=False)).to_have_count(0)
    expect(page.locator(".database-workspace .project-sidebar")).to_have_count(0)
    expect(page.get_by_text("Explorer", exact=True)).to_have_count(1)

    page.locator('[data-source-path="/fixtures/appendonly.aof"]').click()
    expect(page.get_by_role("tab", name="appendonly.aof", exact=True)).to_have_attribute("aria-selected", "true")
    error = page.get_by_text(AOF_ERROR, exact=True)
    expect(error).to_be_visible(timeout=10_000)
    page.wait_for_timeout(250)
    expect(error).to_be_visible()

    error_box = error.bounding_box()
    workspace_box = page.locator(".database-workspace").bounding_box()
    assert error_box is not None and workspace_box is not None
    assert error_box["x"] >= workspace_box["x"]
    assert error_box["y"] >= workspace_box["y"]
    assert error_box["x"] + error_box["width"] <= workspace_box["x"] + workspace_box["width"]
    assert error_box["y"] + error_box["height"] <= workspace_box["y"] + workspace_box["height"]
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")

    if errors:
        raise AssertionError("Browser errors in Redis regression: " + " | ".join(errors))
    page.close()


def assert_vault_owner_close_disposes_resources(browser) -> None:
    page, errors = open_page(browser)

    page.locator('[data-source-path="/fixtures/snapshot.rdb"]').click()
    expect(page.get_by_text("Original geschützt", exact=True)).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Tab „snapshot.rdb“ schließen").click()
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()

    page.wait_for_function(
        "() => window.__vaultClosed.projects.includes('snapshot-session')"
        " && window.__vaultClosed.redis.includes('redis-snapshot')"
        " && window.__healthSnapshots.vault?.connected === false",
        timeout=10_000,
    )

    if errors:
        raise AssertionError("Browser errors in Redis close regression: " + " | ".join(errors))
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        assert_pathless_graph_sessions(browser)
        assert_adaptive_redis_workspace(browser)
        assert_vault_owner_close_disposes_resources(browser)
        browser.close()
    print("unified workspace regressions: ok")


if __name__ == "__main__":
    main()
