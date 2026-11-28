import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { journalSchemaVersion } from '../../src/domain/journal-schema.ts';
import { seedLegacyGuestOnce } from './guest-storage-helpers.ts';
import { openMenu, restSheet, toggleWholeTrip } from './journal-controls.ts';

// An https origin keeps the page a secure context, as the hosted journal is.
const origin = 'https://hayiti.test';
const types: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon', json: 'application/json'
};

// Serves the built hosted journal with one signed-in trip, or to a guest when there is none.
async function hostTrip(page: Page, trip: object | null) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/api/')) {
      return trip ? route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }) : route.fulfill({ status: 401 });
    }
    try {
      const body = await readFile(new URL('../../dist/web' + pathname, import.meta.url));
      await route.fulfill({ body, contentType: types[pathname.split('.').at(-1) ?? ''] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto(origin + '/journal.html?lang=en');
}

const sheetSettled = (page: Page) => page.waitForFunction(() => {
  const sheet = document.getElementById('panel')!.getBoundingClientRect();
  return Math.abs(sheet.height - parseFloat(document.documentElement.style.getPropertyValue('--sheet'))) < 1;
});

const dayOfStops = (date: string, names: string[]) => names.map((name, index) => ({
  id: 'stop' + index, name, date, time: `${String(9 + index).padStart(2, '0')}:00`, xy: [51.94 - index * .004, 4.48 - index * .002]
}));
const harbor = ['North park', 'Old mill', 'Bridge', 'Market hall', 'Museum', 'South pier', 'Lighthouse', 'Ferry dock'];

await test('choosing a pin shows the name of a stop whose note is taller than the landscape panel', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 }, hasTouch: true });
    const date = '2026-06-14';
    const stops = dayOfStops(date, harbor).map(stop =>
      stop.name === 'Ferry dock' ? { ...stop, notes: 'Walked along the waterfront. '.repeat(40) } : stop);
    await hostTrip(page, { id: 'trip', title: 'Harbor', start: date, end: date, stops });
    await page.locator('.leaflet-marker-icon[title^="Ferry dock"]').click();
    const chosen = page.locator('#stops .activeStop');
    const name = chosen.locator('.stopname');
    assert.equal(await name.innerText(), 'Ferry dock');
    const panel = (await page.locator('#panel').boundingBox())!;
    const foot = (await page.locator('.toolbar').boundingBox())!;
    const row = (await chosen.boundingBox())!;
    const title = (await name.boundingBox())!;
    assert.ok(row.height > foot.y - panel.y, 'the note makes the row taller than the available space');
    assert.ok(title.y >= panel.y && title.y + title.height <= foot.y, 'the selected stop can be read and edited');
  } finally {
    await browser.close();
  }
});

await test('a long day note scrolls with the stops and leaves them within reach on a short screen', async () => {
  const browser = await chromium.launch();
  try {
    // The size of a small phone, where even a raised sheet leaves the list less height than the longest note takes.
    const page = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
    const date = '2026-06-14';
    const note = 'Walked the long way round the harbor. '.repeat(20).slice(0, 700);
    await hostTrip(page, {
      id: 'note', title: 'Harbor day', start: date, end: date,
      stops: [{ id: 'a', name: 'Market', date, xy: [51.92, 4.48] }, { id: 'b', name: 'Museum', date, xy: [51.925, 4.47] }],
      dayNotes: { [date]: note }
    });
    await page.locator('.listbody #dayNote').filter({ hasText: 'Walked the long way' }).waitFor();
    await restSheet(page, 'full');
    const stop = page.locator('#stops .stopname').last();
    await stop.scrollIntoViewIfNeeded();
    const list = await page.locator('.listbody').boundingBox();
    const row = await stop.boundingBox();
    assert.ok(list && row);
    // The note is taller than the list, and the last stop still shows inside it.
    assert.ok((await page.locator('#dayNote').boundingBox())!.height > list.height);
    assert.ok(row.y >= list.y - 1 && row.y + row.height <= list.y + list.height + 1);
  } finally {
    await browser.close();
  }
});

await test('a popup bound before the window turned sideways opens clear of the panel', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, {
      id: 'turn', title: 'Turning trip', start: date, end: date,
      stops: [
        { id: 'west', name: 'West gate of the old harbor market', date, time: '09:00', xy: [51.92, 4.4] },
        { id: 'middle', name: 'Bridge', date, time: '11:00', xy: [51.92, 4.45] },
        { id: 'east', name: 'East pier', date, time: '13:00', xy: [51.92, 4.5] }
      ]
    });
    await page.locator('.leaflet-marker-icon').nth(2).waitFor();
    // Turned sideways, the window is wide enough for the panel to sit beside the route.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.getElementById('panel')!.getBoundingClientRect().width === 400);
    await page.locator('.leaflet-marker-icon[title^="West gate"]').click();
    await page.locator('.leaflet-popup').filter({ hasText: 'West gate' }).waitFor();
    await page.waitForFunction(() => {
      const popup = document.querySelector('.leaflet-popup-content-wrapper')!.getBoundingClientRect();
      return popup.left >= document.getElementById('panel')!.getBoundingClientRect().right;
    });
  } finally {
    await browser.close();
  }
});

await test('long stop popups fit beside the landscape panel in both languages', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 375 }, hasTouch: true });
    const date = '2026-06-14';
    const name = 'The west entrance to the old harbor market and the adjoining covered gardens';
    await hostTrip(page, {
      id: 'market', title: 'Harbor market', start: date, end: date,
      stops: [{ id: 'market', name, date, xy: [51.92, 4.48], address: 'Longstreet'.repeat(18) }]
    });
    for (const language of ['en', 'he']) {
      await page.locator('#languageSwitch').selectOption(language);
      await page.locator('.leaflet-marker-icon[title^="The west entrance"]').click();
      await page.waitForFunction(() => {
        const popup = document.querySelector('.leaflet-popup-content-wrapper')?.getBoundingClientRect();
        if (!popup) return false;
        const panel = document.getElementById('panel')!.getBoundingClientRect();
        return document.documentElement.dir === 'rtl' ? popup.left >= 0 && popup.right <= panel.left
          : popup.left >= panel.right && popup.right <= innerWidth;
      });
      // A real click also checks the panel does not cover the close button.
      await page.locator('.leaflet-popup-close-button').click();
      await page.locator('.leaflet-popup').waitFor({ state: 'hidden' });
    }
  } finally {
    await browser.close();
  }
});

