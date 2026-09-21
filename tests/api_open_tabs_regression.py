import base64
import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


def load_native_bridge_mock() -> str:
    smoke_path = Path(__file__).with_name("cursor_functional_smoke.py")
    spec = importlib.util.spec_from_file_location("cursor_functional_smoke", smoke_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Smoke-Test-Fixture konnte nicht geladen werden")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NATIVE_BRIDGE_MOCK


def dispatch_open(page: Page, adapter: str, path: str, request_id: int) -> None:
    call = {
        "method": "POST",
        "path": f"/api/v1/{adapter}/open",
        "query": {},
        "body": json.dumps({"path": path}),
    }
    encoded = base64.b64encode(json.dumps(call).encode()).decode()
    page.evaluate(
        "([id, payload]) => window.databaseStudio.__apiRequest(id, payload)",
        [request_id, encoded],
    )


def install_csv_fixture(page: Page) -> None:
    page.route(
        "**/__fixture/customers.csv",
        lambda route: route.fulfill(
            status=200,
            content_type="text/csv",
            body="id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
        ),
    )


def assert_fresh_tab(page: Page) -> None:
    page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    expect(page.get_by_role("tab")).to_have_count(1)


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        sqlite_page = browser.new_page(viewport={"width": 1024, "height": 700})
        sqlite_page.add_init_script(load_native_bridge_mock())
        install_csv_fixture(sqlite_page)
        assert_fresh_tab(sqlite_page)
        dispatch_open(sqlite_page, "sqlite", "/fixtures/customers.csv", 9101)

        sqlite_tab = sqlite_page.get_by_role("tab", name="customers.csv", exact=True)
        expect(sqlite_tab).to_be_visible(timeout=10_000)
        expect(sqlite_tab).to_have_attribute("aria-selected", "true")
        expect(sqlite_page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
        expect(sqlite_page.get_by_role("heading", name="Neuer Tab")).to_have_count(0)
        sqlite_page.close()

        graph_page = browser.new_page(viewport={"width": 1024, "height": 700})
        graph_page.add_init_script(load_native_bridge_mock())
        assert_fresh_tab(graph_page)
        dispatch_open(graph_page, "graph", "/fixtures/network.graph", 9102)

        graph_tab = graph_page.get_by_role("tab", name="network.graph", exact=True)
        expect(graph_tab).to_be_visible(timeout=10_000)
        expect(graph_tab).to_have_attribute("aria-selected", "true")
        expect(graph_page.get_by_text("Person", exact=True).first).to_be_visible(timeout=10_000)
        expect(graph_page.get_by_role("heading", name="Neuer Tab")).to_have_count(0)

        print("api open root tabs regression: ok")
        browser.close()


if __name__ == "__main__":
    main()
