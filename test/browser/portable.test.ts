import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { chromium, type Page } from 'playwright-core';
import { readPortableRecord, waitForPortableTrip } from './portable-storage-helpers.ts';
import { backUpTrip, editMappedStop, openMenu, restSheet, toggleWholeTrip } from './journal-controls.ts';

async function openSampleTrip(page: Page) {
  await page.getByRole('button', { name: 'Try the sample trip' }).click();
  await page.locator('#title').filter({ hasText: 'A Thursday in Tel Aviv' }).waitFor();
}

async function showDayDetails(page: Page) {
  await page.locator('#otherSummary').waitFor();
  if (!await page.locator('#other').evaluate(element => (element as HTMLDetailsElement).open)) {
    await page.locator('#otherSummary').click();
  }
}

async function offeredFile(page: Page, link: string) {
  await page.waitForFunction(id => document.querySelector<HTMLAnchorElement>(id)?.href.startsWith('blob:'), link);
  const bytes = await page.evaluate(async id => {
    const response = await fetch(document.querySelector<HTMLAnchorElement>(id)!.href);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, link);
  const [[name, content]] = Object.entries(unzipSync(Uint8Array.from(bytes)));
  return { name, html: strFromU8(content) };
}
await test('a traveler imports a trip offline, sees its pins, reloads it and exports a shareable route', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    const asset = (relative: string) => new URL(relative, import.meta.url);
    await page.goto(asset('../../dist/web/Hayiti.html').href);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#languageSwitch').inputValue(), 'en');
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles(fileURLToPath(asset('../../public/sample-trip.json')));
    await page.locator('#preview button').click();
    await page.locator('#title').filter({
      hasText: 'A Thursday in Tel Aviv'
    }).waitFor();
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
    await page.reload();
    await page.locator('#title').filter({
      hasText: 'A Thursday in Tel Aviv'
    }).waitFor();
    await page.locator('#share').click();
    await page.waitForFunction(() => document.querySelector<HTMLAnchorElement>('#downloadTrip')?.href.startsWith('blob:'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

await test('a portable route package previews and saves a new stop order without new geometry', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await openSampleTrip(page);
    const previous = ['cafe', 'gelato', 'pickup', 'dropoff', 'museum', 'brewery', 'show'];
    const next = ['gelato', 'cafe', 'pickup', 'dropoff', 'museum', 'brewery', 'show'];
    const upload = async (routes: Record<string, unknown>[] = []) => {
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      await page.locator('#file').setInputFiles({
        name: 'agent-routes.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti-routes/1', tripId: 'tel-aviv-sample',
          days: [{ date: '2026-03-12', order: { previous, next }, routes }] }))
      });
    };
    const firstStop = page.locator('#stops .stopname').first();
    await upload();
    await page.locator('#preview').getByText('Days with a new stop order · 1').waitFor();
    assert.equal(await firstStop.textContent(), 'Café Sonder');
    await page.getByRole('button', { name: 'Save routes' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    await page.reload();
    await firstStop.filter({ hasText: 'Anita Gelato' }).waitFor();
    await upload();
    await page.locator('#preview').getByText('0 route segments to update', { exact: false }).waitFor();
    assert.equal(await page.locator('#preview button').count(), 0);
    await page.locator('#sources [data-close]').click();
    await upload([{ a: 'pickup', b: 'dropoff', type: 'gap', line: [], correctTaxi: true }]);
    await page.locator('#preview').getByText('Taxi rides to reclassify · 1').waitFor();
    await page.getByRole('button', { name: 'Save routes' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    const saved = (await readPortableRecord(page))!.trips[0];
    assert.deepEqual(saved.stops.filter((stop: { id: string }) => ['pickup', 'dropoff'].includes(stop.id))
      .map((stop: { kind: string }) => stop.kind), ['visit', 'visit']);
    assert.equal(saved.edges.find((edge: { a: string, b: string }) => edge.a === 'pickup' && edge.b === 'dropoff')?.type, 'gap');
  } finally {
    await browser.close();
  }
});

await test('the journal honors language preferences and the public pages stay in English', async () => {
  const browser = await chromium.launch();
  try {
    for (const locale of ['en-IL', 'fr-FR', 'he', 'he-IL']) {
      const hebrew = locale.startsWith('he');
      const page = await browser.newPage({ locale });
      await page.route('https://**/*', route => route.abort());
      const web = new URL('../../dist/web/', import.meta.url);
      await page.goto(new URL('Hayiti.html', web).href);
      assert.equal(await page.locator('html').getAttribute('lang'), hebrew ? 'he' : 'en');
      assert.equal(await page.locator('#languageSwitch').inputValue(), hebrew ? 'he' : 'en');
      assert.equal(await page.locator('.brand-signature').getAttribute('alt'), 'hayiti');
      assert.equal(await page.locator('.brand').innerText(), '');
      if (!hebrew) assert.doesNotMatch(await page.locator('body').innerText(), /\p{Script=Hebrew}/u);
      await page.locator('#languageSwitch').selectOption(hebrew ? 'en' : 'he');
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('lang'), hebrew ? 'en' : 'he');
      for (const name of ['support.html', 'privacy.html', 'terms.html']) {
        await page.goto(new URL(name, web).href);
        assert.equal(await page.locator('html').getAttribute('lang'), 'en');
        assert.equal(await page.locator('#languageSwitch').count(), 0);
        assert.doesNotMatch(await page.locator('body').innerText(), /\p{Script=Hebrew}/u);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('an empty search, a missing payment account and a disconnected source have distinct guidance', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    for (const [source, status, summary, detail] of [
      ['finances', 'no_transactions', 'No transactions for these dates', 'receipts from Gmail'],
      ['finances', 'no_accounts', 'Link a payment account', 'credit card or a checking account'],
      ['gmail', 'disconnected', '1 source disconnected', 'Connect this source in ChatGPT']
    ] as const) {
      await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      const date = '2026-06-14';
      const trip = {
        id: status, title: status, start: date, end: date, stops: [],
        checks: { [source]: { status, start: date, end: date, at: date + 'T12:00:00Z' } }
      };
      await page.locator('#file').setInputFiles({
        name: 'fictional-trip.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip }))
      });
      await page.locator('#preview button').click();
      await page.getByRole('button', { name: 'Sources and import · ' + summary, exact: true }).click();
      await page.getByText(detail, { exact: false }).waitFor();
      await page.locator('#sources [data-close]').click();
    }
  } finally {
    await browser.close();
  }
});

await test('editing the default home preserves a separate overnight stop', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const trip = {
      id: 'hotels', title: 'Two hotels', start: '2026-06-14', end: '2026-06-15',
      home: 'Hotel A', homeXY: [51, 4],
      stops: [
        { id: 'a', date: '2026-06-14', kind: 'origin', name: 'Hotel A', xy: [51, 4] },
        { id: 'b', date: '2026-06-15', kind: 'origin', name: 'Hotel B', address: 'East road', xy: [52, 5] }
      ]
    };
    await page.addInitScript(data => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [data] })), trip);
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.locator('#settings').click();
    await page.locator('#tripForm [name=home]').fill('New home');
    await page.locator('#tripForm [name=coords]').fill('53, 6');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    const saved = (await readPortableRecord(page))!.trips[0];
    assert.equal(saved.stops[0].name, 'New home');
    assert.deepEqual(saved.stops[0].xy, [53, 6]);
    assert.equal(saved.stops[1].name, 'Hotel B');
    assert.deepEqual(saved.stops[1].xy, [52, 5]);
    assert.equal(saved.stops[1].address, 'East road');
  } finally {
    await browser.close();
  }
});

