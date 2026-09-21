import base64
import importlib.util
import json
import os
import re
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


DELAY_MS = 700
SETTLE_MS = DELAY_MS + 700


def load_native_bridge_mock() -> str:
    smoke_path = Path(__file__).with_name("cursor_functional_smoke.py")
    spec = importlib.util.spec_from_file_location("cursor_functional_smoke", smoke_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Smoke-Test-Fixture konnte nicht geladen werden")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NATIVE_BRIDGE_MOCK


SLOW_STAGE_OVERRIDE = rf"""
(() => {{
  const baseRpc = window.webkit.messageHandlers.rpc.postMessage.bind(
    window.webkit.messageHandlers.rpc
  );
  window.webkit.messageHandlers.rpc.postMessage = (message) => {{
    if (
      message.channel === 'files'
      && message.method === 'stage'
      && message.params?.path === '/fixtures/customers.csv'
    ) {{
      setTimeout(() => baseRpc(message), {DELAY_MS});
      return;
    }}
    baseRpc(message);
  }};
  const baseApi = window.webkit.messageHandlers.api.postMessage.bind(
    window.webkit.messageHandlers.api
  );
  window.__apiReplies = {{}};
  window.webkit.messageHandlers.api.postMessage = (message) => {{
    if (message.method === 'reply') {{
      window.__apiReplies[String(message.params.callId)] = message.params;
    }}
    baseApi(message);
  }};
}})();
"""


SLOW_GRAPH_OVERRIDE = rf"""
(() => {{
  const baseRpc = window.webkit.messageHandlers.rpc.postMessage.bind(
    window.webkit.messageHandlers.rpc
  );
  window.webkit.messageHandlers.rpc.postMessage = (message) => {{
    if (
      message.channel === 'files'
      && message.method === 'read'
      && message.params?.path === '/fixtures/network.graph'
    ) {{
      setTimeout(() => baseRpc(message), {DELAY_MS});
      return;
    }}
    baseRpc(message);
  }};
  const baseApi = window.webkit.messageHandlers.api.postMessage.bind(
    window.webkit.messageHandlers.api
  );
  window.__apiReplies = {{}};
  window.webkit.messageHandlers.api.postMessage = (message) => {{
    if (message.method === 'reply') {{
      window.__apiReplies[String(message.params.callId)] = message.params;
    }}
    baseApi(message);
  }};
}})();
"""


SLOW_JSON_OVERRIDE = rf"""
(() => {{
  const baseFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {{
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url === 'https://fixtures.invalid/slow.json') {{
      return new Promise((resolve) => setTimeout(() => resolve(new Response(
        JSON.stringify([{{ id: 1, name: 'late row' }}]),
        {{ status: 200, headers: {{ 'Content-Type': 'application/json' }} }}
      )), {DELAY_MS}));
    }}
    return baseFetch(input, init);
  }};
}})();
"""


DEFERRED_PICKER_OVERRIDE = rf"""
(() => {{
  const baseRpc = window.webkit.messageHandlers.rpc.postMessage.bind(
    window.webkit.messageHandlers.rpc
  );
  window.webkit.messageHandlers.rpc.postMessage = (message) => {{
    if (message.channel === 'files' && message.method === 'pick') {{
      // Reuse the fixture bridge's `stage` response to resolve the picker with
      // a real StagedFile after a newer root navigation has already happened.
      setTimeout(() => baseRpc({{
        ...message,
        method: 'stage',
        params: {{ path: '/fixtures/customers.csv' }},
      }}), {DELAY_MS});
      return;
    }}
    baseRpc(message);
  }};
}})();
"""


def install_csv_routes(page: Page) -> None:
    fixtures = {
        "customers.csv": "id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
        "orders.csv": "id,customer,total\n1,Ada,42\n2,Grace,75\n",
    }
    page.route(
        "**/__fixture/*",
        lambda route: route.fulfill(
            status=200,
            content_type="text/csv",
            body=fixtures[route.request.url.rsplit("/", 1)[-1]],
        ),
    )


def open_page(browser, override: str = "") -> tuple[Page, list[str]]:
    page = browser.new_page(viewport={"width": 1024, "height": 700})
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "console",
        lambda message: errors.append(message.text) if message.type == "error" else None,
    )
    page.add_init_script(load_native_bridge_mock() + override)
    install_csv_routes(page)
    page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
    return page, errors