await test('an open Google Pin stays readable after the sheet rises and after rotation', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, {
      id: 'saved', title: 'North to south', start: date, end: date,
      stops: [{ id: 'south', name: 'South pier', date, xy: [51.90, 4.48] }],
      googlePins: [{ id: 'north', name: 'Northern gardens of the old harbor district', date, xy: [51.96, 4.48] }]
    });
    const handle = page.locator('#sheetHandle');
    await handle.press('ArrowDown');
    await sheetSettled(page);
    await page.locator('.google-pin').click();
    const selector = page.locator('.google-pin-popup select');
    await selector.waitFor();
    await handle.press('ArrowUp');
    await sheetSettled(page);
    await page.waitForFunction(() => {
      const popup = document.querySelector('.leaflet-popup-content-wrapper')?.getBoundingClientRect();
      return popup && popup.top >= document.querySelector('header nav')!.getBoundingClientRect().bottom
        && popup.bottom <= document.getElementById('panel')!.getBoundingClientRect().top;
    });
    await selector.focus();
    await page.setViewportSize({ width: 600, height: 375 });
    await page.waitForFunction(() => {
      const popup = document.querySelector('.leaflet-popup-content-wrapper')?.getBoundingClientRect();
      return popup && popup.left >= document.getElementById('panel')!.getBoundingClientRect().right
        && popup.right <= innerWidth && document.activeElement?.matches('.google-pin-popup select');
    });
    await page.locator('.leaflet-popup-close-button').click();
  } finally {
    await browser.close();
  }
});

await test('the arrow keys move the sheet through three heights, the route stays above it and a full sheet takes the map out of reach', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-15';
    await hostTrip(page, {
      id: 'sheet', title: 'North to south', start: '2026-06-14', end: date,
      stops: [
        { id: 'arrival', name: 'Station', date: '2026-06-14', xy: [51.93, 4.48] },
        { id: 'north', name: 'North park', date, time: '09:00', xy: [51.96, 4.48] },
        { id: 'middle', name: 'Bridge', date, time: '11:00', xy: [51.93, 4.48] },
        { id: 'south', name: 'South pier', date, time: '13:00', xy: [51.9, 4.48] }
      ]
    });
    await page.locator('#tripDate').selectOption('2026-06-14');
    await page.locator('.leaflet-marker-icon').waitFor();
    const handle = page.locator('#sheetHandle');
    const map = page.locator('.mapcard');
    // The sheet has stopped moving and every pin shows above it.
    const routeClear = () => page.waitForFunction(() => {
      const sheet = document.getElementById('panel')!.getBoundingClientRect();
      const settled = Math.abs(sheet.height - parseFloat(document.documentElement.style.getPropertyValue('--sheet'))) < 1;
      return settled && [...document.querySelectorAll('.leaflet-marker-icon')].every(pin => pin.getBoundingClientRect().bottom <= sheet.top);
    });
    const rests = async (key: string, stop: string) => {
      await handle.press(key);
      assert.equal(await page.locator('body').getAttribute('data-sheet'), stop);
    };
    await rests('ArrowDown', 'peek');
    await rests('ArrowDown', 'peek');
    // Choosing a day fits its route to the tall strip of map the lowered sheet leaves.
    await page.locator('#tripDate').selectOption(date);
    await page.locator('.leaflet-marker-icon').nth(2).waitFor();
    await routeClear();
    // Raised again, the sheet would cover the southern stops if the route kept that fit.
    await rests('ArrowUp', 'half');
    await routeClear();
    assert.equal(await map.evaluate(element => (element as HTMLElement).inert), false);
    await rests('ArrowUp', 'full');
    assert.equal(await map.evaluate(element => (element as HTMLElement).inert), true);
    await rests('ArrowUp', 'full');
    await rests('ArrowDown', 'half');
    assert.equal(await map.evaluate(element => (element as HTMLElement).inert), false);
    // Beside the route on a wide screen, the panel covers nothing that has to leave the tab order.
    await rests('ArrowUp', 'full');
    await page.setViewportSize({ width: 1200, height: 844 });
    await page.waitForFunction(() => !(document.querySelector('.mapcard') as HTMLElement).inert);
  } finally {
    await browser.close();
  }
});

await test('a day with only a Google Pin or a note says so in the list of dates and gains no stop count', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await hostTrip(page, {
      id: 'dots', title: 'Four days', start: '2026-06-14', end: '2026-06-17',
      stops: [{ id: 'a', name: 'Market', date: '2026-06-14', xy: [51.92, 4.48] }],
      googlePins: [{ id: 'park', name: 'Saved park', date: '2026-06-15', xy: [51.925, 4.47] }],
      dayNotes: { '2026-06-16': 'A slow day by the river.' }
    });
    await page.locator('#tripDate option').nth(3).waitFor({ state: 'attached' });
    const [stop, pin, note, empty] = await page.locator('#tripDate option').allTextContents();
    assert.match(stop, / · 1 stop$/);
    assert.match(pin, / · 1 Google Pin$/);
    assert.doesNotMatch(pin, /stop/);
    assert.match(note, / · Note$/);
    assert.doesNotMatch(note, /stop/);
    assert.doesNotMatch(empty, /·/);
    assert.deepEqual(await page.locator('#dayReel > div').evaluateAll(faces => faces.map(face => (face as HTMLElement).dataset.recorded !== undefined)),
      [true, true, true, false]);
    await page.locator('#tripDate').selectOption('2026-06-15');
    assert.match(await page.locator('#dayReel').getAttribute('aria-valuetext') ?? '', /1 Google Pin, Day 2 of 4$/);
  } finally {
    await browser.close();
  }
});

