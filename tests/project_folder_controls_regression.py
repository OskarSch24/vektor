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
    return module.NATIVE_BRIDGE_MOCK + NESTED_PROJECT_OVERRIDE


NESTED_PROJECT_OVERRIDE = r"""
(() => {
  const now = Date.now();
  const file = (path, fileType = 'csv') => ({
    kind: 'file', id: path, path, name: path.split('/').pop(), fileType, size: 120, modified: now,
  });
  const folder = (path, children) => ({
    kind: 'folder', id: path, path, name: path.split('/').pop(), children,
  });
  const project = {
    id: '/fixtures', name: 'Beispielprojekt', path: '/fixtures', fileCount: 9,
    redisDatabases: [], redisDatabaseCount: 0,
    children: [
      folder('/fixtures/data', [
        file('/fixtures/data/direct.csv'),
        file('/fixtures/data/ag_01.json', 'json-table'),
        file('/fixtures/data/ag_02.json', 'json-table'),
        file('/fixtures/data/ag_03.json', 'json-table'),
        file('/fixtures/data/ag_04.json', 'json-table'),
        file('/fixtures/data/ag_05.json', 'json-table'),
        folder('/fixtures/data/archive', [file('/fixtures/data/archive/deep.csv')]),
      ]),
      folder('/fixtures/phase-x', [
        folder('/fixtures/phase-x/runs', [file('/fixtures/phase-x/runs/result.amqrun', 'phase-x-run')]),
      ]),
      file('/fixtures/top.graph', 'graph'),
    ],
  };
  const baseRpc = window.webkit.messageHandlers.rpc.postMessage.bind(window.webkit.messageHandlers.rpc);
  const encode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const reply = (id, data) => setTimeout(() => {
    window.databaseStudio?.__resolve?.(id, encode({ ok: true, data }));
  }, 0);
  window.webkit.messageHandlers.rpc.postMessage = (message) => {
    if (message.channel === 'projects' && message.method === 'list') return reply(message.id, [project]);
    if (message.channel === 'projects' && message.method === 'refresh') return reply(message.id, project);
    return baseRpc(message);
  };
})();
"""


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1024, "height": 700})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.add_init_script(load_native_bridge_mock())
        page.goto(os.environ.get("DATABASE_STUDIO_URL", "http://127.0.0.1:5473"))
        page.wait_for_load_state("networkidle")

        project = page.locator('[data-project-path="/fixtures"]')
        disclosure = project.locator('[data-project-disclosure]')
        expect(disclosure).to_have_attribute("aria-expanded", "false")
        expect(page.locator("[data-folder-path]")).to_have_count(0)
        expect(page.locator("[data-source-path]")).to_have_count(0)

        # The ordinary disclosure opens only one level; every child folder is closed.
        disclosure.click()
        data_folder = page.locator('[data-folder-path="/fixtures/data"]')
        phase_folder = page.locator('[data-folder-path="/fixtures/phase-x"]')
        expect(data_folder.locator('[data-folder-disclosure]')).to_have_attribute("aria-expanded", "false")
        expect(phase_folder.locator('[data-folder-disclosure]')).to_have_attribute("aria-expanded", "false")
        expect(page.locator('[data-source-path="/fixtures/data/archive/deep.csv"]')).to_have_count(0)

        # Each folder's compact action owns exactly its recursive subtree.
        data_folder.locator('[data-folder-subtree-toggle]').click()
        expect(data_folder.locator('[data-folder-disclosure]')).to_have_attribute("aria-expanded", "true")
        expect(page.locator('[data-folder-path="/fixtures/data/archive"] [data-folder-disclosure]')).to_have_attribute(
            "aria-expanded", "true"
        )
        expect(page.locator('[data-source-path="/fixtures/data/archive/deep.csv"]')).to_be_visible()
        expect(phase_folder.locator('[data-folder-disclosure]')).to_have_attribute("aria-expanded", "false")

        # Numbered JSON shards stay untouched but appear as one logical collection.
        collection = page.locator('[data-collection-pattern="ag_*.json"]')
        expect(collection).to_be_visible()
        expect(collection).to_contain_text("ag")
        expect(collection).to_contain_text("5")
        expect(page.locator('[data-source-path^="/fixtures/data/ag_"]')).to_have_count(5)

        data_folder.locator('[data-folder-subtree-toggle]').click()
        expect(data_folder.locator('[data-folder-disclosure]')).to_have_attribute("aria-expanded", "false")

        # The project action expands/collapses every descendant, including Phase-X.
        project.locator('[data-project-subtree-toggle]').click()
        expect(page.locator('[data-source-path="/fixtures/data/archive/deep.csv"]')).to_be_visible()
        expect(page.locator('[data-source-path="/fixtures/phase-x/runs/result.amqrun"]')).to_be_visible()
        project.locator('[data-project-subtree-toggle]').click()
        expect(disclosure).to_have_attribute("aria-expanded", "false")
        expect(page.locator("[data-folder-path]")).to_have_count(0)

        # Filtering reveals matching files temporarily without persisting expansion.
        page.get_by_role("textbox", name="Projektdateien filtern").fill("deep.csv")
        expect(page.locator('[data-source-path="/fixtures/data/archive/deep.csv"]')).to_be_visible()
        page.get_by_role("textbox", name="Projektdateien filtern").fill("ag_03.json")
        expect(page.locator('[data-source-path="/fixtures/data/ag_03.json"]')).to_be_visible()
        page.get_by_role("textbox", name="Projektdateien filtern").fill("")
        expect(disclosure).to_have_attribute("aria-expanded", "false")

        # A scan refresh resets a previously expanded tree.
        project.locator('[data-project-subtree-toggle]').click()
        expect(disclosure).to_have_attribute("aria-expanded", "true")
        project.hover()
        project.locator('button[title="Ordner neu einlesen"]').click()
        expect(disclosure).to_have_attribute("aria-expanded", "false")

        if errors:
            raise AssertionError("Browser errors: " + " | ".join(errors))

        print("project folder controls regression: ok")
        browser.close()


if __name__ == "__main__":
    main()
