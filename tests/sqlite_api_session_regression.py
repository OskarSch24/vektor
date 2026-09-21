import base64
import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def load_native_bridge_mock() -> str:
    smoke_path = Path(__file__).with_name("cursor_functional_smoke.py")
    spec = importlib.util.spec_from_file_location("cursor_functional_smoke", smoke_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Smoke-Test-Fixture konnte nicht geladen werden")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.NATIVE_BRIDGE_MOCK


def main() -> None:
    fixture_csv = {
        "customers.csv": "id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
        "orders.csv": "id,customer,total\n1,Ada,42\n2,Grace,75\n",
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1024, "height": 700})
        page.add_init_script(load_native_bridge_mock())
        page.route(
            "**/__fixture/*",
            lambda route: route.fulfill(
                status=200,
                content_type="text/csv",
                body=fixture_csv[route.request.url.rsplit("/", 1)[-1]],
            ),
        )
        page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))
        page.wait_for_load_state("networkidle")

        page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
        page.locator('[data-source-path="/fixtures/customers.csv"]').click()
        expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
        page.get_by_role("button", name="SQL", exact=True).click()
        page.get_by_role("textbox", name="SQL-Editor").fill(
            "INSERT INTO customers VALUES (3, 'Linus', 'Helsinki');"
        )
        page.get_by_role("button", name="Ausführen").click()
        page.get_by_role("button", name="Daten", exact=True).click()
        expect(page.get_by_text("Linus", exact=True)).to_be_visible()

        # Keep a second tab on the changed database, then let the canonical API
        # replace the ordinary database tab with another source.
        page.locator('[data-table-name="customers"]').click(button="right")
        page.get_by_role("menuitem", name="In neuem Tab öffnen").click()
        page.get_by_role("tab", name="customers.csv", exact=True).click()

        api_call = {
            "method": "POST",
            "path": "/api/v1/sqlite/open",
            "query": {},
            "body": json.dumps({"path": "/fixtures/orders.csv"}),
        }
        encoded_call = base64.b64encode(json.dumps(api_call).encode()).decode()
        page.evaluate(
            "payload => window.databaseStudio.__apiRequest(9001, payload)",
            encoded_call,
        )
        expect(page.locator('[data-table-name="orders"]')).to_be_visible(timeout=10_000)
        expect(page.get_by_role("tab", name="orders.csv", exact=True)).to_be_visible()

        page.get_by_role("tab", name="customers", exact=True).click()
        expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
        expect(page.get_by_text("Linus", exact=True)).to_be_visible(timeout=10_000)

        page.get_by_role("tab", name="orders.csv", exact=True).click()
        expect(page.locator('[data-table-name="orders"]')).to_be_visible(timeout=10_000)

        print("sqlite api session regression: ok")
        browser.close()


if __name__ == "__main__":
    main()