await test('a phone held sideways shows the panel beside the map, with the route clear of it and every stop within reach', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 }, hasTouch: true });
    const date = '2026-06-14';
    const names = ['North park', 'Old mill', 'Bridge', 'Market hall', 'Museum', 'South pier'];
    await hostTrip(page, {
      id: 'side', title: 'Sideways', start: date, end: date,
      stops: names.map((name, index) => ({ id: 'stop' + index, name, date, time: `${String(9 + index).padStart(2, '0')}:00`, xy: [51.94 - index * .004, 4.48 - index * .002] }))
    });
    await page.locator('.leaflet-marker-icon').nth(5).waitFor();
    for (const lang of ['en', 'he']) {
      await page.locator('#languageSwitch').selectOption(lang);
      // No sheet: the panel is a column on the side where reading starts, narrower than half the window.
      assert.equal(await page.locator('#sheetHandle').isVisible(), false);
      const panel = (await page.locator('#panel').boundingBox())!;
      await page.locator('#panel').evaluate(element => { element.scrollTop = 0; });
      const opening = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const foot = box('.toolbar'), first = box('#stops .stop'), last = box('#stops .stop:last-child');
        return {
          firstStop: first.top >= box('#dayReel').bottom && first.bottom <= foot.top + 1,
          heading: document.querySelector('.listhead')!.checkVisibility(),
          count: document.getElementById('statStops')!.checkVisibility(),
          closing: ['#range', '#status'].every(line => box(line).height > 0 && box(line).top >= last.bottom)
        };
      });
      assert.deepEqual(opening, { firstStop: true, heading: false, count: true, closing: true }, `${lang}: the panel opens on the day`);
      assert.equal(await page.locator('#dayProgress').innerText(), lang === 'he' ? 'יום 1 מתוך 1' : 'Day 1 of 1');
      assert.ok(panel.width <= 667 / 2 && panel.height > 375 / 2, `${lang}: the panel is a column`);
      assert.ok(lang === 'he' ? panel.x + panel.width > 667 - 16 : panel.x < 16, `${lang}: the panel sits where reading starts`);
      // The whole route is drawn on the part of the map beside it, under the bar.
      await page.waitForFunction(() => {
        const column = document.getElementById('panel')!.getBoundingClientRect();
        const bar = document.querySelector('header nav')!.getBoundingClientRect();
        return [...document.querySelectorAll('.leaflet-marker-icon')].every(pin => {
          const box = pin.getBoundingClientRect();
          const beside = document.documentElement.dir === 'rtl' ? box.right <= column.left && box.left >= 0 : box.left >= column.right && box.right <= innerWidth;
          return beside && box.top >= bar.bottom && box.bottom <= innerHeight;
        });
      });
      // With so little height the legend is put away, and the map style shares the bar's row without touching it.
      assert.equal(await page.locator('.legend').isVisible(), false);
      const style = (await page.locator('#mapStyle').boundingBox())!;
      const bar = await page.locator('.brand, header nav > *').evaluateAll(parts => parts.filter(part => part.checkVisibility()).map(part => {
        const { left, right, top, bottom } = part.getBoundingClientRect();
        return { left, right, top, bottom };
      }));
      assert.ok(bar.length >= 4);
      for (const part of bar) {
        assert.ok(style.y < part.bottom && part.top < style.y + style.height, `${lang}: the map style is in the bar's row`);
        assert.ok(style.x >= part.right || style.x + style.width <= part.left, `${lang}: the map style is clear of the bar`);
      }
      // The panel scrolls as a whole: the last stop comes into view above the day's actions, which stay at its foot.
      const last = page.locator('#stops .stopname').last();
      await last.scrollIntoViewIfNeeded();
      const row = (await last.boundingBox())!;
      const actions = (await page.locator('.toolbar').boundingBox())!;
      assert.ok(Math.abs(actions.y + actions.height - (panel.y + panel.height)) <= 2, `${lang}: the actions stay at the foot of the panel`);
      assert.ok(row.y >= panel.y && row.y + row.height <= actions.y + 1, `${lang}: the last stop shows above the actions`);
      // Choosing a pin brings its row into that same clear part of the panel.
      await page.locator('#panel').evaluate(element => { element.scrollTop = 0; });
      await page.locator(`.leaflet-marker-icon[title^="South pier"]`).click();
      await page.waitForFunction(() => {
        const chosen = document.querySelector('.activeStop')?.getBoundingClientRect();
        const column = document.getElementById('panel')!.getBoundingClientRect();
        const foot = document.querySelector('.toolbar')!.getBoundingClientRect();
        return !!chosen && chosen.top >= column.top - 1 && chosen.bottom <= foot.top + 1;
      });
    }
  } finally {
    await browser.close();
  }
});

