import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from cursor_functional_smoke import NATIVE_BRIDGE_MOCK


BASE_URL = os.environ.get("DATABASE_STUDIO_URL", "http://localhost:5174")
OUTPUT_DIR = Path(
    os.environ.get(
        "VISUAL_OUTPUT",
        "test-output/database-studio-unified-tabs",
    )
)


def install_fixtures(page) -> None:
    fixture_csv = {
        "customers.csv": "id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
        "orders.csv": "id,customer,total\n1,Ada,42\n2,Grace,75\n",
    }
    page.add_init_script(NATIVE_BRIDGE_MOCK)
    page.route(
        "**/__fixture/*",
        lambda route: route.fulfill(
            status=200,
            content_type="text/csv",
            body=fixture_csv[route.request.url.rsplit("/", 1)[-1]],
        ),
    )


def open_view(page, name: str) -> None:
    if name == "home":
        return
    page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
    if name in {"table", "multi-tabs", "table-menu"}:
        page.locator('[data-source-path="/fixtures/customers.csv"]').click()
        page.locator('[data-table-name="customers"]').wait_for(state="visible", timeout=10_000)
    if name == "graph":
        page.locator('[data-source-path="/fixtures/network.graph"]').click()
        page.get_by_role("tab", name="network.graph", exact=True).wait_for(state="visible", timeout=10_000)
    elif name == "multi-tabs":
        page.locator('[data-table-name="customers"]').click(button="right")
        page.get_by_role("menuitem", name="In neuem Tab öffnen").click()
        page.get_by_test_id("new-tab").click()
        page.locator('[data-source-path="/fixtures/network.graph"]').click()
        page.get_by_role("tab", name="network.graph", exact=True).wait_for(state="visible", timeout=10_000)
        page.get_by_role("tab", name="customers.csv", exact=True).click()
    elif name == "table-menu":
        page.locator('[data-table-name="customers"]').click(button="right")
        page.get_by_role("menuitem", name="In neuem Tab öffnen").wait_for(state="visible")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    report: list[dict[str, object]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        for width, height in ((1440, 900), (1024, 700)):
            for name in ("home", "table", "graph", "multi-tabs", "table-menu"):
                page = browser.new_page(viewport={"width": width, "height": height})
                install_fixtures(page)
                page_errors: list[str] = []
                console_errors: list[str] = []
                page.on("pageerror", lambda error, bucket=page_errors: bucket.append(str(error)))
                page.on(
                    "console",
                    lambda message, bucket=console_errors: (
                        bucket.append(message.text) if message.type == "error" else None
                    ),
                )

                page.goto(BASE_URL)
                page.wait_for_load_state("networkidle")
                open_view(page, name)
                page.wait_for_timeout(350)

                visible_overflow = page.evaluate(
                    """
                    () => Array.from(document.querySelectorAll('header, nav'))
                      .filter((element) => {
                        const style = getComputedStyle(element);
                        const box = element.getBoundingClientRect();
                        return box.width > 0 &&
                          style.overflowX === 'visible' &&
                          element.scrollWidth > element.clientWidth + 1;
                      })
                      .map((element) => ({
                        tag: element.tagName,
                        className: element.className,
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                      }))
                    """
                )
                overlapping_controls = page.evaluate(
                    """
                    () => Array.from(document.querySelectorAll('header'))
                      .flatMap((header, headerIndex) => {
                        const controls = Array.from(header.querySelectorAll('button'))
                          .filter((button) => {
                            const box = button.getBoundingClientRect();
                            return box.width > 0 && box.height > 0;
                          });
                        const collisions = [];
                        for (let left = 0; left < controls.length; left += 1) {
                          const a = controls[left].getBoundingClientRect();
                          for (let right = left + 1; right < controls.length; right += 1) {
                            const b = controls[right].getBoundingClientRect();
                            const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                            const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                            if (overlapWidth > 1 && overlapHeight > 1) {
                              collisions.push({ headerIndex, overlap: Math.round(overlapWidth * overlapHeight) });
                            }
                          }
                        }
                        return collisions;
                      })
                    """
                )

                screenshot = OUTPUT_DIR / f"{name}-{width}x{height}.png"
                page.screenshot(path=str(screenshot), full_page=True)
                result = {
                    "view": name,
                    "viewport": f"{width}x{height}",
                    "pageErrors": page_errors,
                    "consoleErrors": console_errors,
                    "visibleOverflow": visible_overflow,
                    "overlappingControls": overlapping_controls,
                    "screenshot": str(screenshot),
                }
                report.append(result)
                if page_errors or console_errors or visible_overflow or overlapping_controls:
                    failures.append(json.dumps(result, ensure_ascii=False))
                page.close()

        browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    main()
