import os

from playwright.sync_api import expect, sync_playwright


NATIVE_BRIDGE_MOCK = r"""
(() => {
  const now = Date.now();
  const csv = {
    '/fixtures/customers.csv': 'id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n',
    '/fixtures/orders.csv': 'id,customer,total\n1,Ada,42\n2,Grace,75\n',
  };
  const graph = JSON.stringify({
    version: 1,
    metadata: {
      name: 'network.graph',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      sources: [],
    },
    nodes: [
      { id: 'person:ada', labels: ['Person'], properties: { name: 'Ada' } },
      { id: 'city:berlin', labels: ['City'], properties: { name: 'Berlin' } },
    ],
    edges: [
      { id: 'lives', type: 'LIVES_IN', from: 'person:ada', to: 'city:berlin', properties: {} },
    ],
  });
  const files = [
    ['customers.csv', '/fixtures/customers.csv', 'csv'],
    ['orders.csv', '/fixtures/orders.csv', 'csv'],
    ['network.graph', '/fixtures/network.graph', 'graph'],
  ].map(([name, path, fileType]) => ({
    kind: 'file', id: path, path, name, fileType, size: 120, modified: now,
  }));
  const projects = [{
    id: '/fixtures', name: 'Beispielprojekt', path: '/fixtures', children: files, fileCount: files.length,
    redisDatabases: [], redisDatabaseCount: 0,
  }];

  const encode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const reply = (id, data, error = null) => setTimeout(() => {
    window.databaseStudio?.__resolve?.(id, encode(error ? { ok: false, error } : { ok: true, data }));
  }, 0);
  const rpc = {
    postMessage(message) {
      const { id, channel, method, params = {} } = message;
      if (channel === 'projects' && method === 'list') return reply(id, projects);
      if (channel === 'projects' && method === 'refresh') return reply(id, projects[0]);
      if (channel === 'settings' && method === 'load') return reply(id, null);
      if (channel === 'settings' && method === 'save') return reply(id, null);
      if (channel === 'server' && method === 'status') {
        return reply(id, {
          running: true,
          port: 8787,
          clients: ['Database Studio Extension/1.0.0'],
          lastSeenAt: new Date(now - 60_000).toISOString(),
          requestCount: 1,
        });
      }
      if (channel === 'server' && method === 'start') {
        return reply(id, { running: true, port: 8787, clients: [], requestCount: 0 });
      }
      if (channel === 'files' && method === 'stage') {
        const fileText = csv[params.path];
        if (fileText === undefined) return reply(id, null, 'fixture missing');
        return reply(id, {
          path: params.path,
          name: params.path.split('/').pop(),
          url: `http://127.0.0.1:5174/__fixture/${params.path.split('/').pop()}`,
        });
      }
      if (channel === 'files' && method === 'read') {
        if (params.path === '/fixtures/network.graph') {
          return reply(id, { path: params.path, name: 'network.graph', contents: graph });
        }
        return reply(id, null, 'fixture missing');
      }
      if (channel === 'files' && method === 'write') return reply(id, { path: params.path });
      if (channel === 'files' && method === 'pick') return reply(id, null);
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


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1024, "height": 700})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.add_init_script(NATIVE_BRIDGE_MOCK)
        fixture_csv = {
            "customers.csv": "id,name,city\n1,Ada,Berlin\n2,Grace,Hamburg\n",
            "orders.csv": "id,customer,total\n1,Ada,42\n2,Grace,75\n",
        }
        page.route(
            "**/__fixture/*",
            lambda route: route.fulfill(
                status=200,
                content_type="text/csv",
                body=fixture_csv[route.request.url.rsplit("/", 1)[-1]],
            ),
        )

        page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://localhost:5174"))
        page.wait_for_load_state("networkidle")

        expect(page.get_by_text("Database Studio", exact=True).first).to_be_visible()
        expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
        expect(page.get_by_text("Explorer", exact=True)).to_be_visible()
        expect(page.get_by_role("navigation", name="Arbeitsräume")).to_have_count(0)
        expect(page.get_by_role("navigation", name="Offene Tabs")).to_be_visible()
        expect(page.get_by_text("Extension bereit", exact=True)).to_be_visible()

        page.locator('[data-project-path="/fixtures"] [data-project-subtree-toggle]').click()
        page.locator('[data-source-path="/fixtures/customers.csv"]').click()
        expect(page.get_by_text("customers.csv", exact=True).first).to_be_visible(timeout=10_000)
        expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)

        page.get_by_role("button", name="SQL", exact=True).click()
        page.get_by_role("textbox", name="SQL-Editor").fill(
            "INSERT INTO customers (id, name, city) VALUES (3, 'Linus', 'Helsinki');"
        )
        page.get_by_role("button", name="Ausführen").click()
        page.get_by_role("button", name="Daten", exact=True).click()
        expect(page.get_by_text("Linus", exact=True)).to_be_visible()

        page.locator('[data-table-name="customers"]').click(button="right")
        expect(page.get_by_role("menuitem", name="In neuem Tab öffnen")).to_be_visible()
        page.get_by_role("menuitem", name="In neuem Tab öffnen").click()
        expect(page.get_by_role("tab", name="customers", exact=True)).to_be_visible()

        page.get_by_test_id("new-tab").click()
        expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
        expect(page.get_by_role("tab")).to_have_count(3)

        page.locator('[data-source-path="/fixtures/network.graph"]').click()
        expect(page.get_by_role("tab", name="network.graph", exact=True)).to_be_visible(timeout=10_000)
        expect(page.get_by_text("Person", exact=True).first).to_be_visible(timeout=10_000)

        page.get_by_role("tab", name="customers.csv", exact=True).click()
        expect(page.locator('[data-table-name="customers"]')).to_be_visible()

        page.locator('[data-source-path="/fixtures/orders.csv"]').click(button="right")
        page.get_by_role("menuitem", name="In neuem Tab öffnen").click()
        expect(page.get_by_role("tab", name="orders.csv", exact=True)).to_be_visible(timeout=10_000)
        expect(page.locator('[data-table-name="orders"]')).to_be_visible(timeout=10_000)

        page.get_by_role("tab", name="customers.csv", exact=True).click()
        expect(page.locator('[data-table-name="customers"]')).to_be_visible(timeout=10_000)
        expect(page.get_by_text("Linus", exact=True)).to_be_visible(timeout=10_000)
        page.get_by_role("tab", name="orders.csv", exact=True).click()
        expect(page.locator('[data-table-name="orders"]')).to_be_visible(timeout=10_000)

        page.keyboard.press("Meta+T")
        expect(page.get_by_role("heading", name="Neuer Tab")).to_be_visible()
        page.keyboard.press("Meta+W")
        expect(page.get_by_role("tab", name="orders.csv", exact=True)).to_have_attribute("aria-selected", "true")

        page.keyboard.press("Meta+B")
        expect(page.get_by_text("Explorer", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="Explorer öffnen")).to_be_visible()
        page.get_by_role("button", name="Explorer öffnen").click()
        expect(page.get_by_text("Explorer", exact=True)).to_be_visible()

        if errors:
            raise AssertionError("Browser errors: " + " | ".join(errors))

        print("cursor functional smoke: ok")
        browser.close()


if __name__ == "__main__":
    main()