await test('the buttons of the bar never cover the map style, at any width or in either language', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // A guest's bar is the widest: it adds the sign-in button.
    await hostTrip(page, null);
    await page.locator('#login').waitFor();
    for (const lang of ['en', 'he']) {
      await page.locator('#languageSwitch').selectOption(lang);
      assert.equal(await page.locator('header nav > *').evaluateAll(parts => parts.filter(part => part.checkVisibility()).length), 4);
      for (const height of [800, 390]) {
        for (const width of [560, 667, 821, 844, 900, 932, 1000, 1001, 1100, 1280]) {
          await page.setViewportSize({ width, height });
          if (await page.locator('#sheetHandle').isVisible()) {
            await page.locator('#menu #mapStyle').waitFor({ state: 'attached' });
            assert.equal(await page.locator('.mapcard #mapStyle').count(), 0, `${lang} ${width}x${height}: no map style on the map`);
            continue;
          }
          await page.locator('.mapcard #mapStyle').waitFor();
          const style = (await page.locator('#mapStyle').boundingBox())!;
          const parts = await page.locator('.brand, header nav > *').evaluateAll(elements => elements.filter(element => element.checkVisibility()).map(element => {
            const { left, right, top, bottom } = element.getBoundingClientRect();
            return { id: element.id || element.className, left, right, top, bottom };
          }));
          for (const part of parts) {
            const apart = style.x >= part.right || style.x + style.width <= part.left || style.y >= part.bottom || style.y + style.height <= part.top;
            assert.ok(apart, `${lang} ${width}x${height}: the map style is clear of ${part.id}`);
          }
          assert.ok(style.x >= 0 && style.x + style.width <= width, `${lang} ${width}x${height}: the map style is on screen`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});

await test('tabbing past the days of a lowered sheet raises it, so focus is never out of sight', async () => {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[390, 844], [411, 400]]) {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      const date = '2026-06-14';
      await hostTrip(page, { id: 'tab', title: 'Tabbing', start: date, end: date, stops: dayOfStops(date, harbor) });
      await page.locator('.leaflet-marker-icon').nth(7).waitFor();
      await page.locator('#sheetHandle').focus();
      await page.locator('#panel').evaluate(element => { element.scrollTop = 200; });
      await page.locator('#sheetHandle').press('ArrowDown');
      assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
      // The days still show in the lowered sheet, and reaching them leaves it lowered.
      await page.locator('#tripDate').focus();
      assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
      await page.keyboard.press('Tab');
      await page.locator('body[data-sheet="half"]').waitFor();
      const seen = await page.evaluate(() => {
        const focused = document.activeElement!.getBoundingClientRect(), sheet = document.getElementById('panel')!.getBoundingClientRect();
        return focused.height > 0 && focused.top >= sheet.top && focused.top < sheet.bottom;
      });
      assert.ok(seen, `${width}×${height}: focus is in the sheet as soon as it starts to rise`);
      await page.waitForFunction(() => {
        const focused = document.activeElement!.getBoundingClientRect();
        return document.activeElement !== document.body && focused.height > 0 && focused.top >= 0 && focused.bottom <= innerHeight;
      });
      assert.equal(await page.evaluate(() => document.getElementById('panel')!.contains(document.activeElement)), true, `${width}×${height}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('at the sizes a phone browser leaves, the half-raised sheet shows the day and its first stops', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'phone', title: 'Harbor days', start: date, end: '2026-06-16', home: 'Harbor hotel', stops: dayOfStops(date, harbor.slice(0, 6)) });
    await page.locator('.leaflet-marker-icon').nth(5).waitFor();
    const wholeStops = () => page.evaluate(() => {
      const list = document.querySelector('.listbody')!.getBoundingClientRect();
      const foot = document.querySelector('.toolbar')!.getBoundingClientRect();
      return [...document.querySelectorAll('#stops .stop')].filter(row => {
        const box = row.getBoundingClientRect();
        return box.top >= list.top - 1 && box.bottom <= Math.min(list.bottom, foot.top) + 1;
      }).length;
    });
    // An iPhone SE and an iPhone 14 in Safari, and a Pixel and a smaller Android phone in Chrome, with the browser's own bars taken off.
    for (const [width, height, least] of [[375, 553, 3], [390, 664, 3], [412, 780, 3], [360, 640, 3]]) {
      await page.setViewportSize({ width, height });
      await restSheet(page, 'half');
      await sheetSettled(page);
      assert.ok(await wholeStops() >= least, `${width}x${height}: at least ${least} whole stops show, found ${await wholeStops()}`);
      assert.equal(await page.locator('.listhead').isVisible(), false);
      assert.equal(await page.locator('#statStops').textContent(), '6 stops');
      assert.equal(await page.locator('#statStops').isVisible(), true);
      assert.equal(await page.locator('#dayProgress').innerText(), 'Day 1 of 3');
      assert.equal(await page.locator('#range').isVisible(), false, `${width}x${height}: dates at rest`);
      assert.equal(await page.locator('#status').isVisible(), false, `${width}x${height}: status at rest`);
      await restSheet(page, 'full');
      assert.match(await page.locator('#range').innerText(), /Jun 14, 2026 to Jun 16, 2026 · Starting from Harbor hotel/);
      assert.equal(await page.locator('#status').innerText(), 'Your journal is up to date.');
      for (const line of ['#range', '#status']) {
        assert.equal(await page.locator(line).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${width}x${height}: ${line} is not cut`);
      }
      await restSheet(page, 'half');
    }
    await page.locator('#tripDate').selectOption('2026-06-15');
    await page.locator('#organize').click();
    await page.locator('#status').filter({ hasText: 'Add at least two stops' }).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-sheet'), 'half');
  } finally {
    await browser.close();
  }
});

