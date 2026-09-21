import json
import os
import statistics

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473")


def main() -> None:
    samples = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for _ in range(5):
            context = browser.new_context()
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.goto(BASE_URL, wait_until="commit")
            page.locator(".data-room").wait_for(state="visible")
            visible_at = page.evaluate("performance.now()")
            page.wait_for_load_state("networkidle")
            metrics = page.evaluate(
                """() => {
                    const nav = performance.getEntriesByType('navigation')[0];
                    const paints = Object.fromEntries(
                      performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime])
                    );
                    const resources = performance.getEntriesByType('resource');
                    const initialScripts = new Set(
                      Array.from(document.scripts, (script) => script.src).filter(Boolean)
                    );
                    const lazyScripts = resources.filter(
                      (entry) => entry.initiatorType === 'script' && !initialScripts.has(entry.name)
                    );
                    return {
                      domContentLoaded: nav?.domContentLoadedEventEnd ?? 0,
                      load: nav?.loadEventEnd ?? 0,
                      firstPaint: paints['first-paint'] ?? 0,
                      firstContentfulPaint: paints['first-contentful-paint'] ?? 0,
                      transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
                      scriptResources: resources.filter((entry) => entry.initiatorType === 'script').length,
                      firstLazyScript: lazyScripts.length
                        ? Math.min(...lazyScripts.map((entry) => entry.startTime))
                        : 0,
                    };
                }"""
            )
            metrics["workspaceVisible"] = visible_at
            metrics["errors"] = errors
            samples.append(metrics)
            context.close()
        browser.close()

    if any(sample["errors"] for sample in samples):
        raise AssertionError(samples)
    if any(
        sample["firstLazyScript"]
        and sample["firstLazyScript"] + 0.5 < sample["firstContentfulPaint"]
        for sample in samples
    ):
        raise AssertionError(f"A workspace chunk started before first contentful paint: {samples}")
    summary = {
        key: round(statistics.median(sample[key] for sample in samples), 1)
        for key in (
            "workspaceVisible",
            "firstContentfulPaint",
            "domContentLoaded",
            "load",
            "transferBytes",
            "scriptResources",
            "firstLazyScript",
        )
    }
    print(json.dumps({"median": summary, "samples": samples}, indent=2))


if __name__ == "__main__":
    main()