await test('refresh keeps an in-memory trip when portable storage is unavailable', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../../public/sample-trip.json', import.meta.url)));
    await page.locator('#preview button').click();
    await page.locator('#import').click();
    await page.locator('[data-tab="connected"]').click();
    await page.locator('#reload').click();
    await page.locator('#sources [data-close]').click();
    assert.equal(await page.locator('#title').textContent(), 'A Thursday in Tel Aviv');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
  } finally {
    await browser.close();
  }
});

await test('retrying a failed import applies the selected records exactly once', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../fixtures/rotterdam.json', import.meta.url)));
    await page.locator('#preview button').click();
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'stops.csv', mimeType: 'text/csv', buffer: Buffer.from('date,merchant\n2026-06-14,Ferry Terminal')
    });
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === 'hayiti-portable' && key === 'current-v3') {
          IDBObjectStore.prototype.put = put;
          throw new DOMException('Transient write failure', 'QuotaExceededError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await page.locator('#preview button').click();
    await page.locator('#sources .form-error').filter({ hasText: /could not save the edit/ }).waitFor();
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    await page.reload();
    const ferry = page.locator('#unlocatedList').getByText('Ferry Terminal', { exact: true });
    await ferry.first().waitFor({ state: 'attached' });
    assert.equal(await ferry.count(), 1);
    assert.equal(await page.locator('#stops .stopname').count(), 2);
  } finally {
    await browser.close();
  }
});

await test('a photo-heavy portable journal survives localStorage quota and reload', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const photo = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(280000);
    const stops = Array.from({ length: 24 }, (_, index) => ({
      id: 'photo-' + index, name: 'Visit ' + index, date: '2026-06-14', photos: [photo]
    }));
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'photos.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: {
        id: 'photos', title: 'Photo trip', start: '2026-06-14', end: '2026-06-14', stops
      } }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('masluli-portable-v2')!)), { hayitiUpgradeRequired: true });
    await page.reload();
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Visit 23', exact: true }).click();
    assert.equal(await page.locator('#photoPanel img').getAttribute('src'), photo);
    await page.locator('#editForm [name=name]').fill('Edited after migration');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await page.reload();
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByText('Edited after migration', { exact: true }).waitFor();
    assert.equal(await page.locator('#unlocatedList .detail-row').count(), 24);
    assert.equal(await page.locator('#stops .stopname').count(), 0);
  } finally {
    await browser.close();
  }
});

await test('missing sources and the last removed photo show Not recorded', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const stops = [
      { id: 'a', date, name: 'Park' },
      { id: 'b', date, name: 'Beach', sources: ['photo'], photos: ['data:image/jpeg;base64,/9j/AAAA'] }
    ];
    await page.addInitScript(trip => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [trip] })),
      { id: 'trip', title: 'Day out', start: date, end: date, stops });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const source = page.locator('#editForm [name=source]');
    const selected = source.locator('option:checked');
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Park', exact: true }).click();
    assert.deepEqual(await selected.allTextContents(), ['Not recorded']);
    await source.selectOption('manual');
    await source.selectOption('');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Beach', exact: true }).click();
    await page.locator('#photoPanel button').click();
    assert.deepEqual(await selected.allTextContents(), ['Not recorded']);
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    const saved = (await readPortableRecord(page))!.trips[0];
    assert.deepEqual(saved.stops.map((stop: { sources: string[] }) => stop.sources), [[], []]);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Beach', exact: true }).click();
    assert.deepEqual(await selected.allTextContents(), ['Not recorded']);
  } finally {
    await browser.close();
  }
});

await test('correcting a stop\'s source replaces the old one and keeps corroborating sources', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const trip = {
      id: 'sources', title: 'Sources', start: '2026-06-14', end: '2026-06-14',
      stops: [
        { id: 'a', date: '2026-06-14', name: 'Markthal', sources: ['card', 'email'], refs: ['a'] },
        { id: 'b', date: '2026-06-14', name: 'Beach', sources: ['photo'], photos: ['data:image/jpeg;base64,/9j/AAAA'] }
      ]
    };
    await page.addInitScript(data => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [data] })), trip);
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Markthal', exact: true }).click();
    assert.equal(await page.locator('#editForm [name=source]').inputValue(), 'card');
    await page.locator('#editForm [name=source]').selectOption('manual');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Beach', exact: true }).click();
    assert.equal(await page.locator('#editForm [name=source]').inputValue(), 'photo');
    await page.locator('#editForm [name=notes]').fill('Evening visit');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    const saved = (await readPortableRecord(page))!.trips[0];
    assert.deepEqual(saved.stops[0].sources, ['manual', 'email']);
    assert.deepEqual(saved.stops[1].sources, ['photo']);
    assert.equal(saved.stops[1].notes, 'Evening visit');
  } finally {
    await browser.close();
  }
});

await test('untitled backups follow the display language and traveler-written titles stay verbatim', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const trip = { id: 'untitled', start: '2026-06-14', end: '2026-06-14', stops: [] };
    const importBackup = async (record: typeof trip & { title?: string }) => {
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      await page.locator('#file').setInputFiles({
        name: 'trip.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: record }))
      });
      await page.locator('#preview button').click();
      await page.locator('#sources').waitFor({ state: 'hidden' });
    };
    await importBackup(trip);
    assert.equal(await page.locator('#title').textContent(), 'My trip');
    await page.locator('#settings').click();
    assert.equal(await page.locator('#tripForm [name=title]').inputValue(), '');
    await page.locator('#tripForm [name=home]').fill('Hotel');
    await page.locator('#tripForm .primary').click();
    // Offline, the address cannot be looked up. The form says so, and saving again keeps it without a pin.
    await page.locator('#config .form-error').filter({ hasText: 'Address search is unavailable right now.' }).waitFor();
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.locator('#languageSwitch').selectOption('he');
    assert.equal(await page.locator('#title').textContent(), 'הטיול שלי');
    await page.locator('#languageSwitch').selectOption('en');
    await importBackup({ ...trip, id: 'named', title: 'הטיול שלי' });
    await page.reload();
    await page.locator('#trips option').first().waitFor({ state: 'attached' });
    assert.deepEqual(await page.locator('#trips option').allTextContents(), ['My trip', 'הטיול שלי']);
    await page.locator('#trips').selectOption('named');
    assert.equal(await page.locator('#title').textContent(), 'הטיול שלי');
  } finally {
    await browser.close();
  }
});