await test('the resting sheet keeps one height as the days turn and shows the list as the raised sheet does', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 553 }, hasTouch: true });
    const date = '2026-06-14', next = '2026-06-15', empty = '2026-06-16';
    const dayNote = 'We took the long way along the harbor to watch the ferries. '.repeat(3).trim();
    const stopNote = 'The footpath on the river side leads back to the old boat landing. '.repeat(3).trim();
    const address = 'Riverside promenade, beside the visitor center at the north entrance to the park';
    const trip = {
      id: 'guest', title: 'Harbor weekend', start: date, end: empty, home: 'Harbor hotel', homeXY: [51.95, 4.49],
      dayNotes: { [date]: dayNote },
      stops: [
        ...dayOfStops(date, harbor.slice(0, 6)).map((stop, index) => ({
          ...stop, sources: ['card'], count: 1, ...(index === 0 ? { address, notes: stopNote } : {})
        })),
        { id: 'remote', name: 'Train booking', date, kind: 'remote', sources: ['email'] },
        { id: 'ferry', name: 'Ferry dock', date: next, time: '10:30', xy: [51.93, 4.48],
          address: 'Upper harbor promenade, west entrance', sources: ['card'], count: 1 }
      ],
      checks: { gmail: { status: 'disconnected', start: date, end: empty, at: date + 'T12:00:00Z' } }
    };
    await seedLegacyGuestOnce(page, { local: JSON.stringify({ trips: [trip] }) });
    await hostTrip(page, null);
    const visits = page.locator('#stops .stop');
    await visits.first().waitFor();
    const days = [
      { date, names: ['Harbor hotel', ...harbor.slice(0, 6)] },
      { date: next, names: ['Harbor hotel', 'Ferry dock'] },
      { date: empty, names: ['Harbor hotel'] }
    ];
    // The height the sheet rests at, not the one it has on the way there.
    const place = () => page.evaluate(() => {
      const sheet = document.getElementById('panel')!.getBoundingClientRect(), dates = document.getElementById('dayReel')!.getBoundingClientRect();
      return `sheet ${document.documentElement.style.getPropertyValue('--sheet')} tall, dates ${dates.top - sheet.top}px down it`;
    });
    const rowHeights = () => visits.evaluateAll(rows => rows.slice(0, 3).map(row => row.getBoundingClientRect().height));
    for (const lang of ['en', 'he']) {
      await page.locator('#languageSwitch').selectOption(lang);
      for (const [width, height] of [[375, 553], [390, 664]]) {
        await page.setViewportSize({ width, height });
        const places: string[] = [];
        for (const day of days) {
          await page.locator('#tripDate').selectOption(day.date);
          await sheetSettled(page);
          assert.equal(await page.locator('body').getAttribute('data-sheet'), 'half');
          assert.deepEqual(await visits.locator('.stopname').allTextContents(), day.names);
          assert.deepEqual(await visits.locator('.num').allTextContents(), day.names.map((_, index) => index ? String(index) : '⌂'));
          places.push(await place());
        }
        await toggleWholeTrip(page);
        await page.locator('body.trip-overview').waitFor();
        await sheetSettled(page);
        places.push(await place());
        await toggleWholeTrip(page);
        assert.equal(new Set(places).size, 1, `${lang} ${width}×${height}: the sheet and the dates hold still as the day changes, found ${places.join(' | ')}`);
      }
      await page.locator('#tripDate').selectOption(next);
      assert.equal(await page.locator('#reviewDay').isVisible(), false);
      await page.locator('#tripDate').selectOption(date);
      await sheetSettled(page);
      assert.equal(await page.locator('#reviewDay').innerText(), lang === 'en' ? 'More about this day (1)' : 'מידע נוסף לאותו יום (1)');
      assert.equal(await page.locator('#reviewDay').isVisible(), true, `${lang}: the resting sheet offers the rest of the day's records`);
      const underFinger = await page.evaluate(() => {
        const walk = document.querySelector('#dayStats > summary')!.getBoundingClientRect();
        return document.elementFromPoint(walk.left + walk.width / 2, walk.bottom - 1)!.closest('#dayStats, #reviewDay')!.id;
      });
      assert.equal(underFinger, 'dayStats', `${lang}: the foot of the walking summary opens the walk, not the shortcut under it`);
      const note = page.locator('#dayNote'), firstVisit = visits.nth(1);
      const noteLeads = () => note.evaluate(element =>
        element.getBoundingClientRect().bottom <= document.getElementById('stops')!.getBoundingClientRect().top + 1);
      const resting = await rowHeights();
      for (const stop of ['half', 'full'] as const) {
        await restSheet(page, stop);
        await sheetSettled(page);
        assert.ok(await noteLeads(), `${lang} ${stop}: the day note comes before the stops`);
        assert.deepEqual(await rowHeights(), resting, `${lang} ${stop}: the stops are set the same at every height of the sheet`);
        for (const [element, expected] of [
          [note, dayNote], [firstVisit.locator('.meta').first(), '09:00 · ' + address], [firstVisit.locator('.meta').nth(1), stopNote]
        ] as const) {
          await element.scrollIntoViewIfNeeded();
          assert.equal(await element.innerText(), expected);
          const readable = await element.evaluate(el => {
            const text = el.getBoundingClientRect(), list = el.closest('.listbody')!.getBoundingClientRect();
            return text.height > 0 && text.top >= list.top - 1 && text.bottom <= list.bottom + 1 &&
              el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
          });
          assert.ok(readable, `${lang} ${stop}: the complete text of "${expected.slice(0, 28)}…" can be read`);
        }
      }
      await restSheet(page, 'half');
      const notice = lang === 'en' ? '1 source disconnected' : 'מקור אחד מנותק';
      const label = lang === 'en' ? 'Sources and import' : 'מקורות וייבוא';
      const sources = page.locator('.toolbar').getByRole('button', { name: label + ' · ' + notice, exact: true });
      await sources.getByText(notice, { exact: true }).waitFor();
      await sources.click();
      assert.equal(await page.locator('#connected').isVisible(), true);
      await page.locator('#sources [data-close]').click();
      await restSheet(page, 'full');
      assert.equal(await page.locator('#status').innerText(), lang === 'en' ? 'Saved on this device' : 'נשמר במכשיר הזה');
      await restSheet(page, 'half');
    }
  } finally {
    await browser.close();
  }
});

await test('over a sheet the map style is in the menu and the legend shows only while the sheet is lowered', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'band', title: 'Harbor day', start: date, end: date, stops: dayOfStops(date, harbor.slice(0, 4)) });
    await page.locator('.leaflet-marker-icon').nth(3).waitFor();
    await sheetSettled(page);
    assert.equal(await page.locator('.mapcard #mapStyle').count(), 0);
    assert.equal(await page.locator('.legend').isVisible(), false);
    await page.waitForFunction(() => {
      const bar = document.querySelector('header nav')!.getBoundingClientRect();
      const sheet = document.getElementById('panel')!.getBoundingClientRect();
      const credit = document.querySelector('.leaflet-control-attribution')!.getBoundingClientRect();
      return [...document.querySelectorAll('.leaflet-marker-icon')].every(pin => {
        const box = pin.getBoundingClientRect();
        return box.top >= bar.bottom && box.bottom <= Math.min(sheet.top, credit.height ? credit.top : sheet.top);
      });
    });
    await openMenu(page);
    const style = page.locator('#menu #mapStyle');
    assert.equal(await page.locator('#menu .map-style-label').innerText(), 'Map style');
    await style.selectOption('terrain');
    await page.locator('#menu').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#mapStyle').inputValue(), 'terrain');
    await page.locator('#sheetHandle').press('ArrowDown');
    await sheetSettled(page);
    const legend = (await page.locator('.legend').boundingBox())!;
    const sheet = (await page.locator('#panel').boundingBox())!;
    assert.ok(legend.y + legend.height <= sheet.y, 'the legend sits above the lowered sheet');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('.mapcard #mapStyle').waitFor();
    assert.equal(await page.locator('#menu #mapStyle').count(), 0);
    assert.equal(await page.locator('#mapStyle').inputValue(), 'terrain');
  } finally {
    await browser.close();
  }
});