def assert_no_errors(errors: list[str], scenario: str) -> None:
    if errors:
        raise AssertionError(f"Browser errors in {scenario}: " + " | ".join(errors))


def api_health(page: Page, adapter: str, request_id: int) -> dict:
    call = {
        "method": "GET",
        "path": f"/api/v1/{adapter}/health",
        "query": {},
        "body": "",
    }
    encoded = base64.b64encode(json.dumps(call).encode()).decode()
    page.evaluate(
        "([id, payload]) => window.databaseStudio.__apiRequest(id, payload)",
        [request_id, encoded],
    )
    page.wait_for_function(
        "id => Boolean(window.__apiReplies?.[String(id)])",
        arg=request_id,
        timeout=10_000,
    )
    reply = page.evaluate(
        "id => window.__apiReplies[String(id)]",
        request_id,
    )
    assert reply["status"] == 200, reply
    return json.loads(reply["json"])


def assert_closed_slow_source_stays_closed(browser) -> None:
    page, errors = open_page(browser, SLOW_STAGE_OVERRIDE)

    page.locator('[data-source-path="/fixtures/customers.csv"]').click()
    customer_tab = page.get_by_role("tab", name="customers.csv", exact=True)
    expect(customer_tab).to_be_visible()
    page.get_by_role("button", name="Tab „customers.csv“ schließen").click()
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()

    page.wait_for_timeout(SETTLE_MS)
    expect(customer_tab).to_have_count(0)
    expect(page.get_by_role("tab")).to_have_count(1)
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    assert api_health(page, "sqlite", 9401) == {"loaded": False, "database": None}

    assert_no_errors(errors, "closed pending source")
    page.close()


def assert_closed_slow_graph_stays_unloaded(browser) -> None:
    page, errors = open_page(browser, SLOW_GRAPH_OVERRIDE)

    page.locator('[data-source-path="/fixtures/network.graph"]').click()
    graph_tab = page.get_by_role("tab", name="network.graph", exact=True)
    expect(graph_tab).to_be_visible()
    page.get_by_role("button", name="Tab „network.graph“ schließen").click()
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()

    page.wait_for_timeout(SETTLE_MS)
    expect(graph_tab).to_have_count(0)
    assert api_health(page, "graph", 9402)["loaded"] is False

    assert_no_errors(errors, "closed pending graph")
    page.close()


def assert_home_beats_slow_json_classification(browser) -> None:
    page, errors = open_page(browser, SLOW_JSON_OVERRIDE)

    page.locator('[data-source-path="/fixtures/customers.csv"]').click()
    expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
    page.evaluate(
        """
        () => window.databaseStudio.openFile(
          'https://fixtures.invalid/slow.json',
          'slow.json',
          '/fixtures/slow.json',
          false
        )
        """
    )
    page.locator('button[title="Neuen Datenraum öffnen"]').click()
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()

    page.wait_for_timeout(SETTLE_MS)
    expect(page.get_by_role("tab", name="slow.json", exact=True)).to_have_count(0)
    expect(page.get_by_role("tab", name="customers.csv", exact=True)).to_have_count(1)
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()

    assert_no_errors(errors, "slow JSON followed by Home")
    page.close()


def assert_newer_project_navigation_beats_picker(browser) -> None:
    page, errors = open_page(browser, DEFERRED_PICKER_OVERRIDE)

    page.get_by_role("button", name=re.compile(r"^Datei öffnen")).click()
    page.locator('[data-source-path="/fixtures/orders.csv"]').click()
    order_tab = page.get_by_role("tab", name="orders.csv", exact=True)
    expect(order_tab).to_have_attribute("aria-selected", "true")
    expect(page.locator('[data-table-name="orders"]')).to_be_visible(timeout=10_000)

    page.wait_for_timeout(SETTLE_MS)
    expect(page.get_by_role("tab", name="customers.csv", exact=True)).to_have_count(0)
    expect(order_tab).to_have_attribute("aria-selected", "true")
    expect(page.locator('[data-table-name="orders"]')).to_be_visible()

    assert_no_errors(errors, "deferred picker followed by project navigation")
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        assert_closed_slow_source_stays_closed(browser)
        assert_closed_slow_graph_stays_unloaded(browser)
        assert_home_beats_slow_json_classification(browser)
        assert_newer_project_navigation_beats_picker(browser)
        browser.close()

    print("workbench controller regressions: ok")


if __name__ == "__main__":
    main()