await test('an empty journal opens the sample trip in one step and links each stop to its pin', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await openSampleTrip(page);
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
    assert.equal(await page.locator('#welcome').isVisible(), false);

    await page.locator('.leaflet-marker-icon').first().click();
    assert.equal(await page.locator('#stops .activeStop .stopname').textContent(), 'Café Sonder');
    const evidence = page.locator('#stops .stop').filter({ hasText: 'Anita Gelato' }).locator('.src');
    const box = (await evidence.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.locator('#stops .activeStop .stopname').textContent(), 'Anita Gelato');
    await page.locator('.leaflet-popup').filter({ hasText: 'Anita Gelato' }).getByRole('button', { name: 'Edit details' }).click();
    assert.equal(await page.locator('#editForm [name=name]').inputValue(), 'Anita Gelato');
  } finally {
    await browser.close();
  }
});

await test('reordering keeps keyboard focus, and Suggest walking order explains a day it cannot sort', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await openSampleTrip(page);
    await page.getByRole('button', { name: 'Move later: Café Sonder' }).click();
    await page.locator('#stops .stop').nth(1).filter({ hasText: 'Café Sonder' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Move later: Café Sonder');

    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Empty day');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.locator('#organize').click();
    await page.locator('#status').filter({ hasText: 'Add at least two stops' }).waitFor();
    assert.equal(await page.locator('#confirmBox').getAttribute('open'), null);
    assert.deepEqual(dialogs, []);
  } finally {
    await browser.close();
  }
});

await test('a stop can be dragged several places with a mouse or touch, then moved with an arrow', async () => {
  const browser = await chromium.launch();
  try {
    for (const hasTouch of [false, true]) {
      const page = await browser.newPage({ hasTouch, viewport: hasTouch ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
      await page.route('https://**/*', route => route.abort());
      await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
      await openSampleTrip(page);
      if (hasTouch) {
        await restSheet(page, 'full');
        await page.waitForFunction(() => Math.abs(document.getElementById('panel')!.offsetHeight -
          parseFloat(document.documentElement.style.getPropertyValue('--sheet'))) < 1);
      }
      const stops = page.locator('#stops .stop');
      const handle = stops.first().locator('.stop-grip');
      const target = stops.nth(2);
      const start = (await handle.boundingBox())!, end = (await target.boundingBox())!;
      const x = start.x + start.width / 2, y = start.y + start.height / 2, bottom = end.y + end.height - 4;
      if (hasTouch) {
        const input = await page.context().newCDPSession(page);
        await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 12; step++) {
          await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (bottom - y) * step / 12 }] });
        }
        await page.waitForFunction(() => document.querySelector('#stops .stop:nth-child(3) .stopname')?.textContent === 'Café Sonder');
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await handle.dragTo(target, { targetPosition: { x: end.width / 2, y: end.height - 4 } });
      }
      const names = page.locator('#stops .stopname');
      await names.nth(2).filter({ hasText: 'Café Sonder' }).waitFor();
      await page.reload();
      await names.nth(2).filter({ hasText: 'Café Sonder' }).waitFor();
      assert.deepEqual((await names.allTextContents()).slice(0, 3), ['Anita Gelato', 'Taxi pickup in Neve Tzedek', 'Café Sonder']);
      if (hasTouch) await restSheet(page, 'full');
      await page.getByRole('button', { name: 'Move earlier: Café Sonder' }).click();
      await names.nth(1).filter({ hasText: 'Café Sonder' }).waitFor();
      assert.equal(await page.locator('.leaflet-popup').count(), 0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('Escape cancels choosing a point on the map and returns to the stop being edited', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    await openSampleTrip(page);
    await page.locator('#add').click();
    await page.locator('#editForm [name=name]').fill('Half-written stop');
    await page.locator('#pick').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.locator('#edit').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#edit').getAttribute('open'), '');
    assert.equal(await page.locator('#editForm [name=name]').inputValue(), 'Half-written stop');
    await page.keyboard.press('Escape');
    await page.locator('#edit').waitFor({ state: 'hidden' });
  } finally {
    await browser.close();
  }
});

await test('a journal that lives only in its tab asks before leaving until the trip is backed up', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    await page.goto(new URL('../../dist/web/Hayiti.html', import.meta.url).href);
    const asksBeforeLeaving = () => page.evaluate(() => {
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    });
    assert.equal(await asksBeforeLeaving(), false);
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Kept in memory');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#status').getAttribute('data-tone'), 'warning');
    assert.equal(await asksBeforeLeaving(), true);
    const download = page.waitForEvent('download');
    await backUpTrip(page);
    await download;
    assert.equal(await asksBeforeLeaving(), false);
  } finally {
    await browser.close();
  }
});

await test('a journal file makes an exact copy of the blank app and a route file that opens with its pins', async () => {
  const browser = await chromium.launch();
  const folder = await mkdtemp(join(tmpdir(), 'hayiti-route-'));
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const built = new URL('../../dist/web/Hayiti.html', import.meta.url);
    await page.goto(built.href);
    await openSampleTrip(page);
    await page.locator('#share').click();

    const app = await offeredFile(page, '#downloadApp');
    const original = await readFile(built, 'utf8');
    assert.equal(app.html.length, original.length);
    assert.ok(app.html === original, 'the blank app made from a running journal matches the built file');
    assert.equal(original.split('data-part="street-map">').length, 2);

    const route = await offeredFile(page, '#downloadTrip');
    const saved = join(folder, route.name);
    await writeFile(saved, route.html);
    const viewer = await browser.newPage({ viewport: { width: 390, height: 664 } }),
      errors: string[] = [];
    viewer.on('pageerror', error => errors.push(error.message));
    await viewer.route('https://**/*', request => request.abort());
    await viewer.goto(pathToFileURL(saved).href);
    await viewer.locator('#title').filter({ hasText: 'A Thursday in Tel Aviv' }).waitFor();
    assert.equal(await viewer.locator('body').getAttribute('data-sheet'), 'half');
    await viewer.getByRole('status').filter({ hasText: 'Route copy · View only' }).waitFor();
    assert.equal(await viewer.locator('.leaflet-marker-icon').count(), 7);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(folder, { recursive: true });
  }
});

await test('without a connection the map says the streets could not load and still shows the pins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await openSampleTrip(page);
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'The street map could not load. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);

    // The streets arrive when the connection returns, drawn by the worker the file carries.
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } }] }
    }));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#map canvas.maplibregl-canvas').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), null);
  } finally {
    await browser.close();
  }
});

await test('a browser that cannot draw the street map says so and still shows the pins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith('webgl') ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await openSampleTrip(page);
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'This browser cannot draw the street map. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
  } finally {
    await browser.close();
  }
});

async function samplePins(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route('https://**/*', route => route.abort());
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } }] }
  }));
  await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
  await openSampleTrip(page);
  await page.locator('#map[data-note]').waitFor();
  const places = () => page.evaluate(() => Array.from(document.querySelectorAll('.leaflet-marker-icon'), pin => {
    const box = pin.getBoundingClientRect();
    return [Math.round(box.x), Math.round(box.y)];
  }));
  await page.waitForTimeout(800);
  const loaded = await places();
  for (let step = 0; step < 2; step++) {
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(800);
  }
  return { note: await page.locator('#map').getAttribute('data-note'), loaded, zoomed: await places(), layers: await page.locator('.leaflet-gl-layer').count() };
}