await test('a short, narrow window scrolls the sheet as a whole, so every stop is within reach under its handle', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 411, height: 400 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'short', title: 'Short window', start: date, end: date, stops: dayOfStops(date, harbor.slice(0, 6)) });
    await page.locator('.leaflet-marker-icon').nth(5).waitFor();
    for (const stop of ['half', 'full'] as const) {
      await restSheet(page, stop);
      await sheetSettled(page);
      const last = page.locator('#stops .stop').last();
      await last.scrollIntoViewIfNeeded();
      const row = (await last.boundingBox())!;
      const handle = (await page.locator('#sheetHandle').boundingBox())!;
      const actions = (await page.locator('.toolbar').boundingBox())!;
      const sheet = (await page.locator('#panel').boundingBox())!;
      assert.ok(Math.abs(handle.y - sheet.y) <= 2, `${stop}: the handle stays at the head of the sheet`);
      assert.ok(Math.abs(actions.y + actions.height - 400) <= 2, `${stop}: the actions stay at the foot`);
      assert.ok(row.y >= handle.y + handle.height - 1 && row.y + row.height <= actions.y + 1, `${stop}: the last stop shows between them`);
    }
  } finally {
    await browser.close();
  }
});

const headingInView = () => {
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const panel = box('#panel'), handle = box('#sheetHandle');
  return ['#title', '#dayReel', '.date-menu'].every(part => box(part).top >= handle.bottom - 1 && box(part).bottom <= panel.bottom + 1);
};
const headingShown = (page: Page) => page.evaluate(headingInView);
const lowerSheet = async (page: Page) => {
  await page.locator('#sheetHandle').press('ArrowDown');
  await page.locator('body[data-sheet="peek"]').waitFor();
  await sheetSettled(page);
};
const raiseSheet = async (page: Page) => {
  await page.locator('#sheetHandle').press('ArrowUp');
  await page.locator('body[data-sheet="half"]').waitFor();
  await sheetSettled(page);
};

await test('lowered in a short, narrow window the sheet shows the trip and its days within reach, and raising it returns to the same stops', async () => {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[411, 400], [320, 480]]) {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      const date = '2026-06-14';
      await hostTrip(page, { id: 'short', title: 'Short window', start: date, end: date, stops: dayOfStops(date, harbor) });
      await page.locator('.leaflet-marker-icon').nth(7).waitFor();
      const panel = page.locator('#panel');
      for (const lang of ['en', 'he']) {
        await page.locator('#languageSwitch').selectOption(lang);
        await sheetSettled(page);
        // Focus can scroll the panel, so the handle takes it before the list is scrolled.
        await page.locator('#sheetHandle').focus();
        await panel.evaluate(element => { element.scrollTop = 200; });
        const scrolled = await panel.evaluate(element => element.scrollTop);
        assert.ok(scrolled > 100, `${width}×${height} ${lang}: the stops are scrolled`);
        await lowerSheet(page);
        assert.ok(await headingShown(page), `${width}×${height} ${lang}: the trip name and the date show in the lowered sheet`);
        await page.locator('#dayReel').click({ trial: true, timeout: 2000 });
        await page.locator('#tripDate').click({ trial: true, timeout: 2000 });
        const grip = (await page.locator('#sheetHandle').boundingBox())!;
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 100, { steps: 6 });
        assert.equal(await panel.evaluate(element => element.scrollTop), scrolled, `${width}×${height} ${lang}: a drag upward shows the stops where they were`);
        await page.mouse.up();
        await page.locator('body[data-sheet="half"]').waitFor();
        await sheetSettled(page);
        assert.equal(await panel.evaluate(element => element.scrollTop), scrolled, `${width}×${height} ${lang}: the stops are where they were`);
        await lowerSheet(page);
        await raiseSheet(page);
        assert.equal(await panel.evaluate(element => element.scrollTop), scrolled, `${width}×${height} ${lang}: the keys return to the same stops`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('a stop chosen on the map while a short sheet is lowered is in view once the sheet is raised', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 411, height: 400 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'short', title: 'Short window', start: date, end: date, stops: dayOfStops(date, harbor) });
    await page.locator('.leaflet-marker-icon').nth(7).waitFor();
    await lowerSheet(page);
    await page.locator('.leaflet-marker-icon[title^="Ferry dock"]').click();
    const chosen = page.locator('#stops .activeStop .stopname');
    assert.equal(await chosen.textContent(), 'Ferry dock');
    assert.ok(await headingShown(page), 'the lowered sheet still shows the trip name and the date');
    await raiseSheet(page);
    const name = (await chosen.boundingBox())!;
    const handle = (await page.locator('#sheetHandle').boundingBox())!;
    const actions = (await page.locator('.toolbar').boundingBox())!;
    assert.ok(name.y >= handle.y + handle.height - 1 && name.y + name.height <= actions.y + 1, 'the chosen stop shows between the handle and the actions');
  } finally {
    await browser.close();
  }
});

const chosenShows = (page: Page) => page.waitForFunction(() => {
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const name = box('#stops .activeStop .stopname'), panel = box('#panel'), list = box('.listbody'), actions = box('.toolbar');
  return name.top >= Math.max(panel.top, list.top) - 1 && name.bottom <= Math.min(panel.bottom, list.bottom, actions.top) + 1;
}, null, { timeout: 3000 }).then(() => true, () => false);

