import importlib.util
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
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1024, "height": 700})
        requested_scripts: list[str] = []
        page.on(
            "request",
            lambda request: requested_scripts.append(request.url)
            if request.resource_type == "script"
            else None,
        )
        page.add_init_script(load_native_bridge_mock())
        page.route(
            "**/__fixture/customers.csv",
            lambda route: route.fulfill(
                status=200,
                content_type="text/csv",
                body="id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
            ),
        )
        page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))
        page.wait_for_load_state("networkidle")

        page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
        page.locator('[data-source-path="/fixtures/customers.csv"]').click()
        expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
        page.wait_for_timeout(500)

        standalone_requests = [
            url for url in requested_scripts if "StandaloneTableStudioView" in url
        ]
        assert not standalone_requests, (
            "Der Unified-Workspace hat Standalone-Tabellen-Chrome geladen: "
            + ", ".join(standalone_requests)
        )

        print("embedded table bundle regression: ok")
        browser.close()


if __name__ == "__main__":
    main()
