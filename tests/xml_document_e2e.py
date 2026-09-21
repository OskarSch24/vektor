"""Open DTD-bearing XML through the existing document tab; optionally use a real file."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from practical_features_e2e import NATIVE_BRIDGE_MOCK


def main():
    source = os.environ.get('XML_DOCUMENT_PATH')
    data = Path(source).read_bytes() if source else b'<?xml version="1.0"?><!DOCTYPE DOCUMENT SYSTEM "MDB_STAMMDATEN.DTD"><DOCUMENT><MDB><ID>001</ID><NAME>Abelein</NAME></MDB></DOCUMENT>'
    name = 'MDB_STAMMDATEN.XML'
    fixture = {'kind': 'file', 'fileType': 'document', 'id': '/fixtures/' + name, 'path': '/fixtures/' + name, 'name': name, 'size': len(data), 'modified': 0}
    mock = NATIVE_BRIDGE_MOCK.replace('const now = Date.now();', 'const now = Date.now(); const fixture = ' + json.dumps(fixture) + ';')
    mock = mock.replace('children: [archive, relational]', 'children: [fixture]')
    mock = mock.replace('params.path !== relational.path', 'params.path !== fixture.path')
    mock = mock.replace('path: relational.path,\n          name: relational.name,\n          url: `${location.origin}/__fixture/relations.sqlite`,', 'path: fixture.path,\n          name: fixture.name,\n          url: `${location.origin}/__fixture/document.xml`,')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(mock)
        page.route('**/__fixture/document.xml', lambda route: route.fulfill(body=data, content_type='application/xml'))
        page.goto(os.environ.get('DATABASE_STUDIO_URL', 'http://127.0.0.1:5198'))
        page.get_by_role('button', name='E2E Fixtures ausklappen', exact=True).click()
        page.locator('[data-source-path="/fixtures/' + name + '"]').click()
        expect(page.locator('.dv-root')).to_have_attribute('data-source-name', name, timeout=60000)
        expect(page.get_by_label('Datenansicht')).to_have_value('document')
        page.get_by_label('Dokument durchsuchen').fill('Abelein')
        expect(page.locator('.dv-search-result').first).to_be_visible(timeout=30000)
        page.locator('.dv-search-result').first.click()
        expect(page.locator('.dv-document-detail pre')).to_contain_text('Abelein')
        page.get_by_label('Dokumentdarstellung').select_option('raw')
        expect(page.locator('.dv-raw')).to_contain_text('<!DOCTYPE DOCUMENT SYSTEM "MDB_STAMMDATEN.DTD">')
        assert not errors, errors
        browser.close()
    print(f'XML document e2e: opened, searched and viewed original source ({len(data)} bytes)')


if __name__ == '__main__':
    main()