await test('a browser whose street map cannot start keeps every pin where a browser without WebGL shows it', async () => {
  const browser = await chromium.launch();
  try {
    // The reference: no WebGL at all, so the street map is never tried.
    const plain = await browser.newPage();
    await plain.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith('webgl') ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    const expected = await samplePins(plain);
    assert.equal(expected.loaded.length, 7);
    assert.notDeepEqual(expected.zoomed, expected.loaded);

    // An older browser has the first version of WebGL only.
    const older = await browser.newPage(),
      olderErrors: string[] = [];
    older.on('pageerror', error => olderErrors.push(error.message));
    await older.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind === 'webgl2' ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    assert.deepEqual(await samplePins(older), expected);
    assert.deepEqual(olderErrors, []);

    // A browser can also offer WebGL and then refuse it to the map itself.
    const refusing = await browser.newPage(),
      refusingErrors: string[] = [];
    refusing.on('pageerror', error => refusingErrors.push(error.message));
    await refusing.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return kind.startsWith('webgl') && this.className.includes('maplibregl') ? null : Reflect.apply(getContext, this, [kind, ...rest]);
      } as typeof getContext;
    });
    assert.deepEqual(await samplePins(refusing), expected);
    assert.deepEqual(refusingErrors, []);
  } finally {
    await browser.close();
  }
});

await test('streets that fail to load after the style say so and load when the connection returns', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        version: 8,
        sources: { streets: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
        layers: [
          { id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } },
          { id: 'roads', type: 'line', source: 'streets', 'source-layer': 'transportation' }
        ]
      }
    }));
    let connected = false,
      described = 0,
      tiles = 0;
    await page.route('https://tiles.openfreemap.org/planet', route => {
      if (!connected) return route.abort();
      described++;
      return route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: { tilejson: '2.2.0', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }
      });
    });
    await page.route('https://tiles.openfreemap.org/planet/**', route => {
      tiles++;
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await openSampleTrip(page);
    await page.locator('#map canvas.maplibregl-canvas').waitFor();
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'The street map could not load. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);

    connected = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#map:not([data-note]) canvas.maplibregl-canvas').waitFor();
    await page.waitForTimeout(1500);
    assert.equal(described, 1);
    assert.ok(tiles > 0, 'the street tiles are requested after the connection returns');
    assert.equal(await page.locator('#map').getAttribute('data-note'), null);
    assert.equal(await page.locator('#map canvas.maplibregl-canvas').count(), 1);
  } finally {
    await browser.close();
  }
});

await test('the street map note goes away once every street tile in view has loaded', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        version: 8,
        sources: { streets: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
        layers: [
          { id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } },
          { id: 'roads', type: 'line', minzoom: 8, source: 'streets', 'source-layer': 'transportation' }
        ]
      }
    }));
    let described = 0,
      failing = true;
    await page.route('https://tiles.openfreemap.org/planet', route => {
      described++;
      return route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: { tilejson: '2.2.0', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }
      });
    });
    await page.route('https://tiles.openfreemap.org/planet/**', route => failing
      ? route.abort()
      : route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }));
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await openSampleTrip(page);
    await page.locator('#map[data-note]').waitFor();

    // The tiles that failed are still in view after a small move, so the note stays.
    failing = false;
    await page.mouse.move(400, 400);
    await page.mouse.down();
    await page.mouse.move(404, 404, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'The street map could not load. Pins and routes still appear.');

    // A closer view needs other tiles. They load, and nothing in view is missing any more.
    for (let step = 0; step < 4; step++) {
      await page.locator('.leaflet-control-zoom-in').click();
      await page.locator('.leaflet-zoom-anim').waitFor({ state: 'attached' });
      await page.locator('.leaflet-zoom-anim').waitFor({ state: 'detached' });
    }
    await page.locator('#map:not([data-note]) canvas.maplibregl-canvas').waitFor();
    assert.equal(described, 1, 'the street map was not drawn again from the start');
  } finally {
    await browser.close();
  }
});

await test('a terrain image that failed on the overview does not keep the note at street level', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        version: 8,
        sources: { relief: { type: 'raster', tiles: ['https://tiles.openfreemap.org/natural_earth/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 6 } },
        layers: [
          { id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } },
          { id: 'relief', type: 'raster', source: 'relief', maxzoom: 7 }
        ]
      }
    }));
    let images = 0;
    await page.route('https://tiles.openfreemap.org/natural_earth/**', route => {
      images++;
      return route.abort();
    });
    // The empty journal opens on a map of the world, which draws the terrain images.
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.locator('#map[data-note]').waitFor({ state: 'attached' });
    assert.ok(images > 0);

    // The sample trip is shown at street level, where the terrain images are not part of the map.
    await openSampleTrip(page);
    await page.locator('#map:not([data-note]) canvas.maplibregl-canvas').waitFor();
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 7);
  } finally {
    await browser.close();
  }
});

await test('the desktop panel stays on the left while the toolbar follows the language', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 900 } });
    await page.route('https://**/*', route => route.abort());
    for (const language of ['he', 'en']) {
      await page.goto(new URL('../../dist/web/Hayiti.html?lang=' + language, import.meta.url).href);
      // The sample trip stays in the browser after the first language.
      if (language === 'he') await page.locator('#trySample').click();
      await page.locator('.leaflet-marker-icon').first().waitFor();
      for (const width of [2560, 1728, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const edges = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const brand = box('.brand'), bar = box('header nav'), panel = box('#panel');
          const rtl = document.documentElement.dir === 'rtl';
          return { panel: panel.left, brand: rtl ? innerWidth - brand.right : brand.left,
            bar: rtl ? bar.left : innerWidth - bar.right, map: box('#map').width };
        });
        assert.equal(edges.panel, 12, language + ' at ' + width);
        assert.equal(edges.brand, 12, language + ' at ' + width);
        assert.equal(edges.bar, 12, language + ' at ' + width);
        assert.equal(edges.map, width, 'the map fills the window at ' + width);
      }
      const menu = await page.locator('#languageSwitch').evaluate(element => {
        const style = getComputedStyle(element);
        return { arrow: style.backgroundImage.startsWith('url('), room: parseFloat(style.paddingRight), height: Math.round(element.getBoundingClientRect().height) };
      });
      assert.equal(menu.arrow, true);
      assert.ok(menu.room >= 24, 'the arrow has room beside the language code');
      assert.equal(menu.height, Math.round((await page.locator('#share').boundingBox())!.height));
    }
  } finally {
    await browser.close();
  }
});

await test('in high-contrast mode the menus keep the arrow the browser draws', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ forcedColors: 'active', colorScheme: 'light' });
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.locator('#trySample').click();
    await page.locator('.leaflet-marker-icon').first().waitFor();
    // The browser repaints these menus in the traveler's colors, where an arrow drawn in a fixed color can vanish.
    for (const menu of ['#languageSwitch', '#trips']) {
      assert.deepEqual(await page.locator(menu).evaluate(element => {
        const style = getComputedStyle(element);
        return { appearance: style.appearance, image: style.backgroundImage };
      }), { appearance: 'auto', image: 'none' }, menu);
    }
  } finally {
    await browser.close();
  }
});

