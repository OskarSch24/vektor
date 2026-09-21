import os
import sqlite3
import tempfile
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


BASE_URL = os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5197")

NATIVE_BRIDGE_MOCK = r"""
(() => {
  const now = Date.now();
  const relational = {
    kind: 'file',
    id: '/fixtures/relations.sqlite',
    path: '/fixtures/relations.sqlite',
    name: 'relations.sqlite',
    fileType: 'sqlite',
    size: 16384,
    modified: now,
  };
  const archive = {
    kind: 'file',
    id: '/fixtures/archive.json',
    path: '/fixtures/archive.json',
    name: 'archive.json',
    fileType: 'json-table',
    size: 128,
    modified: now,
  };
  const project = {
    id: '/fixtures',
    name: 'E2E Fixtures',
    path: '/fixtures',
    children: [archive, relational],
    fileCount: 2,
    redisDatabases: [],
    redisDatabaseCount: 0,
  };

  const encode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const reply = (id, data, error = null) => setTimeout(() => {
    window.databaseStudio?.__resolve?.(
      id,
      encode(error ? { ok: false, error } : { ok: true, data })
    );
  }, 0);

  const rpc = {
    postMessage(message) {
      const { id, channel, method, params = {} } = message;
      if (channel === 'projects' && method === 'list') return reply(id, [project]);
      if (channel === 'projects' && method === 'refresh') return reply(id, project);
      if (channel === 'projects' && method === 'remove') return reply(id, null);
      if (channel === 'settings' && method === 'load') return reply(id, null);
      if (channel === 'settings' && method === 'save') return reply(id, null);
      if (channel === 'server' && method === 'status') {
        return reply(id, {
          running: true,
          port: 8787,
          clients: ['Database Studio E2E/1.0'],
          lastSeenAt: new Date(now).toISOString(),
          requestCount: 1,
        });
      }
      if (channel === 'server' && method === 'start') {
        return reply(id, { running: true, port: 8787, clients: [], requestCount: 0 });
      }
      if (channel === 'files' && method === 'stage') {
        if (params.path !== relational.path) return reply(id, null, 'fixture missing');
        return reply(id, {
          path: relational.path,
          name: relational.name,
          url: `${location.origin}/__fixture/relations.sqlite`,
        });
      }
      if (channel === 'files' && method === 'pick') return reply(id, null);
      if (channel === 'files' && method === 'write') return reply(id, { path: params.path });
      if (channel === 'redis' && method === 'savedList') return reply(id, []);
      return reply(id, null);
    },
  };

  window.webkit = { messageHandlers: {
    rpc,
    api: { postMessage: (message) => reply(message.id, null) },
    appReady: { postMessage() {} },
    windowDrag: { postMessage() {} },
  } };
})();
"""


