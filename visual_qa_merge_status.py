import json

from playwright.sync_api import sync_playwright

from visual_qa_features import (
    MERGE_FIXTURES,
    OUT,
    SQLITE_FIXTURE,
    install_native_bridge,
)


STATUS = '2 Dateien zu 6 Zeilen zusammengeführt · 1 Dubletten entfernt.'


with sync_playwright() as playwright:
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[str] = []
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
    install_native_bridge(page)
    page.route(
        'http://127.0.0.1:4187/__qa__/legacy_macos_test.sqlite',
        lambda route: route.fulfill(
            status=200,
            content_type='application/octet-stream',
            body=SQLITE_FIXTURE.read_bytes(),
        ),
    )
    page.route(
        'http://127.0.0.1:8787/status',
        lambda route: route.fulfill(
            status=200,
            content_type='application/json',
            headers={'Access-Control-Allow-Origin': '*'},
            body=json.dumps({'ok': True, 'service': 'Database Studio Ingest', 'port': 8787}),
        ),
    )
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('requestfailed', lambda request: failed_requests.append(f'{request.url}: {request.failure}'))

    page.goto('http://127.0.0.1:4187', wait_until='networkidle')
    page.get_by_text('Database System', exact=True).wait_for()
    page.locator('.cursor-command-center').click()
    quick = page.get_by_role('combobox', name='Datei schnell öffnen')
    quick.fill('legacy')
    quick.press('Enter')
    page.get_by_role('heading', name='macos_test').wait_for(timeout=15000)

    page.locator('button[title*="zusammenführen"]').click()
    merge = page.get_by_role('dialog', name='Dateien zusammenführen')
    merge.locator('input[type=file]').set_input_files([str(path) for path in MERGE_FIXTURES])
    merge.get_by_text('2 Tabellen').wait_for(timeout=15000)
    merge.get_by_role('checkbox', name='Dubletten entfernen').check()
    merge.get_by_text('1 Dubletten entfernt').wait_for(timeout=15000)
    merge.get_by_role('button', name='Zusammenführen').click()
    merge.wait_for(state='hidden', timeout=15000)

    status = page.get_by_role('status', name=STATUS, exact=True)
    status.wait_for(timeout=15000)
    assert status.get_attribute('title') == STATUS
    assert status.get_attribute('tabindex') == '0'
    assert page.get_by_text(STATUS, exact=True).count() == 0
    assert page.get_by_role('heading', name='visual_qa_ag_zusammengefuehrt').count() == 1
    assert page.get_by_role('button', name='Tab „visual_qa_ag_zusammengefuehrt.sqlite“ schließen').count() == 1

    page.screenshot(path=str(OUT / '14-merge-success-icon-1440x900.png'), full_page=False)
    box_1440 = status.bounding_box()
    assert box_1440 and box_1440['x'] >= 0 and box_1440['x'] + box_1440['width'] <= 1440

    page.set_viewport_size({'width': 1024, 'height': 700})
    page.wait_for_timeout(100)
    status.wait_for()
    page.screenshot(path=str(OUT / '15-merge-success-icon-1024x700.png'), full_page=False)
    box_1024 = status.bounding_box()
    assert box_1024 and box_1024['x'] >= 0 and box_1024['x'] + box_1024['width'] <= 1024
    assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')

    assert not console_errors, console_errors
    assert not page_errors, page_errors
    assert not failed_requests, failed_requests
    print(json.dumps({
        'status': STATUS,
        'box1440': box_1440,
        'box1024': box_1024,
        'consoleErrors': console_errors,
        'pageErrors': page_errors,
        'failedRequests': failed_requests,
    }, ensure_ascii=False, indent=2))
    browser.close()