await test('the traveler re-times and moves a photo pin, and a new home base drops the route from the old one', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const home = [32.07, 34.77], camera = [32.08, 34.78], anchor = [32.0805, 34.78], museum = [32.085, 34.784];
    const ride = { a: 'pin', b: 'museum', type: 'taxi', m: 900, line: [camera, museum] };
    await page.addInitScript(trip => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [trip] })), {
      id: 'trip', title: 'Day out', start: date, end: date, home: 'Hotel', homeXY: home,
      stops: [{ id: 'pin', date, name: 'Camera pin', xy: camera, photoAnchor: anchor, captureTime: '14:00:10', sources: ['photo'], refs: ['asset-1'] },
        { id: 'museum', date, name: 'Museum', xy: museum, rank: 1 }],
      edges: [{ a: 'base', b: 'pin', type: 'walk', m: 1500, line: [home, camera] }, ride]
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const saved = async () => (await readPortableRecord(page))!.trips[0];
    const openPin = () => editMappedStop(page, 'Camera pin');
    const save = async (dialog: string, form: string) => {
      await page.locator(form + ' .primary').click();
      await page.locator(dialog).waitFor({ state: 'hidden' });
    };

    // The camera recorded 14:00:10. The traveler knows better, and the capture time goes with the old minute.
    await openPin();
    await page.locator('#editForm [name=time]').fill('14:30');
    await save('#edit', '#editForm');
    let trip = await saved();
    assert.deepEqual([trip.stops[0].time, trip.stops[0].captureTime, trip.stops[0].edited, trip.stops[0].photoAnchor, trip.edges.length],
      ['14:30', undefined, true, anchor, 2]);

    await page.locator('#settings').click();
    await page.locator('#moreTrip').evaluate((more: HTMLDetailsElement) => { more.open = true; });
    await page.locator('#tripForm [name=coords]').fill('32.06, 34.76');
    await save('#config', '#tripForm');
    trip = await saved();
    assert.deepEqual([trip.homeXY, trip.edges], [[32.06, 34.76], [ride]]);

    await openPin();
    await page.locator('#moreStop').evaluate((more: HTMLDetailsElement) => { more.open = true; });
    await page.locator('#editForm [name=coords]').fill('32.09, 34.79');
    await save('#edit', '#editForm');
    trip = await saved();
    assert.deepEqual([trip.stops[0].xy, trip.stops[0].photoAnchor, trip.stops[0].time], [[32.09, 34.79], undefined, '14:30']);
    assert.deepEqual(trip.edges, [{ ...ride, m: 0, line: [] }]);
  } finally {
    await browser.close();
  }
});

await test('the portable journal, which has no account, welcomes a traveler without sending them to one', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.locator('#welcome').waitFor();
    assert.deepEqual(await page.locator('#welcome h3:visible').allTextContents(), ['Rebuild a trip from what you already have']);
    assert.equal(await page.locator('#welcome a:visible').count(), 0);
    await page.locator('#languageSwitch').selectOption('he');
    assert.deepEqual(await page.locator('#welcome h3:visible').allTextContents(), ['משחזרים טיול ממה שכבר יש לך']);
  } finally {
    await browser.close();
  }
});

await test('Google Pins belong to the selected day or the whole trip without joining either day’s route', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.route('https://**/*', route => route.abort());
    const firstDay = '2026-06-14', secondDay = '2026-06-15';
    const trip = {
      id: 'two-days', title: 'Two days on the river', start: firstDay, end: secondDay,
      stops: [
        { id: 'dock', date: firstDay, name: 'First dock', xy: [52, 4], rank: 1 },
        { id: 'market', date: firstDay, name: 'First market', xy: [52.01, 4.01], rank: 2 },
        { id: 'garden', date: secondDay, name: 'Second garden', xy: [52.09, 4.09], rank: 1 },
        { id: 'hall', date: secondDay, name: 'Second hall', xy: [52.10, 4.10], rank: 2 }
      ],
      edges: [
        { a: 'dock', b: 'market', type: 'walk', m: 1500, line: [[52, 4], [52.01, 4.01]] },
        { a: 'garden', b: 'hall', type: 'walk', m: 1800, line: [[52.09, 4.09], [52.10, 4.10]] }
      ],
      googlePins: [
        { id: 'quay', savedAt: firstDay + 'T23:45:00+02:00', name: 'Old quay', xy: [52.01, 4] },
        { id: 'tower', date: secondDay, name: 'Bell tower', xy: [52.10, 4.09] },
        { id: 'cove', name: 'Hidden cove', xy: [52.06, 4.035], date: '2019-01-01' }
      ]
    };
    const { googlePins, ...itinerary } = trip;
    const web = new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url);
    await page.goto(web.href);
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'two-days.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: itinerary }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    const importPins = async () => {
      await page.locator('#import').click();
      await page.locator('[data-tab=files]').click();
      await page.locator('#file').setInputFiles({
        name: 'pins.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti-stops/1', tripId: trip.id, stops: [], googlePins }))
      });
    };
    await importPins();
    const outsideDay = 'One date falls outside the trip. Pins without a day appear in Whole trip.';
    await page.locator('#preview').filter({ hasText: outsideDay }).waitFor();
    await page.getByRole('button', { name: 'Save Google Pins' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    await page.locator('#status').filter({ hasText: outsideDay }).waitFor();

    const scope = page.locator('#wholeTrip'), markers = page.locator('.leaflet-marker-icon.google-pin');
    const names = () => markers.evaluateAll(pins => pins.map(pin => pin.getAttribute('title')).sort());
    const routePaths = page.locator('#map svg path.leaflet-interactive');
    assert.equal(await scope.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await names(), ['Old quay · Google Pin']);
    await markers.click();
    assert.equal(await page.locator('.google-pin-popup time').getAttribute('datetime'), firstDay + 'T23:45:00+02:00');
    await page.locator('.leaflet-popup-close-button').click();
    const firstWalk = await page.locator('#walkSummary').innerText();
    assert.match(firstWalk, /1\.5 km/);
    assert.equal(await page.locator('#statStops').textContent(), '2 stops');
    assert.equal(await routePaths.count(), 1);

    await toggleWholeTrip(page);
    assert.equal(await scope.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await names(), ['Bell tower · Google Pin', 'Hidden cove · Google Pin', 'Old quay · Google Pin']);
    assert.equal(await routePaths.count(), 2, 'two daily walks stay separate across the overnight gap');
    await page.locator('.google-pin[title="Hidden cove · Google Pin"]').click();
    const popup = page.locator('.google-pin-popup').filter({ hasText: 'Hidden cove' });
    await popup.getByText('Google save date unavailable').waitFor();
    assert.equal(await popup.getByRole('combobox', { name: 'Trip day' }).inputValue(), '');
    await popup.getByRole('combobox', { name: 'Trip day' }).selectOption(secondDay);
    await page.locator('#stops button[data-day="' + secondDay + '"]').click();
    assert.equal(await scope.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#tripDate').inputValue(), secondDay);
    assert.deepEqual(await names(), ['Bell tower · Google Pin', 'Hidden cove · Google Pin']);
    assert.match(await page.locator('#walkSummary').innerText(), /1\.8 km/);
    assert.equal(await page.locator('#statStops').textContent(), '2 stops');
    assert.equal(await routePaths.count(), 1);

    await page.reload();
    await page.locator('#dayReel').waitFor();
    await page.locator('#tripDate').selectOption(firstDay);
    assert.deepEqual(await names(), ['Old quay · Google Pin']);
    assert.equal(await page.locator('#walkSummary').innerText(), firstWalk);
    await page.locator('#tripDate').selectOption(secondDay);
    assert.deepEqual(await names(), ['Bell tower · Google Pin', 'Hidden cove · Google Pin']);
    await importPins();
    await page.locator('#preview').getByText(/3 already saved/).waitFor();
    assert.equal(await page.locator('#preview button').count(), 0);
    await page.locator('#sources [data-close]').click();
    await page.locator('#share').click();
    const exported = await offeredFile(page, '#downloadTrip');
    for (const { name } of googlePins) assert.equal(exported.html.includes(name), false, 'shared trip excludes ' + name);
  } finally {
    await browser.close();
  }
});

