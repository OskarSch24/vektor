import base64
import importlib.util
import json
import os
from pathlib import Path
from typing import Dict, Optional

from playwright.sync_api import Page, expect, sync_playwright


def load_fixture_module():
    fixture_path = Path(__file__).with_name("unified_workspace_regression.py")
    spec = importlib.util.spec_from_file_location("unified_workspace_regression", fixture_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unified-Workspace-Fixture konnte nicht geladen werden")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FIXTURE = load_fixture_module()


SAVE_AS_OVERRIDE = r"""
(() => {
  const baseRpc = window.webkit.messageHandlers.rpc.postMessage.bind(
    window.webkit.messageHandlers.rpc
  );
  const encode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const reply = (id, data) => setTimeout(() => {
    window.databaseStudio?.__resolve?.(id, encode({ ok: true, data }));
  }, 0);

  window.__savedFiles = [];
  window.webkit.messageHandlers.rpc.postMessage = (message) => {
    if (message.channel === 'files' && message.method === 'saveAs') {
      const saved = {
        path: `/fixtures/${message.params?.suggestedName || 'saved.graph'}`,
        contents: message.params?.contents || '',
      };
      window.__savedFiles.push(saved);
      reply(message.id, { path: saved.path });
      return;
    }
    baseRpc(message);
  };
})();
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


def open_page(browser) -> tuple[Page, list[str]]:
    page = browser.new_page(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "console",
        lambda message: errors.append(message.text) if message.type == "error" else None,
    )
    page.add_init_script(FIXTURE.load_native_bridge_mock() + SAVE_AS_OVERRIDE)
    page.route(
        "**/__fixture/*",
        lambda route: route.fulfill(
            status=200,
            content_type="text/csv",
            body={
                "customers.csv": "id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
                "orders.csv": "id,customer,total\n1,Ada,42\n2,Grace,75\n",
            }[route.request.url.rsplit("/", 1)[-1]],
        ),
    )
    page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:54747"))
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
    return page, errors


def dirty_marker(page: Page, label: str):
    return page.get_by_role("button", name=f'Tab „{label}“ schließen').locator('span[aria-hidden="true"]')


def execute_sql_mutation(page: Page, sql: str) -> None:
    page.get_by_role("button", name="SQL", exact=True).click()
    editor = page.get_by_role("textbox", name="SQL-Editor")
    editor.fill(sql)
    page.get_by_role("button", name="Ausführen").click()
    expect(page.get_by_text("1 Zeile geändert", exact=False).first).to_be_visible()


def assert_table_dirty_close_and_export(browser) -> None:
    page, errors = open_page(browser)

    page.locator('[data-source-path="/fixtures/customers.csv"]').click()
    expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
    expect(page.get_by_role("tab", name="customers.csv", exact=True)).to_have_attribute(
        "aria-selected", "true"
    )

    execute_sql_mutation(
        page,
        "INSERT INTO customers (id, name, city) VALUES (3, 'Linus', 'Helsinki');",
    )
    expect(dirty_marker(page, "customers.csv")).to_be_visible()

    page.keyboard.press("Meta+w")
    dialog = page.get_by_role("alertdialog")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_text("customers.csv", exact=False)).to_be_visible()
    dialog.get_by_role("button", name="Abbrechen").click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role("tab", name="customers.csv", exact=True)).to_be_visible()
    expect(dirty_marker(page, "customers.csv")).to_be_visible()

    # A regular Explorer click may replace a clean tab, but must preserve a
    # dirty editor and place the requested file beside it.
    page.locator('[data-source-path="/fixtures/orders.csv"]').click()
    expect(page.get_by_role("tab", name="orders.csv", exact=True)).to_have_attribute(
        "aria-selected", "true"
    )
    expect(page.get_by_role("tab", name="customers.csv", exact=True)).to_be_visible()
    expect(dirty_marker(page, "customers.csv")).to_be_visible()
    expect(page.get_by_role("tab")).to_have_count(2)

    page.get_by_role("tab", name="customers.csv", exact=True).click()
    expect(page.get_by_text("Linus", exact=True)).to_be_visible(timeout=10_000)
    page.locator('button[title="Datenbank als Datei sichern (.sqlite)"]').click()
    export_dialog = page.get_by_role("dialog")
    expect(export_dialog.get_by_text("Daten exportieren", exact=True)).to_be_visible()
    with page.expect_download() as download_info:
        export_dialog.get_by_role("button", name="Jetzt herunterladen").click()
    assert download_info.value.suggested_filename == "customers.sqlite"
    expect(dirty_marker(page, "customers.csv")).to_have_count(0)

    # Re-dirty the exported session and confirm the destructive branch really
    # closes it instead of merely dismissing the warning.
    execute_sql_mutation(
        page,
        "UPDATE customers SET city = 'Espoo' WHERE id = 3;",
    )
    expect(dirty_marker(page, "customers.csv")).to_be_visible()
    page.keyboard.press("Meta+w")
    dialog = page.get_by_role("alertdialog")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Änderungen verwerfen").click()
    expect(page.get_by_role("tab", name="customers.csv", exact=True)).to_have_count(0)
    expect(page.get_by_role("tab", name="orders.csv", exact=True)).to_have_attribute(
        "aria-selected", "true"
    )

    if errors:
        raise AssertionError("Browser errors in table dirty-state regression: " + " | ".join(errors))
    page.close()


def assert_pathless_graph_save_clears_dirty(browser) -> None:
    page, errors = open_page(browser)

    page.locator('[data-source-path="/fixtures/network.graph"]').click()
    expect(page.get_by_role("tab", name="network.graph", exact=True)).to_have_attribute(
        "aria-selected", "true"
    )
    expect(page.get_by_text("Person", exact=True).first).to_be_visible(timeout=10_000)

    page.locator('button[title="Neuen Graphen anlegen"]').click()
    expect(page.get_by_role("tab", name="Unbenannter Graph", exact=True)).to_have_attribute(
        "aria-selected", "true"
    )
    created = dispatch_api(
        page,
        9701,
        "POST",
        "/api/v1/graph/nodes",
        {
            "id": "unsaved-node",
            "labels": ["Test"],
            "properties": {"name": "Ungesichert"},
        },
    )
    assert created["status"] == 201, created
    expect(dirty_marker(page, "Unbenannter Graph")).to_be_visible()

    page.locator('button[title="Graph exportieren"]').click()
    expect(page.get_by_role("tab", name="Unbenannter Graph.graph", exact=True)).to_have_attribute(
        "aria-selected", "true"
    )
    expect(dirty_marker(page, "Unbenannter Graph.graph")).to_have_count(0)
    saved = page.evaluate("() => window.__savedFiles")
    assert len(saved) == 1, saved
    assert saved[0]["path"] == "/fixtures/Unbenannter Graph.graph", saved
    assert "unsaved-node" in saved[0]["contents"], saved

    if errors:
        raise AssertionError("Browser errors in graph dirty-state regression: " + " | ".join(errors))
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        assert_table_dirty_close_and_export(browser)
        assert_pathless_graph_save_clears_dirty(browser)
        browser.close()
    print("dirty state regression: ok")


if __name__ == "__main__":
    main()