await test('a stop chosen on the map stays in view when the phone is turned, with the sheet lowered or at rest', async () => {
  const browser = await chromium.launch();
  try {
    for (const [upright, turned] of [[[411, 400], [667, 375]], [[411, 400], [1280, 720]], [[390, 844], [844, 390]]]) {
      for (const lowered of [true, false]) {
        const page = await browser.newPage({ viewport: { width: upright[0], height: upright[1] }, hasTouch: true });
        const date = '2026-06-14';
        await hostTrip(page, { id: 'turn', title: 'Turning', start: date, end: date, stops: dayOfStops(date, harbor) });
        await page.locator('.leaflet-marker-icon').nth(7).waitFor();
        if (lowered) await lowerSheet(page);
        const turn = `${upright.join('×')} ${lowered ? 'lowered' : 'at rest'}, turned to ${turned.join('×')}`;
        await page.locator('.leaflet-marker-icon[title^="Ferry dock"]').click();
        assert.equal(await page.locator('#stops .activeStop .stopname').textContent(), 'Ferry dock');
        await page.setViewportSize({ width: turned[0], height: turned[1] });
        assert.ok(await chosenShows(page), `${turn}: the chosen stop is in view`);
        await page.setViewportSize({ width: upright[0], height: upright[1] });
        if (lowered) {
          assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
          // The page answers the turn in its next frame, after this call returns.
          await page.waitForFunction(headingInView, null, { timeout: 3000 }).catch(() =>
            assert.fail(`${turn} and back: the lowered sheet shows the trip name and the date`));
          await raiseSheet(page);
        }
        assert.ok(await chosenShows(page), `${turn} and back: the chosen stop is in view`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

await test('a list control that has focus stays in view when the phone is turned, ahead of the chosen stop', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'turn', title: 'Turning', start: date, end: date, stops: dayOfStops(date, harbor) });
    await page.locator('.leaflet-marker-icon').nth(7).waitFor();
    await page.locator('.leaflet-marker-icon[title^="Ferry dock"]').click();
    await page.locator('#stops .stopname').filter({ hasText: 'North park' }).focus();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => {
      const focused = document.activeElement!.getBoundingClientRect(), actions = document.querySelector('.toolbar')!.getBoundingClientRect();
      return document.activeElement!.textContent === 'North park' && focused.top >= 0 && focused.bottom <= actions.top + 1;
    }, null, { timeout: 3000 }).catch(() => assert.fail('the focused stop is out of sight after the turn'));
  } finally {
    await browser.close();
  }
});

await test('a drag that leaves a short sheet lowered keeps the stop it will show when raised', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 411, height: 400 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'short', title: 'Short window', start: date, end: date, stops: dayOfStops(date, harbor) });
    await page.locator('.leaflet-marker-icon').nth(7).waitFor();
    await lowerSheet(page);
    await page.locator('.leaflet-marker-icon[title^="Ferry dock"]').click();
    const handle = page.locator('#sheetHandle'), grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 12, { steps: 4 });
    await page.mouse.up();
    await sheetSettled(page);
    assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
    assert.ok(await headingShown(page), 'the sheet settles back with the trip name and the date');
    await handle.click();
    await page.locator('body[data-sheet="half"]').waitFor();
    await sheetSettled(page);
    assert.ok(await chosenShows(page), 'raising the sheet shows the stop chosen before the drag');
  } finally {
    await browser.close();
  }
});

await test('another day or the whole trip chosen in a lowered short sheet opens the raised list from its start', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 411, height: 400 }, hasTouch: true });
    const days = ['2026-06-14', '2026-06-15'];
    await hostTrip(page, {
      id: 'two', title: 'Two days', start: days[0], end: days[1],
      stops: [...dayOfStops(days[0], harbor), ...dayOfStops(days[1], harbor.slice(0, 4)).map(stop => ({ ...stop, id: 'next' + stop.id }))]
    });
    await page.locator('.leaflet-marker-icon').nth(7).waitFor();
    const panel = page.locator('#panel');
    await page.locator('#sheetHandle').focus();
    await panel.evaluate(element => { element.scrollTop = 200; });
    await lowerSheet(page);
    await page.locator('#tripDate').selectOption(days[1]);
    assert.ok(await headingShown(page), 'the lowered sheet shows the day that was chosen');
    await raiseSheet(page);
    assert.equal(await panel.evaluate(element => element.scrollTop), 0);

    await panel.evaluate(element => { element.scrollTop = 80; });
    await lowerSheet(page);
    await toggleWholeTrip(page);
    await page.locator('body.trip-overview').waitFor();
    assert.ok(await headingShown(page), 'the lowered sheet names the whole trip under the trip name');
    await raiseSheet(page);
    const offset = await page.evaluate(() =>
      document.querySelector('.daybar')!.getBoundingClientRect().top - document.getElementById('sheetHandle')!.getBoundingClientRect().bottom);
    assert.ok(Math.abs(offset) <= 1, `the list of days starts under the handle, found ${offset}`);
  } finally {
    await browser.close();
  }
});

await test('the keyboard never lands under the day\'s actions in a short panel, or under Save in the stop form', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 }, hasTouch: true });
    const date = '2026-06-14';
    await hostTrip(page, { id: 'keys', title: 'Keyboard day', start: date, end: date, stops: dayOfStops(date, harbor) });
    await page.locator('.leaflet-marker-icon').nth(7).waitFor();
    await page.locator('#tripDate').focus();
    const reached: string[] = [];
    for (let step = 0; step < 60; step++) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement, panel = document.getElementById('panel')!;
        if (!panel.contains(element)) return null;
        const foot = document.querySelector('.toolbar')!;
        const box = element.getBoundingClientRect(), shown = panel.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') || element.textContent.trim() || element.id,
          inFoot: foot.contains(element),
          clear: box.top >= shown.top - 1 && box.bottom <= foot.getBoundingClientRect().top + 1
        };
      });
      if (!focus) break;
      reached.push(focus.name);
      if (!focus.inFoot) assert.ok(focus.clear, `${focus.name} is in view above the day's actions`);
    }
    assert.ok(reached.length >= harbor.length * 3 + 3, `the keyboard reached ${reached.length} controls`);
    assert.ok(reached.includes('Ferry dock') && reached.includes('Sources and import'));

    for (const [width, height] of [[667, 375], [390, 664]]) {
      await page.setViewportSize({ width, height });
      if (await page.locator('#sheetHandle').isVisible()) await restSheet(page, 'full');
      await page.locator('#stops .stopname').first().click();
      const form = page.locator('#edit');
      await form.waitFor();
      await form.locator('[name="name"]').focus();
      const fields: string[] = [];
      for (let step = 0; step < 30; step++) {
        const focus = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement, dialog = document.getElementById('edit')!;
          const foot = dialog.querySelector('.form-actions')!;
          const box = element.getBoundingClientRect(), shown = dialog.getBoundingClientRect();
          return {
            name: element.getAttribute('name') || element.id || element.textContent.trim(),
            inFoot: foot.contains(element),
            clear: box.top >= shown.top - 1 && box.bottom <= foot.getBoundingClientRect().top + 1
          };
        });
        if (focus.inFoot) break;
        fields.push(focus.name);
        assert.ok(focus.clear, `${width}x${height}: ${focus.name} is in view above Save`);
        await page.keyboard.press('Tab');
      }
      assert.deepEqual(fields.filter(name => ['notes', 'photo', 'pick'].includes(name)), ['pick', 'notes', 'photo'], `${width}x${height}: the fields under the fold were reached`);
      await page.keyboard.press('Escape');
      await form.waitFor({ state: 'hidden' });
    }
  } finally {
    await browser.close();
  }
});