def build_relational_fixture(path: Path) -> bytes:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE customers (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          city TEXT NOT NULL,
          tier TEXT NOT NULL
        );
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          status TEXT NOT NULL,
          total REAL NOT NULL
        );
        INSERT INTO customers (id, name, city, tier) VALUES
          (1, 'Ada', 'Berlin', 'gold'),
          (2, 'Grace', 'Hamburg', 'gold'),
          (3, 'Linus', 'Berlin', 'silver');
        INSERT INTO orders (id, customer_id, status, total) VALUES
          (101, 1, 'paid', 42.0),
          (102, 2, 'open', 75.0),
          (103, 1, 'open', 11.0),
          (104, 3, 'paid', 100.0);
        """
    )
    connection.commit()
    connection.close()
    return path.read_bytes()


def install_fixture(page: Page, database_bytes: bytes) -> list[str]:
    browser_errors: list[str] = []
    page.on("pageerror", lambda error: browser_errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: (
            browser_errors.append(f"console: {message.text}")
            if message.type == "error"
            else None
        ),
    )
    page.add_init_script(NATIVE_BRIDGE_MOCK)
    page.route(
        "**/__fixture/relations.sqlite",
        lambda route: route.fulfill(
            status=200,
            content_type="application/octet-stream",
            body=database_bytes,
        ),
    )
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
    return browser_errors


def assert_no_browser_errors(errors: list[str], scenario: str) -> None:
    if errors:
        raise AssertionError(f"{scenario}: " + " | ".join(errors))


def test_quick_open_filters_and_foreign_key(page: Page) -> None:
    expect(page.get_by_role("tab")).to_have_count(1)

    # Non-contiguous characters exercise the fuzzy branch, not substring search.
    page.keyboard.press("Meta+P")
    palette = page.get_by_role("dialog", name="Datei schnell öffnen")
    expect(palette).to_be_visible()
    search = palette.get_by_role("combobox", name="Datei schnell öffnen")
    search.fill("rltn")
    match = palette.locator('[data-quick-open-path="/fixtures/relations.sqlite"]')
    expect(match).to_be_visible()
    expect(match).to_have_attribute("aria-selected", "true")

    # The home editor must survive because Cmd+Enter explicitly opens beside it.
    search.press("Meta+Enter")
    expect(palette).to_be_hidden()
    expect(page.get_by_role("tab")).to_have_count(2)
    relational_tab = page.get_by_role("tab", name="relations.sqlite", exact=True)
    expect(relational_tab).to_have_attribute("aria-selected", "true")
    expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)

    # Combine two independent predicates: city = Berlin AND tier = gold.
    filter_button = page.get_by_role("button", name="Erweiterte Filter")
    filter_button.click()
    filter_panel = page.get_by_text("Tabellenfilter", exact=True).locator("..")
    page.get_by_role("button", name="Erste Bedingung hinzufügen").click()
    page.get_by_label("Spalte für Bedingung 1").select_option("city")
    page.get_by_label("Operator für Bedingung 1").select_option("equals")
    page.get_by_label("Wert für Bedingung 1").fill("Berlin")
    page.get_by_role("button", name="Bedingung", exact=True).click()
    page.get_by_label("Spalte für Bedingung 2").select_option("tier")
    page.get_by_label("Operator für Bedingung 2").select_option("equals")
    page.get_by_label("Wert für Bedingung 2").fill("gold")
    page.get_by_role("button", name="Fertig", exact=True).click()
    expect(filter_panel).to_be_hidden()

    data_grid = page.locator("table").last
    expect(data_grid.locator("tbody tr")).to_have_count(1, timeout=5_000)
    expect(data_grid.get_by_text("Ada", exact=True)).to_be_visible()
    expect(data_grid.get_by_text("Grace", exact=True)).to_have_count(0)
    expect(data_grid.get_by_text("Linus", exact=True)).to_have_count(0)
    expect(page.get_by_text("1 Zeile", exact=True)).to_be_visible()

    # Reset before checking navigation, then follow orders.customer_id -> customers.id.
    filter_button.click()
    page.get_by_role("button", name="Zurücksetzen", exact=True).click()
    page.get_by_role("button", name="Fertig", exact=True).click()
    page.locator('[data-table-name="orders"]').click()
    orders_grid = page.locator("table").last
    expect(orders_grid.locator("tbody tr")).to_have_count(4, timeout=5_000)
    foreign_keys = orders_grid.locator('button[title="Öffne customers.id"]')
    expect(foreign_keys).to_have_count(4)
    foreign_keys.first.click()

    expect(page.get_by_role("heading", name="customers", exact=True)).to_be_visible()
    customers_grid = page.locator("table").last
    expect(customers_grid.locator("tbody tr")).to_have_count(1, timeout=5_000)
    expect(customers_grid.get_by_text("Ada", exact=True)).to_be_visible()

    # Verify that navigation created an inspectable equality filter, not only a row subset.
    filter_button.click()
    expect(page.get_by_label("Spalte für Bedingung 1")).to_have_value("id")
    expect(page.get_by_label("Operator für Bedingung 1")).to_have_value("equals")
    expect(page.get_by_label("Wert für Bedingung 1")).to_have_value("1")
    page.get_by_role("button", name="Fertig", exact=True).click()


def test_merge_union_dedupe_and_dirty_tab(page: Page) -> None:
    # Merge is available in the contextual table workspace after opening a table source.
    page.keyboard.press("Meta+P")
    page.get_by_role("combobox", name="Datei schnell öffnen").fill("relations")
    page.get_by_role("combobox", name="Datei schnell öffnen").press("Enter")
    expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)

    page.locator('button[title*="Mehrere JSON-"]').click()
    dialog = page.get_by_role("dialog", name="Dateien zusammenführen")
    expect(dialog).to_be_visible()

    json_bytes = (
        '[{"id":1,"name":"Ada"},{"id":2,"status":"aktiv"}]'.encode("utf-8")
    )
    csv_bytes = "id,status\n2,aktiv\n3,offen\n".encode("utf-8")
    dialog.locator('input[type="file"][multiple]').set_input_files(
        [
            {
                "name": "ag_01.json",
                "mimeType": "application/json",
                "buffer": json_bytes,
            },
            {
                "name": "ag_02.csv",
                "mimeType": "text/csv",
                "buffer": csv_bytes,
            },
        ]
    )

    expect(dialog.get_by_text("2 Tabellen · 3 Spalten", exact=True)).to_be_visible(timeout=5_000)
    preview = dialog.locator("table")
    for column in ("id", "name", "status"):
        expect(preview.get_by_role("columnheader", name=column, exact=True)).to_be_visible()
    expect(preview.locator("tbody tr")).to_have_count(4)

    dialog.get_by_text("Dubletten entfernen", exact=True).click()
    expect(dialog.get_by_text("1 Dubletten entfernt", exact=True)).to_be_visible()
    expect(preview.locator("tbody tr")).to_have_count(3)
    dialog.locator("#merge-target-name").fill("Alle AGs")
    dialog.get_by_role("button", name="Zusammenführen", exact=True).click()
    expect(dialog).to_be_hidden(timeout=10_000)

    merged_tab = page.get_by_role("tab", name="Alle AGs.sqlite", exact=True)
    expect(merged_tab).to_have_attribute("aria-selected", "true")
    expect(page.get_by_label("Ungesicherte Änderungen")).to_be_visible()
    dirty_close = page.get_by_role("button", name="Tab „Alle AGs.sqlite“ schließen")
    expect(dirty_close.locator("span[aria-hidden=true]")).to_be_visible()
    expect(page.locator('[data-table-name="Alle_AGs"]')).to_be_visible()

    merged_grid = page.locator("table").last
    expect(merged_grid.locator("tbody tr")).to_have_count(3)
    expect(merged_grid.get_by_role("columnheader", name="id INTEGER", exact=False)).to_be_visible()
    expect(merged_grid.get_by_role("columnheader", name="name TEXT", exact=False)).to_be_visible()
    expect(merged_grid.get_by_role("columnheader", name="status TEXT", exact=False)).to_be_visible()
    merge_notice = "2 Dateien zu 3 Zeilen zusammengeführt · 1 Dubletten entfernt."
    expect(page.get_by_role("status", name=merge_notice, exact=True)).to_be_visible()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="database-studio-e2e-") as temp_dir:
        database_bytes = build_relational_fixture(Path(temp_dir) / "relations.sqlite")

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1600, "height": 960})

            scenarios = (
                ("quick-open, filters, foreign-key navigation", test_quick_open_filters_and_foreign_key),
                ("merge, union schema, dedupe, dirty tab", test_merge_union_dedupe_and_dirty_tab),
            )
            for label, scenario in scenarios:
                page = context.new_page()
                errors = install_fixture(page, database_bytes)
                try:
                    scenario(page)
                    assert_no_browser_errors(errors, label)
                    print(f"PASS: {label}")
                except Exception:
                    page.screenshot(
                        path=f"/tmp/database-studio-{label.split(',')[0].replace(' ', '-')}-failure.png",
                        full_page=True,
                    )
                    raise
                finally:
                    page.close()

            context.close()
            browser.close()

    print("practical features e2e: ok")


if __name__ == "__main__":
    main()
