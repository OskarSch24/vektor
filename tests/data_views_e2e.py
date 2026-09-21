import json
import os
import re
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from practical_features_e2e import NATIVE_BRIDGE_MOCK

ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get('DATABASE_STUDIO_URL', 'http://127.0.0.1:5197')
ARTIFACTS = ROOT / 'tests' / 'artifacts' / 'data-views'


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='vektor-views-') as temp:
        folder = Path(temp)
        db = sqlite3.connect(folder / 'records.sqlite')
        db.executescript('CREATE TABLE parents(id INTEGER PRIMARY KEY); INSERT INTO parents VALUES(1); CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, status TEXT, date TEXT, amount REAL, lat REAL, lon REAL, vector TEXT, image TEXT, parent_id INTEGER REFERENCES parents(id));')
        for i, name in enumerate(['Ada', 'Bob', 'Clara'], 1):
            db.execute('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?)', [i, name, 'offen' if i < 3 else 'fertig', '2026-09-13' if i < 3 else '2026-09-14', [12.5, -3, 8][i-1], 52.5+i, 13.4+i, json.dumps([float(i), 1., -1.]), 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 1])
        db.commit(); db.close()
        (folder / 'nested.json').write_text(json.dumps({'person': {'name': 'Ada', 'flags': [True, None, '001']}, 'rows': [{'id': 1, 'value': 7}]}))
        (folder / 'nested.yaml').write_text('person:\n  name: Ada\n  flags: [true, null, "001"]\n')
        (folder / 'nested.toml').write_text('[person]\nname = "Ada"\nflags = [true, "001"]\n')
        (folder / 'nested.xml').write_text('<root><person id="001"><name>Ada</name></person></root>')
        (folder / 'locations.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {'name': 'Berlin'}, 'geometry': {'type': 'Point', 'coordinates': [13.4, 52.5]}}]}))
        subprocess.run(['node', str(ROOT / 'tests/create_data_fixtures.mjs'), temp], check=True)
        file_types = {'sqlite': 'sqlite', 'json': 'json-table', 'yaml': 'document', 'toml': 'document', 'xml': 'document', 'geojson': 'document', 'parquet': 'parquet', 'arrow': 'arrow', 'duckdb': 'duckdb'}
        fixtures = [{'kind': 'file', 'fileType': file_types[p.suffix[1:]], 'id': f'/fixtures/{p.name}', 'path': f'/fixtures/{p.name}', 'name': p.name, 'size': p.stat().st_size, 'modified': 0} for p in folder.iterdir()]
        mock = NATIVE_BRIDGE_MOCK.replace('const now = Date.now();', f'const now = Date.now(); const fixtures = {json.dumps(fixtures)};')
        mock = mock.replace('children: [archive, relational]', 'children: fixtures')
        mock = mock.replace("if (params.path !== relational.path) return reply(id, null, 'fixture missing');", "const fixture = fixtures.find(f => f.path === params.path); if (!fixture) return reply(id, null, 'fixture missing');")
        mock = mock.replace('path: relational.path,\n          name: relational.name,\n          url: `${location.origin}/__fixture/relations.sqlite`,', 'path: fixture.path,\n          name: fixture.name,\n          url: `${location.origin}/__fixture/${fixture.name}`,')
        mock = mock.replace("if (channel === 'files' && method === 'pick')", "if (channel === 'sources' && method === 'read') { fetch('/__source', { method: 'POST', body: JSON.stringify(params) }).then(r => r.json()).then(r => reply(id, r.data, r.error)); return; }\n      if (channel === 'files' && method === 'pick')")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
            page.add_init_script(mock)
            page.route('**/__fixture/*', lambda route: route.fulfill(body=(folder / route.request.url.rsplit('/', 1)[1]).read_bytes(), content_type='application/octet-stream'))
            def source(route):
                result = subprocess.run(['node', str(ROOT / 'tools/data-runtime/cli.mjs')], input=route.request.post_data, text=True, capture_output=True, timeout=100)
                route.fulfill(body=result.stdout, content_type='application/json')
            page.route('**/__source', source)
            page.goto(URL); page.wait_for_load_state('networkidle')
            page.get_by_role('button', name='E2E Fixtures ausklappen', exact=True).click()

            def open_file(name):
                page.locator(f'[data-source-path="/fixtures/{name}"]').click()
                expect(page.locator('.dv-root')).to_have_attribute('data-source-name', name, timeout=30000)
                expect(page.get_by_label('Datenansicht')).to_be_visible(timeout=20000)

            try:
                open_file('records.sqlite')
                selector = page.get_by_label('Datenansicht')
                for mode in ['record', 'er', 'chart', 'pivot', 'timeline', 'calendar', 'kanban', 'map', 'gallery', 'quality', 'vector']:
                    selector.select_option(mode)
                    expect(page.locator('.dv-pane')).to_be_visible()
                    if mode == 'chart':
                        page.get_by_label('Y-Achse').select_option(label='amount')
                        for kind in ['bar','line','scatter','histogram']:
                            page.get_by_label('Diagrammtyp').select_option(kind)
                            expect(page.locator('.dv-chart')).to_be_visible()
                    if mode == 'gallery':
                        page.get_by_text('Vorschau öffnen', exact=True).first.click()
                        expect(page.locator('.dv-gallery img').first).to_be_visible()
                    if mode == 'vector':
                        expect(page.locator('.dv-vector')).to_be_visible()
                    if mode in ['er','calendar','map','vector']:
                        page.screenshot(path=str(ARTIFACTS / f'{mode}.png'))
                    assert not errors, errors
                selector.select_option('compare')
                page.get_by_label('Vergleichsdatei', exact=True).set_input_files({'name':'after.json','mimeType':'application/json','buffer':json.dumps([{'id':1,'name':'Changed'},{'id':4,'name':'New'}]).encode()})
                expect(page.locator('.dv-diff')).to_have_count(4)
                for name in ['nested.json','nested.yaml','nested.toml','nested.xml']:
                    open_file(name)
                    expect(selector).to_have_value('document')
                    page.get_by_label('Dokument durchsuchen').fill('Ada')
                    expect(page.locator('.dv-search-result')).to_have_count(1)
                    page.locator('.dv-search-result').click()
                    expect(page.locator('.dv-document-detail pre')).to_contain_text('Ada')
                    page.get_by_label('Dokumentdarstellung').select_option('raw')
                    expect(page.locator('.dv-raw')).to_contain_text('Ada')
                # Restore a source with its original nested document after another source was open.
                open_file('nested.json')
                expect(selector).to_have_value('document')
                page.screenshot(path=str(ARTIFACTS / 'document.png'))
                page.locator('[data-source-path="/fixtures/records.sqlite"]').click(button='right')
                page.get_by_role('menuitem', name='In neuem Tab öffnen').click()
                expect(page.locator('.dv-root')).to_have_attribute('data-source-name', 'records.sqlite')
                page.get_by_role('tab', name='nested.json', exact=True).click()
                expect(page.locator('.dv-root')).to_have_attribute('data-source-name', 'nested.json')
                expect(selector).to_have_value('document')
                for name in ['measurements.parquet','measurements.arrow','measurements.duckdb']:
                    open_file(name)
                    expect(selector).to_have_value('table')
                    expect(page.locator('.dv-root')).to_contain_text('Ada')
                open_file('locations.geojson')
                selector.select_option('map')
                expect(page.locator('.dv-map circle')).to_have_count(1)
                page.set_viewport_size({'width': 1024,'height':700})
                page.screenshot(path=str(ARTIFACTS / 'compact.png'))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal page overflow'
                assert not errors, errors
            except Exception:
                page.screenshot(path=str(ARTIFACTS / 'failure.png'))
                raise
            finally:
                browser.close()
    print('data views e2e: ok — all views, structured formats, Arrow, Parquet, DuckDB and tab restoration')

if __name__ == '__main__':
    main()