await test('a trip name a little too long for the panel is set smaller on one line, and a much longer one wraps at full size', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 }, hasTouch: true });
    const date = '2026-06-14';
    const trip = (title: string) => ({ id: 'trip', title, start: date, end: date, stops: dayOfStops(date, harbor.slice(0, 2)) });
    const title = () => page.locator('#title').evaluate(el => {
      const style = getComputedStyle(el);
      const lines = Math.round((el.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight));
      return { size: parseFloat(style.fontSize), lines, fits: el.scrollWidth <= el.clientWidth };
    });
    await hostTrip(page, trip('Harbor'));
    await page.locator('#stops .stop').first().waitFor();
    const short = await title();
    assert.equal(short.lines, 1);

    const sentence = 'Two unhurried weeks along the old harbor and the northern gardens';
    const slightlyLong = await page.locator('#title').evaluate((el, text) => {
      const shown = el.textContent, room = el.parentElement!.getBoundingClientRect().width;
      el.style.whiteSpace = 'nowrap';
      const lengths = Array.from(text, (_, index) => index + 1).filter(length => {
        el.textContent = text.slice(0, length);
        const over = el.getBoundingClientRect().width / room;
        return text[length - 1] !== ' ' && over > 1.05 && over < 1.2;
      });
      el.style.whiteSpace = '';
      el.textContent = shown;
      return text.slice(0, lengths[0]);
    }, sentence);
    assert.ok(slightlyLong, 'some part of the sentence is 5 to 20 percent wider than the line');
    await hostTrip(page, trip(slightlyLong));
    await page.locator('#stops .stop').first().waitFor();
    const fitted = await title();
    assert.deepEqual({ lines: fitted.lines, fits: fitted.fits }, { lines: 1, fits: true });
    assert.ok(fitted.size < short.size && fitted.size >= short.size * .75, `set smaller, within a quarter: ${fitted.size} of ${short.size}`);
    await page.setViewportSize({ width: 412, height: 780 });
    await page.waitForFunction(size => parseFloat(getComputedStyle(document.getElementById('title')!).fontSize) === size, short.size);
    assert.equal((await title()).lines, 1);

    await page.setViewportSize({ width: 667, height: 375 });
    await hostTrip(page, trip(sentence));
    await page.locator('#stops .stop').first().waitFor();
    const long = await title();
    assert.equal(long.size, short.size);
    assert.ok(long.lines > 1, 'the whole name shows, on more than one line');
  } finally {
    await browser.close();
  }
});

await test('the sample trip opens on its name and first stop, however far the welcome was scrolled', async () => {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[375, 553], [667, 375]]) {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      await hostTrip(page, null);
      const sample = page.locator('#trySample');
      await sample.scrollIntoViewIfNeeded();
      const scrolled = () => page.evaluate(() => document.querySelector('.listbody')!.scrollTop + document.getElementById('panel')!.scrollTop);
      assert.ok(await scrolled() > 0, `${width}×${height}: the welcome is scrolled to reach the button`);
      await sample.click();
      await page.locator('#stops .stop').first().waitFor();
      assert.equal(await scrolled(), 0, `${width}×${height}: the trip starts at the top`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('opening a day from the whole trip in a short panel starts at its date, with its first stops under it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 667, height: 375 }, hasTouch: true });
    // Twelve days, so the list of days is longer than the panel. The last day has a full list of its own.
    const days = Array.from({ length: 12 }, (_, index) => `2026-06-${String(10 + index).padStart(2, '0')}`);
    await hostTrip(page, {
      id: 'long', title: 'Twelve days', start: days[0], end: days[11],
      stops: [...days.slice(0, 11).map((date, index) => ({ id: 'day' + index, name: 'Stop of day ' + (index + 1), date, xy: [51.9 + index * .01, 4.48] })),
        ...dayOfStops(days[11], harbor)]
    });
    await page.locator('.leaflet-marker-icon').waitFor();
    await toggleWholeTrip(page);
    const last = page.locator('.overview-day').last();
    await last.scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#panel').evaluate(panel => panel.scrollTop) > 100, 'the list of days is scrolled');
    await last.click();
    assert.equal(await page.locator('#tripDate').inputValue(), days[11]);
    const view = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const panel = box('#panel'), reel = box('#dayReel'), first = box('#stops .stop'), foot = box('.toolbar');
      return { dateAtTop: reel.top >= panel.top - 1 && reel.top <= panel.top + 12, firstStop: first.top >= reel.bottom && first.bottom <= foot.top + 1 };
    });
    assert.deepEqual(view, { dateAtTop: true, firstStop: true });
    await toggleWholeTrip(page);
    assert.equal(await page.locator('.overview-day').first().evaluate(day => {
      const box = day.getBoundingClientRect(), foot = document.querySelector('.toolbar')!.getBoundingClientRect();
      return box.top >= document.getElementById('dayReel')!.getBoundingClientRect().bottom && box.bottom <= foot.top + 1;
    }), true);
  } finally {
    await browser.close();
  }
});
