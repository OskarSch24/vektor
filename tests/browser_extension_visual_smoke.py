import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("EXTENSION_URL", "http://127.0.0.1:8878")
OUTPUT_DIR = Path(
    os.environ.get(
        "VISUAL_OUTPUT",
        "test-output/database-studio-extension",
    )
)

CHROME_MOCK = r"""
(() => {
  const reply = (message) => {
    if (message.type === 'status') return {
      ok: true,
      data: { ok: true, app: 'Database Studio', version: '1.0.0', tokensUsed: 4255 }
    };
    if (message.type === 'projects') return {
      ok: true,
      data: { projects: [{ id: 'p1', name: 'Research', path: '/Research', graphs: [] }] }
    };
    if (message.type === 'targets') return { ok: true, data: { targets: [] } };
    if (message.type === 'extract') return {
      ok: true,
      data: {
        url: 'https://example.com/research/database-systems',
        title: 'A practical field guide to modern database systems',
        kind: 'website',
        text: 'one two three four five six seven eight nine ten',
        jsonLd: [{ '@type': 'Article' }],
        meta: {}
      }
    };
    return { ok: false, error: 'unknown request' };
  };
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '1.1.0' }),
      sendMessage: (message, callback) => queueMicrotask(() => callback(reply(message))),
      openOptionsPage: () => undefined
    },
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, port: 8787 }),
        set: async () => undefined
      }
    },
    tabs: {
      query: async () => [{
        id: 7,
        url: 'https://example.com/research/database-systems',
        title: 'A practical field guide to modern database systems'
      }]
    }
  };
})();
"""


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report: list[dict[str, object]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        popup = browser.new_page(viewport={"width": 360, "height": 600})
        popup.add_init_script(CHROME_MOCK)
        popup_errors: list[str] = []
        popup.on("pageerror", lambda error: popup_errors.append(str(error)))
        popup.on(
            "console",
            lambda message: popup_errors.append(message.text) if message.type == "error" else None,
        )
        popup.goto(f"{BASE_URL}/popup/popup.html")
        popup.wait_for_load_state("networkidle")
        expect(popup.get_by_text("Database Studio", exact=True)).to_be_visible()
        expect(popup.get_by_text("Mit Database Studio verbunden", exact=True)).to_be_visible()
        expect(popup.locator("#convert")).to_be_enabled()
        popup_metrics = popup.evaluate(
            "() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight })"
        )
        popup.screenshot(path=str(OUTPUT_DIR / "popup.png"), full_page=True)
        report.append({"view": "popup", "errors": popup_errors, "metrics": popup_metrics})

        options = browser.new_page(viewport={"width": 1000, "height": 800})
        options.add_init_script(CHROME_MOCK)
        options_errors: list[str] = []
        options.on("pageerror", lambda error: options_errors.append(str(error)))
        options.on(
            "console",
            lambda message: options_errors.append(message.text) if message.type == "error" else None,
        )
        options.goto(f"{BASE_URL}/options/options.html")
        options.wait_for_load_state("networkidle")
        expect(options.get_by_role("heading", name="Database Studio")).to_be_visible()
        expect(options.locator("#port")).to_have_value("8787")
        options.screenshot(path=str(OUTPUT_DIR / "options.png"), full_page=True)
        report.append({"view": "options", "errors": options_errors})

        browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    assert not popup_errors, popup_errors
    assert not options_errors, options_errors
    assert popup_metrics["width"] <= 360, popup_metrics
    assert popup_metrics["height"] <= 600, popup_metrics


if __name__ == "__main__":
    main()