await test('changing a basemap loads its tiles without moving the daily route or its pins', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=', 'base64');
    await page.route('https://**/*', route => route.abort());
    await page.route(/https:\/\/(?:tiles\.maps\.eox\.at|[abc]\.tile\.opentopomap\.org)\//, route =>
      route.fulfill({ contentType: 'image/png', body: image, headers: { 'access-control-allow-origin': '*' } }));
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await openSampleTrip(page);
    await page.locator('.leaflet-marker-icon').first().waitFor();
    const shape = () => page.locator('#map svg path.leaflet-interactive').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
    const places = () => page.locator('.leaflet-marker-icon').evaluateAll(pins => pins.map(pin => [pin.getAttribute('title'), pin.style.transform]));
    const types = page.locator('#mapStyle'), scope = page.locator('#wholeTrip');
    assert.equal(await types.inputValue(), 'streets');
    const day = await page.locator('#tripDate').inputValue();
    const original = await places(), route = await shape();
    assert.ok(original.length > 1 && route.length > 0);
    for (const [choice, provider] of [['satellite', 'eox.at'], ['terrain', 'opentopomap.org']] as const) {
      await openMenu(page);
      await types.selectOption(choice);
      await page.locator('.leaflet-tile-loaded[src*="' + provider + '"]').first().waitFor();
      assert.deepEqual(await places(), original);
      assert.deepEqual(await shape(), route);
      assert.equal(await scope.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('#tripDate').inputValue(), day);
    }
    await openMenu(page);
    await types.selectOption('streets');
    assert.equal(await page.locator('.leaflet-tile-loaded').count(), 0);
    assert.deepEqual(await places(), original);
  } finally {
    await browser.close();
  }
});

await test('the map controls leave pins and an opened popup uncovered, and a Google Pin can be removed', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await page.route('https://**/*', route => route.abort());
    const first = '2026-06-14', second = '2026-06-15';
    // The northernmost, easternmost places sit in the corner the controls occupy.
    await page.addInitScript(trip => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [trip] })), {
      id: 'trip', title: 'Weekend', start: first, end: second, home: 'Hotel', homeXY: [32.07, 34.77],
      stops: [
        { id: 'market', date: first, name: 'Market', xy: [32.0685, 34.7689], rank: 1, sources: ['card'], refs: ['c1'] },
        { id: 'lookout', date: first, name: 'Lookout', xy: [32.076, 34.774], rank: 2, sources: ['photo'], refs: ['p1'] },
        { id: 'port', date: second, name: 'Port', xy: [32.052, 34.75], rank: 1, sources: ['calendar'], refs: ['e1'] }
      ],
      googlePins: [
        { id: 'corner', name: 'Saved café with a fairly long name', xy: [32.0762, 34.7745], date: first },
        { id: 'south', name: 'Saved beach', xy: [32.06, 34.76] }
      ]
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const covered = (selector: string) => page.evaluate(target => {
      const controls = document.querySelector('header nav')!.getBoundingClientRect();
      return [...document.querySelectorAll(target)].filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.left < controls.right && box.right > controls.left && box.top < controls.bottom && box.bottom > controls.top;
      }).length;
    }, selector);

    for (const view of ['day', 'whole trip']) {
      if (view === 'whole trip') await toggleWholeTrip(page);
      await page.locator('.google-pin').first().waitFor();
      await page.waitForFunction(() => !document.querySelector('.leaflet-zoom-anim'));
      assert.equal(await covered('#map .pin, #map .google-pin'), 0, view + ' pins clear the controls');
    }
    await page.getByRole('button', { name: /Saved café with a fairly long name/ }).click();
    const popup = page.locator('.google-pin-popup');
    await popup.waitFor();
    await page.waitForFunction(() => !document.querySelector('.leaflet-pan-anim'));
    assert.equal(await covered('#map .leaflet-popup'), 0, 'the popup clears the controls');

    await popup.getByRole('button', { name: 'Remove from trip' }).click();
    await page.locator('#confirmYes').click();
    await waitForPortableTrip(page, { googlePinCount: 1 });
    const trip = (await readPortableRecord(page))!.trips[0];
    assert.deepEqual([trip.googlePins?.map((pin: { id: string }) => pin.id), trip.stops.length], [['south'], 3]);
    assert.equal(await page.locator('#map .google-pin').count(), 1);
  } finally {
    await browser.close();
  }
});

await test('a pin drawn while the Hebrew mobile list covers the map can be closed once the list is lowered', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 }, hasTouch: true });
    await page.route('https://**/*', route => route.abort());
    const first = '2026-06-14', second = '2026-06-15';
    await page.addInitScript(trip => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [trip] })), {
      id: 'trip', title: 'Weekend', start: first, end: second, home: 'Hotel', homeXY: [32.07, 34.77],
      stops: [{ id: 'port', date: second, name: 'Old port', xy: [32.052, 34.75], sources: ['card'], refs: ['c1'] }],
      googlePins: [{ id: 'corner', name: 'Saved café with a fairly long name', xy: [32.0762, 34.7745], date: second }]
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=he', import.meta.url).href);
    await restSheet(page, 'full');
    await page.locator('#tripDate').selectOption(second);
    await restSheet(page, 'half');
    await page.locator('.google-pin').click();
    const close = page.locator('.leaflet-popup-close-button');
    await close.waitFor();
    await page.waitForFunction(() => !document.querySelector('.leaflet-pan-anim'));
    assert.ok(await close.evaluate(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }), 'the close button receives taps above the map');
    await close.tap();
    await page.locator('.leaflet-popup').waitFor({ state: 'hidden' });
  } finally {
    await browser.close();
  }
});

await test('a photo-backed visit the traveler moves to another day is marked as theirs', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const first = '2026-06-14', second = '2026-06-15';
    await page.addInitScript(trip => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [trip] })), {
      id: 'trip', title: 'Weekend', start: first, end: second,
      stops: [{ id: 'visit', date: first, name: 'Harbour café', xy: [32.08, 34.78], sources: ['card', 'photo'], refs: ['charge', 'asset-1'], count: 1 }]
    });
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await editMappedStop(page, 'Harbour café');
    await page.locator('#editForm [name=date]').fill(second);
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    const [stop] = (await readPortableRecord(page))!.trips[0].stops;
    // A retry of the same photo finds the visit on its corrected day because of this mark.
    assert.deepEqual([stop.date, stop.edited], [second, true]);
  } finally {
    await browser.close();
  }
});

await test('a removed Google Pin stays off the map after reload and reimport until deliberately restored', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const pin = { id: 'bookmark', name: 'Museum', xy: [52.01, 4.01], date };
    const another = { ...pin, id: 'new', name: 'Gallery', xy: [52.01, 4.02] };
    const trip = { id: 'trip', title: 'Weekend', start: date, end: date, stops: [], googlePins: [pin] };
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'weekend.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip })) });
    await page.getByRole('button', { name: 'Load trip' }).click();
    await page.getByRole('button', { name: 'Museum · Google Pin' }).click();
    await page.getByRole('button', { name: 'Remove from trip' }).click();
    await page.locator('#confirmYes').click();
    await page.locator('.google-pin').waitFor({ state: 'detached' });
    await waitForPortableTrip(page, { removedPinId: pin.id });
    await page.reload();
    await page.locator('#title').filter({ hasText: trip.title }).waitFor();
    assert.equal(await page.locator('.google-pin').count(), 0);
    const openPreview = async () => {
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      await page.locator('#file').setInputFiles({ name: 'saved.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti-stops/1', tripId: 'trip', stops: [], googlePins: [pin, another] })) });
      await page.locator('#preview').getByText(/One previously removed pin left out/).waitFor();
    };
    await openPreview();
    await page.getByRole('button', { name: 'Save Google Pins' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('.google-pin').evaluateAll(pins => pins.map(pin => pin.getAttribute('title'))), ['Gallery · Google Pin']);
    await openPreview();
    assert.equal(await page.getByRole('button', { name: 'Save Google Pins' }).count(), 0);
    await page.getByText('Restore a removed pin', { exact: true }).click();
    assert.equal(await page.getByLabel('Removed pin', { exact: true }).inputValue(), pin.id);
    await page.getByRole('button', { name: 'Restore selected pin' }).click();
    await page.locator('#preview').getByText(/2 already saved/).waitFor();
    await page.locator('#sources [data-close]').click();
    assert.equal(await page.locator('.google-pin').count(), 2);
  } finally {
    await browser.close();
  }
});

await test('a traveler can mark a map pin approximate and later confirm its location', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const trip = { id: 'trip', title: 'Weekend', start: date, end: date,
      stops: [{ id: 'stop', date, name: 'Market hall', xy: [52.1, 4.3] }] };
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'weekend.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip })) });
    await page.getByRole('button', { name: 'Load trip' }).click();
    const open = () => editMappedStop(page, 'Market hall');
    const save = async () => {
      await page.locator('#editForm .primary').click();
      await page.locator('#edit').waitFor({ state: 'hidden' });
    };
    await open();
    await page.getByRole('checkbox', { name: 'Approximate location' }).check();
    await page.locator('#editForm [name=coords]').fill('52.101, 4.301');
    await save();
    assert.match(await page.locator('#stops').innerText(), /Approximate location/);
    await page.reload();
    await page.locator('#stops').getByText(/Approximate location/).waitFor();
    await page.locator('#languageSwitch').selectOption('he');
    await open();
    const approximate = page.getByRole('checkbox', { name: 'מיקום משוער' });
    assert.equal(await approximate.isChecked(), true);
    await approximate.uncheck();
    await save();
    await open();
    assert.equal(await approximate.isChecked(), false);
    await approximate.check();
    await page.locator('#editForm [name=coords]').fill('');
    await save();
    assert.equal(await page.locator('#stops .stopname').count(), 0);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'הוספת כתובת · Market hall', exact: true }).click();
    assert.equal(await approximate.isChecked(), false);
  } finally {
    await browser.close();
  }
});

await test('one daily details panel keeps unlocated visits, unconfirmed attendance, and remote activities distinct', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await page.route('https://**/*', route => route.abort());
    const date = '2026-01-20';
    const reason = 'The ticket and calendar list different venues. The entrance address and attendance have not been confirmed.';
    const trip = {
      id: 'review-ui', title: 'Weekend', start: date, end: '2026-01-21', stops: [
        { id: 'park', name: 'Park', date, xy: [32, 34] },
        { id: 'workshop', name: 'Workshop', date, kind: 'uncertain', sources: ['ticket'], reviewReason: reason, notes: 'Private reference 732.' },
        { id: 'diary', name: 'Tasting', date, kind: 'visit', sources: ['diary'] },
        { id: 'shop', name: 'Grocer', date, kind: 'visit', sources: ['card'], count: 1 },
        { id: 'ride', name: 'Lyft · מסלול בישראל לא אומת', date, kind: 'remote', sources: ['email'] },
        { id: 'stay', name: 'הזמנת לינה ב-Airbnb', date, kind: 'remote', sources: ['email'] }
      ]
    };
    await page.addInitScript(seed => {
      const key = 'masluli-portable-v2';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ trips: [seed] }));
    }, trip);
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=he', import.meta.url).href);
    await page.locator('#reviewDay').click();
    assert.equal(await page.locator('#otherSummary').innerText(), 'מידע נוסף לאותו יום (5)');
    assert.equal(await page.locator('#otherSummary').evaluate(el => document.activeElement === el), true);
    assert.deepEqual(await page.locator('#stops .stopname').allTextContents(), ['Park']);
    assert.deepEqual(await page.locator('#unlocatedList .detail-reason').allTextContents(), ['כתובת הביקור חסרה', 'חסר מיקום לסיכה']);
    assert.equal(await page.locator('#reviewList .detail-reason').innerText(), reason);
    assert.doesNotMatch(await page.locator('#other').innerText(), /732/);
    assert.deepEqual(await page.locator('#otherList .detail-name').allTextContents(), ['Lyft', 'הזמנת לינה ב-Airbnb']);
    assert.deepEqual(await page.locator('#otherList .detail-reason').allTextContents(), ['מסלול בישראל לא אומת', 'לא תועד ביקור במקום']);
    for (const selector of ['#unlocatedEntries', '#reviewEntries', '#remoteEntries']) {
      assert.ok(await page.locator('#other > ' + selector).isVisible());
    }
    const layout = await page.locator('#other').evaluate(el => ({
      top: el.getBoundingClientRect().top, stopsEnd: document.getElementById('stops')!.getBoundingClientRect().bottom,
      actionHeight: el.querySelector('.detail-action')!.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth ||
        [...el.querySelectorAll('.detail-row,.detail-reason')].some(node => node.scrollWidth > node.clientWidth + 1)
    }));
    assert.ok(layout.top >= layout.stopsEnd && layout.actionHeight >= 44 && !layout.overflow);
    await page.locator('#reviewList .detail-action').click();
    const edit = page.locator('#editForm');
    const field = edit.locator('[name="reviewReason"]');
    assert.equal(await field.inputValue(), reason);
    await field.fill('Door number missing');
    await edit.locator('button.primary').click();
    await page.getByText('Door number missing', { exact: true }).waitFor();
    await page.locator('#languageSwitch').selectOption('en');
    assert.equal(await page.locator('#reviewHeading').innerText(), 'Visits to confirm (1)');
    await page.locator('#reviewList .detail-action').click();
    await edit.locator('[name="kind"]').selectOption('visit');
    await edit.locator('button.primary').click();
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByText('Workshop', { exact: true }).waitFor();
    assert.equal(await page.locator('#reviewEntries').isVisible(), false);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Grocer' }).click();
    assert.ok(await edit.locator('[name="address"]').evaluate(field => field === document.activeElement));
    await edit.locator('[name="coords"]').fill('32.01, 34.02');
    await edit.locator('button.primary').click();
    await page.locator('#stops .stopname').filter({ hasText: 'Grocer' }).waitFor();
    assert.deepEqual(await page.locator('#stops .num').allTextContents(), ['1', '2']);
    assert.equal(await page.locator('#statStops').isVisible(), true);
    assert.equal(await page.locator('#statStops').textContent(), '2 stops');
    await toggleWholeTrip(page);
    assert.equal(await page.locator('#other').isVisible(), false);
    assert.equal(await page.locator('#reviewDay').isVisible(), false);
  } finally {
    await browser.close();
  }
});

await test('days without mapped visits show their details and keep an unpinned starting point accessible', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const first = '2026-06-14', second = '2026-06-15';
    const trip = {
      id: 'unlocated-days', title: 'Unlocated days', start: first, end: second,
      stops: [
        { id: 'origin', date: first, kind: 'origin', name: 'Hotel' },
        { id: 'market', date: first, kind: 'visit', name: 'Market' },
        { id: 'gallery', date: second, kind: 'visit', name: 'Gallery' }
      ]
    };
    await page.addInitScript(seed => {
      const key = 'masluli-portable-v2';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ trips: [seed] }));
    }, trip);
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const isOpen = () => page.locator('#other').evaluate(element => (element as HTMLDetailsElement).open);
    await page.locator('#otherSummary').waitFor();
    assert.equal(await isOpen(), true);
    assert.equal(await page.locator('#unlocatedList').isVisible(), true);
    assert.match(await page.locator('#tripDate option').nth(0).textContent() ?? '', /2 entries/);
    assert.match(await page.locator('#tripDate option').nth(1).textContent() ?? '', /1 entry/);
    assert.equal(await page.locator('#count').innerText(), '0 stops');
    assert.equal(await page.locator('#stops .stopname').count(), 0);

    await showDayDetails(page);
    assert.deepEqual(await page.locator('#unlocatedList .detail-name').allTextContents(), ['Hotel', 'Market']);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Hotel', exact: true }).click();
    assert.equal(await page.locator('#editForm [name=kind]').inputValue(), 'origin');
    await page.locator('#editForm [name=name]').fill('Riverside hotel');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    assert.equal(await isOpen(), true);
    await page.locator('#unlocatedList').getByText('Riverside hotel', { exact: true }).waitFor();

    await page.locator('#otherSummary').click();
    await page.locator('#languageSwitch').selectOption('he');
    assert.equal(await isOpen(), false);
    assert.match(await page.locator('#tripDate option').nth(0).textContent() ?? '', /2 רשומות/);
    assert.match(await page.locator('#tripDate option').nth(1).textContent() ?? '', /1 רשומה(?:$|\s)/);
    await page.locator('#languageSwitch').selectOption('en');
    await showDayDetails(page);
    await page.locator('#tripDate').selectOption(second);
    assert.equal(await isOpen(), true);
    await page.locator('#tripDate').selectOption(first);
    assert.equal(await isOpen(), true);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByRole('button', { name: 'Add address · Riverside hotel', exact: true }).click();
    await page.locator('#removeStop').click();
    await page.locator('#confirmYes').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('#unlocatedList .detail-name').allTextContents(), ['Market']);
    assert.match(await page.locator('#tripDate option').nth(0).textContent() ?? '', /1 entry/);
    await page.reload();
    await page.locator('#otherSummary').waitFor();
    assert.equal(await isOpen(), true);
  } finally {
    await browser.close();
  }
});

await test('mapped visits keep details collapsed until the last visit is removed, and later user choices persist', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const trip = { id: 'mixed-day', title: 'Mixed day', start: date, end: date,
      stops: [
        { id: 'origin', name: 'Hotel', kind: 'origin', date, xy: [51.9, 4.4] },
        { id: 'park', name: 'Park', date, xy: [51.91, 4.41] },
        { id: 'shop', name: 'Shop', date }
      ] };
    await page.addInitScript(seed => localStorage.setItem('masluli-portable-v2', JSON.stringify({ trips: [seed] })), trip);
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const isOpen = () => page.locator('#other').evaluate(element => (element as HTMLDetailsElement).open);
    await page.locator('#otherSummary').waitFor();
    assert.equal(await isOpen(), false);
    await editMappedStop(page, 'Park');
    await page.locator('#removeStop').click();
    await page.locator('#confirmYes').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#count').innerText(), '0 stops');
    assert.equal(await isOpen(), true);
    await page.locator('#unlocatedList').getByText('Shop', { exact: true }).waitFor();

    await page.locator('#otherSummary').click();
    await page.locator('#languageSwitch').selectOption('he');
    assert.equal(await isOpen(), false);
    await page.locator('#otherSummary').click();
    await page.locator('#languageSwitch').selectOption('en');
    assert.equal(await isOpen(), true);
  } finally {
    await browser.close();
  }
});

await test('a backup restores a missing middle visit in place with both saved walks after reload', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', route => route.abort());
    const date = '2026-06-14';
    const stops = ['Cafe', 'Museum', 'Park'].map((name, index) => ({
      id: name.toLowerCase(), name, date, rank: index + 1, sources: ['manual'], refs: ['visit:' + name],
      xy: [51.92 + index * 0.0005, 4.48 + index * 0.001]
    }));
    const edges = stops.slice(1).map((stop, index) => ({
      a: stops[index].id, b: stop.id, type: 'walk', m: 100,
      line: [stops[index].xy, stop.xy]
    }));
    const trip = { id: 'middle-stop', title: 'Fictional afternoon', start: date, end: date, stops, edges };
    await page.goto(new URL('../../dist/web/Hayiti.html?lang=en', import.meta.url).href);
    const importBackup = async (record: typeof trip) => {
      await page.locator('#import').click();
      await page.locator('[data-tab="files"]').click();
      await page.locator('#file').setInputFiles({ name: 'afternoon.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: record })) });
    };
    await importBackup({ ...trip, stops: [stops[0], stops[2]], edges: [] });
    await page.getByRole('button', { name: 'Load trip' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('#stops .stopname').allTextContents(), ['Cafe', 'Park']);
    await importBackup(trip);
    await page.locator('#preview').getByText('2 route segments from backup', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load trip' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('#stops .stopname').allTextContents(), ['Cafe', 'Museum', 'Park']);
    await waitForPortableTrip(page, { edgeCount: 2 });
    await page.reload();
    await page.locator('#title').filter({ hasText: trip.title }).waitFor();
    assert.deepEqual(await page.locator('#stops .stopname').allTextContents(), ['Cafe', 'Museum', 'Park']);
    const saved = (await readPortableRecord(page))!.trips[0];
    assert.deepEqual(saved.edges, edges);
    assert.equal(await page.locator('#map svg path.leaflet-interactive').count(), 2);
  } finally {
    await browser.close();
  }
});
