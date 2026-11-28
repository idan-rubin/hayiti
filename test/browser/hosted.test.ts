import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { chromium, type Page, type Route } from 'playwright-core';
import { journalAPI } from '../../src/server/journal-api.ts';
import { cleanTrip } from '../../src/domain/core.ts';
import { journalSchemaVersion } from '../../src/domain/journal-schema.ts';
import { loadState, storeState } from '../../src/server/storage.ts';
import { MemoryBucket } from '../memory-bucket.ts';
import { guestTitles, patchGuestRecord, readGuestRecord, refuseGuestWrites } from './guest-storage-helpers.ts';
import { backUpTrip, openMenu, toggleWholeTrip } from './journal-controls.ts';

// An https origin keeps the page a secure context, as the hosted journal is.
const origin = 'https://hayiti.test';
const types: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon', json: 'application/json'
};

async function showDayDetails(page: Page) {
  await page.locator('#otherSummary').waitFor();
  if (!await page.locator('#other').evaluate(element => (element as HTMLDetailsElement).open)) {
    await page.locator('#otherSummary').click();
  }
}

// Serves the built hosted journal from a fictional origin and lets each test answer the API calls.
async function hostJournal(page: Page, api: (route: Route) => Promise<void> | void) {
  await page.route('https://**/*', route => route.abort());
  await page.route(origin + '/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/api/')) return api(route);
    try {
      const body = await readFile(new URL('../../dist/web' + pathname, import.meta.url));
      await route.fulfill({ body, contentType: types[pathname.split('.').at(-1) ?? ''] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
}

await test('a lowered sheet fits a late journal error and its translation', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 553 }, reducedMotion: 'reduce' });
    let failLoad = () => {};
    const pending = new Promise<void>(resolve => { failLoad = resolve; });
    await hostJournal(page, async route => {
      await pending;
      await route.fulfill({ status: 503 });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#sheetHandle').press('ArrowDown');
    await page.locator('body[data-sheet="peek"]').waitFor();
    failLoad();
    await page.locator('#status').filter({ hasText: 'Choose Try again.' }).waitFor();
    const checkStatus = async () => {
      await page.waitForFunction(() => {
        const status = document.getElementById('status')!.getBoundingClientRect();
        const panel = document.getElementById('panel')!.getBoundingClientRect();
        return status.height > 0 && status.top >= panel.top && status.bottom <= panel.bottom;
      }, null, { timeout: 3000 });
      assert.equal(await page.locator('body').getAttribute('data-sheet'), 'peek');
    };
    await checkStatus();
    for (const lang of ['he', 'en']) {
      await page.locator('#languageSwitch').selectOption(lang);
      await checkStatus();
    }
  } finally {
    await browser.close();
  }
});

await test('a trip started before signing in is added to the journal after sign-in', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const bucket = new MemoryBucket();
    let writes = 0;
    await hostJournal(page, async route => {
      const request = route.request();
      if (request.method() === 'POST') writes++;
      const response = await journalAPI(new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postData()
      }), bucket, 'web', signedIn ? 'traveler' : null);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Before sign-in');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });

    await page.reload();
    await page.locator('#title').filter({ hasText: 'Before sign-in' }).waitFor();

    await chooseSignIn(page);

    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Before sign-in');
    assert.equal(writes, 1);

    await page.reload();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Before sign-in');
    assert.equal(writes, 1);
  } finally {
    await browser.close();
  }
});

await test('a shared route stays on screen through a temporary failure and clears when revoked', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 } });
    let status = 200;
    const snapshot = {
      id: 'shared', title: 'Shared day', start: '2026-06-14', end: '2026-06-15',
      stops: [{ id: 'a', date: '2026-06-15', name: 'Markthal', xy: [51.92, 4.4867] }]
    };
    await hostJournal(page, route => status === 200 && route.request().method() === 'GET'
      ? route.fulfill({ json: snapshot })
      : route.fulfill({ status }));
    await page.goto(origin + '/journal.html?lang=en#route=fictional');
    await page.locator('body.route-ready').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-sheet'), 'half');
    await page.getByRole('status').filter({ hasText: 'Shared route · View only' }).waitFor();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('nav #mapStyle').waitFor();
    assert.equal(await page.locator('#share').isVisible(), false);
    const wholeTrip = page.locator('#wholeTrip');
    await openMenu(page);
    assert.deepEqual(await page.locator('#menu button:visible').allInnerTexts(), ['Whole trip']);
    assert.equal(await page.locator('#menu .beta-links').isVisible(), false);
    await wholeTrip.click();
    assert.equal(await wholeTrip.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#listTitle').innerText(), 'Trip days');
    await openMenu(page);
    assert.equal(await wholeTrip.innerText(), 'Back to the day');
    await wholeTrip.click();
    assert.equal(await wholeTrip.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#import').isVisible(), false);
    const recheck = async () => {
      const answered = page.waitForResponse(response => response.url().endsWith('/api/route-links'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await answered;
    };

    status = 503;
    await recheck();
    assert.equal(await page.locator('#title').textContent(), 'Shared day');
    assert.equal(await page.locator('body.route-ready').count(), 1);

    status = 404;
    await recheck();
    await page.locator('body:not(.route-ready)').waitFor();
    await page.getByRole('heading', { name: 'This shared route isn’t available' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Start your own trip journal' }).isVisible(), true);
  } finally {
    await browser.close();
  }
});

const draftKey = 'hayiti-unsigned-journal';
async function openConnectedAccounts(page: Page) {
  await page.locator('#import').click();
  await page.locator('[data-tab="connected"]').click();
}
async function refreshJournal(page: Page) {
  await openConnectedAccounts(page);
  await page.locator('#reload').click();
  await page.locator('#sources [data-close]').click();
}
// Chooses Sign in the way a traveler does. The test answers the sign-in itself, so the navigation is held back.
async function chooseSignIn(page: Page) {
  await page.locator('#login').evaluate((link: HTMLAnchorElement) => {
    link.addEventListener('click', event => event.preventDefault(), { once: true });
    link.click();
  });
}

async function createTrip(page: Page, title: string, date?: string) {
  await page.locator('#newTrip').click();
  await page.locator('#tripForm [name=title]').fill(title);
  if (date) for (const name of ['start', 'end']) await page.locator('#tripForm [name=' + name + ']').fill(date);
  await page.locator('#tripForm .primary').click();
  await page.locator('#config').waitFor({ state: 'hidden' });
}

await test('an account journal leaves the tab when its session ends and never becomes a guest draft', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = true;
    const account = { id: 'account', title: 'Account trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    await hostJournal(page, route => signedIn
      ? route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [account], rev: 'r1' } })
      : route.fulfill({ status: 401, json: { error: 'Authentication required' } }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Account trip' }).waitFor();

    signedIn = false;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'You are signed out' }).waitFor();
    assert.notEqual(await page.locator('#title').textContent(), 'Account trip');

    await createTrip(page, 'Guest trip');
    const draft = await readGuestRecord(page);
    assert.ok(draft);
    assert.deepEqual(draft.trips.map((trip: { title: string }) => trip.title), ['Guest trip']);
  } finally {
    await browser.close();
  }
});

await test('guest edits to an untitled account trip get a distinct name in the picker', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const first = { id: 'a', date: '2026-06-14', name: 'Markthal' };
    const trip = { id: 'rotterdam', title: '', start: '2026-06-14', end: '2026-06-14', stops: [first] };
    const saved: { trips: { title: string; stops: unknown[] }[] }[] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } });
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { rev: 'r2' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'rotterdam.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: {
        ...trip, stops: [first, { id: 'b', date: '2026-06-14', name: 'Cube Houses' }]
      } }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });

    await chooseSignIn(page);

    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'kept as a separate copy' }).waitFor();
    assert.deepEqual(saved.map(body => body.trips.map(item => [item.title, item.stops.length])),
      [[['', 1], ['My trip (before sign-in)', 2]]]);
    assert.deepEqual(await page.locator('#trips option').allTextContents(), ['My trip', 'My trip (before sign-in)']);
    assert.deepEqual(await guestTitles(page), []);
  } finally {
    await browser.close();
  }
});

await test('a save that fails after the session ended does not bring the account journal back', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = true,
      release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const account = { id: 'account', title: 'Account trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    const signedOut = { status: 401, json: { error: 'Authentication required' } };
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        await held;
        return route.fulfill(signedOut);
      }
      return route.fulfill(signedIn ? { json: { schemaVersion: journalSchemaVersion, trips: [account], rev: 'r1' } } : signedOut);
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Account trip' }).waitFor();

    const saving = page.waitForRequest(request => request.method() === 'POST');
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('In flight');
    await page.locator('#tripForm .primary').click();
    await saving;
    signedIn = false;
    await page.evaluate(() => document.getElementById('reload')!.click());
    await page.locator('#status').filter({ hasText: 'You are signed out' }).waitFor();
    const failed = page.waitForResponse(response => response.request().method() === 'POST');
    release();
    await page.locator('#config .form-error').filter({ hasText: /edit was not saved/i }).waitFor();
    await (await failed).finished();

    assert.notEqual(await page.locator('#title').textContent(), 'Account trip');
    assert.equal(await page.locator('#trips option').count(), 0);
    await page.locator('#config [data-close]').click();
    await createTrip(page, 'Guest trip');
    const draft = await readGuestRecord(page);
    assert.ok(draft);
    assert.deepEqual(draft.trips.map((trip: { title: string }) => trip.title), ['Guest trip']);
  } finally {
    await browser.close();
  }
});

await test('retrying sign-in after a lost reply does not add the guest copy twice', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const first = { id: 'a', date: '2026-06-14', name: 'Markthal' };
    const trip = { id: 'rotterdam', title: 'Rotterdam', start: '2026-06-14', end: '2026-06-14', stops: [first] };
    let account: { title: string }[] = [trip],
      posts = 0;
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: account, rev: 'r' + posts } });
      account = route.request().postDataJSON().trips;
      // The server stores the first save, but its reply never reaches the browser.
      return ++posts === 1 ? route.abort() : route.fulfill({ json: { rev: 'r' + posts } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'rotterdam.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: {
        ...trip, stops: [first, { id: 'b', date: '2026-06-14', name: 'Cube Houses' }]
      } }))
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });

    await chooseSignIn(page);

    signedIn = true;
    const lost = page.waitForEvent('requestfailed', request => request.method() === 'POST');
    await page.reload();
    await lost;
    await page.locator('#status').filter({ hasText: 'Choose Refresh journal to check' }).waitFor();
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(posts, 1);
    assert.deepEqual(account.map(item => item.title), ['Rotterdam', 'Rotterdam (before sign-in)']);
    assert.deepEqual(await guestTitles(page), []);
  } finally {
    await browser.close();
  }
});

await test('a guest edit the tab cannot store fails, and the stored trip is untouched', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401, json: { error: 'Authentication required' } }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Small trip');
    await refuseGuestWrites(page);
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Does not fit');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: /could not save the edit/ }).waitFor();
    assert.equal(await page.locator('#config').getAttribute('open'), '');
    assert.equal(await page.locator('#title').textContent(), 'Small trip');

    await page.reload();
    await page.locator('#title').filter({ hasText: 'Small trip' }).waitFor();
    assert.equal(await page.locator('#trips option').count(), 1);
  } finally {
    await browser.close();
  }
});

await test('refreshing after signing in elsewhere adds the guest trip with its stops', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const saved: { trips: { stops: { name: string }[] }[] }[] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [], rev: '' } });
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { rev: 'r1' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip', '2026-06-14');
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'stops.csv', mimeType: 'text/csv', buffer: Buffer.from('date,merchant\n2026-06-14,Ferry Terminal')
    });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });

    await chooseSignIn(page);

    signedIn = true;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.deepEqual(saved.map(body => body.trips.map(trip => trip.stops.map(stop => stop.name))), [[['Ferry Terminal']]]);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByText('Ferry Terminal', { exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a refused guest merge keeps the selected trip and day', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const trips = [
      { id: 'a', title: 'First trip', start: '2026-05-01', end: '2026-05-01', stops: [] },
      { id: 'b', title: 'Second trip', start: '2026-06-14', end: '2026-06-16', stops: [] }
    ];
    await page.addInitScript(({ key, trips }) => localStorage.setItem(key, JSON.stringify({ trips })), { key: draftKey, trips });
    let signedIn = false;
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [], rev: '' } });
      return route.fulfill({ status: 400, json: { error: 'Invalid journal' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#trips').selectOption('b');
    await page.locator('#dayReel').press('End');
    assert.equal(await page.locator('#tripDate').inputValue(), trips[1].end);
    await chooseSignIn(page);
    signedIn = true;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'Invalid journal' }).waitFor();
    assert.equal(await page.locator('#trips').inputValue(), 'b');
    assert.equal(await page.locator('#tripDate').inputValue(), trips[1].end);
  } finally {
    await browser.close();
  }
});

await test('when the journal cannot take a guest trip, the traveler can back it up or delete it and then open the journal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const account = { id: 'account', title: 'Account trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [account], rev: 'r1' } });
      return route.fulfill({ status: 400, json: { error: 'Invalid journal' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    await chooseSignIn(page);
    signedIn = true;
    await page.reload();
    await page.locator('#status').filter({ hasText: 'could not take the trips from this browser (Invalid journal)' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Guest trip');
    assert.equal(await page.locator('#export').isDisabled(), false);

    await page.locator('#settings').click();
    await page.locator('#deleteTrip').click();
    await page.locator('#confirmYes').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await refreshJournal(page);
    await page.locator('#title').filter({ hasText: 'Account trip' }).waitFor();
    assert.equal(await page.locator('#status').textContent(), 'Your journal is up to date.');
  } finally {
    await browser.close();
  }
});

await test('overlapping refreshes share one load: one save, one status, and the journal stays editable', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false,
      rev = 0,
      reads = 0,
      account: { title: string }[] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (route.request().method() === 'GET') {
        reads++;
        return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: account, rev: 'r' + rev } });
      }
      const body = route.request().postDataJSON();
      if (body.rev !== 'r' + rev) return route.fulfill({ status: 409, json: { error: 'CONFLICT' } });
      account = body.trips;
      return route.fulfill({ json: { rev: 'r' + ++rev } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    await chooseSignIn(page);
    signedIn = true;
    await page.evaluate(() => {
      document.getElementById('reload')!.click();
      document.getElementById('reload')!.click();
    });
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(reads, 1);
    assert.equal(rev, 1);
    assert.equal(await page.locator('#status').textContent(), 'The trip you started before signing in is now in your journal.');
    await createTrip(page, 'Second trip');
    assert.deepEqual(account.map(item => item.title), ['Guest trip', 'Second trip']);
  } finally {
    await browser.close();
  }
});

await test('a refresh started before a save keeps the saved trip and revision', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0, rev = 'r1';
    let trips = [{ title: 'First', id: 'first', start: '2026-06-14', end: '2026-06-14', stops: [] }];
    await hostJournal(page, async route => {
      if (route.request().method() === 'GET') {
        const snapshot = { schemaVersion: journalSchemaVersion, trips, rev };
        if (++reads === 2) await held;
        return route.fulfill({ json: snapshot });
      }
      const body = route.request().postDataJSON();
      assert.equal(body.rev, rev);
      trips = body.trips;
      rev = 'r' + trips.length;
      return route.fulfill({ json: { rev } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'First' }).waitFor();
    await openConnectedAccounts(page);
    const requested = page.waitForRequest(request => request.url().endsWith('/api/journal'));
    const refresh = page.locator('#reload').evaluate((button: HTMLButtonElement) => button.onclick?.(new PointerEvent('click')));
    await requested;
    await page.locator('#sources [data-close]').click();
    await createTrip(page, 'Second');
    release();
    await refresh;
    assert.equal(await page.locator('#title').textContent(), 'Second');
    await createTrip(page, 'Third');
    assert.deepEqual(trips.map(trip => trip.title), ['First', 'Second', 'Third']);
  } finally {
    await browser.close();
  }
});

await test('failed sign-in preparation keeps the draft available for backup and sends no save', async () => {
  const browser = await chromium.launch();
  try {
    for (const failure of ['corrupt', 'full'] as const) {
      const page = await browser.newPage();
      let signedIn = false, writes = 0;
      await hostJournal(page, route => {
        if (route.request().method() === 'POST') writes++;
        return route.fulfill(signedIn ? { json: { schemaVersion: journalSchemaVersion, trips: [], rev: 'r1' } } : { status: 401 });
      });
      await page.goto(origin + '/journal.html?lang=en');
      await createTrip(page, 'Guest trip');
      if (failure === 'corrupt') await patchGuestRecord(page, { attempts: '{broken' });
      else await refuseGuestWrites(page);
      await chooseSignIn(page);
      signedIn = true;
      await refreshJournal(page);
      await page.locator('#status').filter({ hasText: 'No trips were sent this time' }).waitFor();
      assert.match(await page.locator('#status').innerText(), /Back up trip/);
      const downloaded = page.waitForEvent('download');
      await backUpTrip(page);
      const path = await (await downloaded).path();
      assert.ok(path);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).trip.title, 'Guest trip');
      assert.equal(writes, 0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('a non-JSON sign-in failure leaves the guest backup available and refresh retries the save', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false, writes = 0;
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [], rev: '' } });
      if (++writes === 1) return route.fulfill({ status: 503, contentType: 'text/html', body: '<p>Unavailable</p>' });
      assert.equal(route.request().postDataJSON().trips[0].title, 'Guest trip');
      return route.fulfill({ json: { rev: 'r1' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    await chooseSignIn(page);
    signedIn = true;
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Guest trip' }).waitFor();
    assert.match(await page.locator('#status').innerText(), /couldn’t confirm the save/);
    const downloaded = page.waitForEvent('download');
    await backUpTrip(page);
    const backup = await (await downloaded).path();
    assert.ok(backup);
    assert.equal(JSON.parse(await readFile(backup, 'utf8')).trip.title, 'Guest trip');
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 2);
    assert.deepEqual(await guestTitles(page), []);
  } finally {
    await browser.close();
  }
});

await test('a sign-in conflict keeps the guest draft until the traveler chooses Refresh journal', async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    let signedIn = false, writes = 0;
    await hostJournal(page, async route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [], rev: writes ? 'r2' : 'r1' } });
      if (++writes === 1) {
        await held;
        return route.fulfill({ status: 409 });
      }
      const body = route.request().postDataJSON();
      assert.equal(body.rev, 'r2');
      assert.equal(body.trips[0].title, 'Guest trip');
      return route.fulfill({ json: { rev: 'r3' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    await chooseSignIn(page);
    signedIn = true;
    const merging = page.waitForRequest(request => request.method() === 'POST');
    await refreshJournal(page);
    await merging;

    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Another trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: /try this edit again/i }).waitFor();
    assert.equal(await page.locator('#tripForm [name=title]').inputValue(), 'Another trip');
    await page.locator('#config [data-close]').click();

    release();
    await page.locator('#status').filter({ hasText: 'Your journal changed during sign-in' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Guest trip');
    assert.equal(writes, 1);
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 2);
    assert.deepEqual(await guestTitles(page), []);
  } finally {
    release();
    await browser.close();
  }
});

await test('an import acknowledged after refresh closes the dialog and reports its counts', async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    let trips = [{ id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-14', stops: [] }];
    let writes = 0;
    await hostJournal(page, async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips, rev: writes ? 'newer' : 'original' } });
      const body = route.request().postDataJSON();
      trips = body.trips;
      if (++writes === 1) {
        await held;
        return route.fulfill({ json: { rev: 'imported' } });
      }
      assert.equal(body.rev, 'newer');
      return route.fulfill({ json: { rev: 'next' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Tel Aviv' }).waitFor();
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'stops.csv', mimeType: 'text/csv', buffer: Buffer.from('date,merchant\n2026-06-14,Cafe')
    });
    const posted = page.waitForRequest(request => request.method() === 'POST');
    await page.locator('#preview button').click();
    await posted;
    await page.locator('[data-tab="connected"]').click();
    await page.locator('#reload').click();
    await page.locator('#unlocatedList').getByText('Cafe', { exact: true }).waitFor({ state: 'attached' });
    release();
    await page.locator('#sources').waitFor({ state: 'hidden', timeout: 4000 });
    assert.match(await page.locator('#status').innerText(), /Added: 1/);
    await createTrip(page, 'Next trip');
    assert.equal(writes, 2);
  } finally {
    release();
    await browser.close();
  }
});

await test('a conflicting edit reads past a stale refresh before reporting the latest version', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let release = () => {};
    const stale = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const writes: string[] = [];
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        writes.push(route.request().postDataJSON().rev);
        return writes.length === 1 ? route.fulfill({ status: 409 }) : route.fulfill({ json: { rev: 'r3' } });
      }
      const read = ++reads;
      if (read === 2) await stale;
      const title = read < 3 ? 'Old title' : 'New title';
      return route.fulfill({ json: { schemaVersion: journalSchemaVersion, rev: read < 3 ? 'r1' : 'r2', trips: [
        { id: 'trip', title, start: '2026-06-14', end: '2026-06-14', stops: [] }
      ] } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Old title' }).waitFor();
    const requested = page.waitForRequest(request => request.url().endsWith('/api/journal'));
    await refreshJournal(page);
    await requested;
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('My edit');
    const rejected = page.waitForResponse(response => response.status() === 409);
    await page.locator('#tripForm .primary').click();
    await (await rejected).finished();
    release();
    await page.locator('#config .form-error').filter({ hasText: /latest version/i }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'New title');
    assert.deepEqual(writes, ['r1']);
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.deepEqual(writes, ['r1', 'r2']);
  } finally {
    await browser.close();
  }
});

await test('a guest can edit after a lost sign-in reply and refresh the same account trip', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = false;
    const saves: { id: string; title: string }[][] = [];
    await hostJournal(page, route => {
      if (!signedIn) return route.fulfill({ status: 401 });
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: saves.at(-1) ?? [], rev: 'r' + saves.length } });
      saves.push(route.request().postDataJSON().trips);
      return saves.length === 1 ? route.abort() : route.fulfill({ json: { rev: 'r2' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Guest trip');
    await chooseSignIn(page);
    signedIn = true;
    await refreshJournal(page);
    await page.locator('#status').filter({ hasText: 'couldn’t confirm the save' }).waitFor();
    assert.doesNotMatch(await page.locator('#status').innerText(), /delet/i);
    await page.locator('#settings').click();
    await page.locator('#tripForm [name=title]').fill('Edited guest trip');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('#status').filter({ hasText: 'now in your journal' }).waitFor();
    assert.deepEqual(saves.map(trips => trips.map(trip => trip.title)), [['Guest trip'], ['Edited guest trip']]);
    assert.equal(saves[0][0].id, saves[1][0].id);
    assert.deepEqual(await guestTitles(page), []);
  } finally {
    await browser.close();
  }
});

await test('an unreadable guest draft is retained until the traveler confirms discarding it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let posts = 0;
    await hostJournal(page, route => {
      if (route.request().method() === 'POST') posts++;
      return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [], rev: 'r1' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip:not([disabled])').waitFor();
    await patchGuestRecord(page, { trips: [null] });
    await page.reload();
    const discard = page.getByRole('button', { name: 'Discard unreadable draft' });
    const newTrip = page.getByRole('button', { name: 'New trip', exact: true });
    await discard.waitFor();
    assert.equal(await page.locator('#status').innerText(),
      'The guest draft in this browser could not be read. Choose Discard unreadable draft to continue.');
    assert.equal(await newTrip.isDisabled(), true);
    assert.equal(await page.locator('#import').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="files"]').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="paste"]').isDisabled(), true);
    await discard.click();
    await page.locator('#confirmNo').click();
    assert.deepEqual((await readGuestRecord(page))?.trips, [null]);
    assert.equal(await newTrip.isDisabled(), true);
    await discard.click();
    await page.locator('#confirmYes').click();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(await discard.isVisible(), false);
    assert.equal(await newTrip.isEnabled(), true);
    assert.equal(await page.locator('#import').isEnabled(), true);
    assert.deepEqual(await guestTitles(page), []);
    assert.equal(posts, 0);
  } finally {
    await browser.close();
  }
});

await test('a failed first load blocks import until Try again opens the journal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let available = false;
    await hostJournal(page, route => route.fulfill({ status: available ? 401 : 503 }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'Choose Try again' }).waitFor();
    assert.equal(await page.locator('#import').isDisabled(), true);
    assert.equal(await page.locator('#trySample').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="files"]').isDisabled(), true);
    assert.equal(await page.locator('[data-tab="paste"]').isDisabled(), true);
    available = true;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.locator('#retryLoad').waitFor({ state: 'hidden' });
    await page.locator('#import').click();
    await page.locator('#file').setInputFiles({
      name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
        format: 'hayiti/1', trip: { id: 'recovered', title: 'Recovered trip', start: '2026-06-14', end: '2026-06-14', stops: [] }
      }))
    });
    await page.getByRole('button', { name: 'Load trip' }).click();
    await page.locator('#title').filter({ hasText: 'Recovered trip' }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a hosted journal restores backup routes and reports pins without a location', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const current = { id: 'park', name: 'Correct park', xy: [52, 4], date: '2026-06-15', dayEdited: true };
    const trip = { id: 'restore', title: 'City break', start: '2026-06-14', end: '2026-06-15', stops: [], edges: [], googlePins: [current] };
    const route = { a: 'museum', b: 'market', type: 'walk', line: [[52, 4], [52.001, 4.0005], [52.002, 4.002]], m: 285 };
    let saved = [trip];
    await hostJournal(page, route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: saved, rev: '1' } });
      saved = route.request().postDataJSON().trips;
      return route.fulfill({ json: { rev: '2' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: trip.title }).waitFor();
    await page.locator('#import').click();
    await page.locator('[data-tab=files]').click();
    await page.locator('#file').setInputFiles({ name: 'legacy.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'hayiti/1', trip: { ...trip,
        stops: [{ id: 'museum', name: 'Museum', date: trip.start, rank: 1, xy: route.line[0] },
          { id: 'market', name: 'Market', date: trip.start, rank: 2, xy: route.line[2] }], edges: [route],
        googlePins: [{ ...current, name: 'Old park', xy: [51, 4] },
          { id: 'unknown', name: 'Unknown', xy: [0, 0] }, { id: 'tower', name: 'Tower', xy: [52, 4.1] }] } })) });
    await page.locator('#preview').filter({ hasText: '1 route segment from backup' }).waitFor();
    await page.locator('#preview').getByText(/One pin skipped because its location is unknown/).waitFor();
    await page.locator('#preview button').click();
    await page.locator('#status').filter({ hasText: 'One pin skipped because its location is unknown' }).waitFor();
    await page.locator('#status').filter({ hasText: '1 route segment from backup' }).waitFor();
    assert.equal(saved[0].stops.length, 2);
    assert.deepEqual(saved[0].edges, [route]);
    assert.deepEqual(saved[0].googlePins, [current, { id: 'tower', name: 'Tower', xy: [52, 4.1] }]);
  } finally {
    await browser.close();
  }
});

await test('a guest backup save reports storage failures without changing the stored journal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401 }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Small trip');
    const previous = await readGuestRecord(page);
    await refuseGuestWrites(page);
    const photo = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(280000);
    const date = '2026-06-14';
    const stops = Array.from({ length: 24 }, (_, i) => ({ id: 'p' + i, name: 'Visit ' + i, date, photos: [photo] }));
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'photos.json', mimeType: 'application/json', buffer: Buffer.from(
      JSON.stringify({ format: 'hayiti/1', trip: { id: 'photos', title: 'Photo trip', start: date, end: date, stops } })
    ) });
    await page.locator('#preview button').click();
    await page.locator('#sources .form-error').filter({ hasText: 'could not save the edit' }).waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Small trip');
    assert.deepEqual(await readGuestRecord(page), previous);
  } finally {
    await browser.close();
  }
});

await test('a places CSV uses Name for stops when the traveler chooses the date order', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401 }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'June day', '2026-06-05');
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'places.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Date,Name,Description\n06/05/2026,Beach,Afternoon swim') });
    const preview = page.locator('#preview');
    await preview.getByRole('button', { name: 'Month / day / year' }).click();
    await preview.locator('button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByText('Beach', { exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a bank CSV without map pins shows its named purchases immediately without adding route stops', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, route => route.fulfill({ status: 401 }));
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Card purchases', '2026-06-14');
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({ name: 'chase.csv', mimeType: 'text/csv', buffer: Buffer.from([
      'Transaction Date,Post Date,Description,Amount',
      '06/14/2026,06/15/2026,Riverside Cafe,-12.50',
      '06/14/2026,06/15/2026,City Museum,-18.00',
      '06/14/2026,06/15/2026,Market Hall,-9.25'
    ].join('\n')) });
    await page.locator('#preview button').click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#other').evaluate(element => (element as HTMLDetailsElement).open), true);
    assert.equal(await page.locator('#reviewList').isVisible(), true);
    assert.deepEqual(await page.locator('#reviewList .detail-name').allTextContents(), ['Riverside Cafe', 'City Museum', 'Market Hall']);
    assert.equal(await page.locator('#count').innerText(), '0 stops');
    assert.equal(await page.locator('#stops li.stop').count(), 0);
    assert.equal(await page.locator('#map .pin').count(), 0);
    assert.match(await page.locator('#tripDate option:checked').textContent() ?? '', /3 entries/);
    await page.locator('#otherSummary').click();
    await page.locator('#languageSwitch').selectOption('he');
    assert.equal(await page.locator('#other').evaluate(element => (element as HTMLDetailsElement).open), false);
    assert.match(await page.locator('#tripDate option:checked').textContent() ?? '', /3 רשומות/);
  } finally {
    await browser.close();
  }
});

await test('double-clicking Save in trip settings submits once without an alert', async () => {
  const browser = await chromium.launch();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    const titles: string[] = [], alerts: string[] = [];
    page.on('dialog', dialog => { alerts.push(dialog.message()); void dialog.dismiss(); });
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        titles.push(route.request().postDataJSON().trips[0].title);
        await held;
        return route.fulfill({ json: { rev: 'r2' } });
      }
      return route.fulfill({ json: { schemaVersion: journalSchemaVersion, rev: 'r1', trips: [
        { id: 'ta', title: 'My trip', start: '2026-06-14', end: '2026-06-14', stops: [] }
      ] } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    await page.locator('#settings').click();
    await page.locator('#tripForm [name=title]').fill('Tel Aviv');
    await page.locator('#tripForm .primary').dblclick();
    release();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').textContent(), 'Tel Aviv');
    assert.deepEqual(titles, ['Tel Aviv']);
    assert.deepEqual(alerts, []);
    assert.equal(await page.locator('.form-error').count(), 0);
  } finally {
    release();
    await browser.close();
  }
});

const guestAPI = (route: Route) => route.fulfill({ status: 401, json: { error: 'Authentication required' } });

await test('a phone-width journal with two trips keeps every control on screen', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Lisbon with a deliberately long trip name that wraps');
    await createTrip(page, 'Porto');
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.equal(fits, true);
    for (const id of ['#trips', '#settings', '#newTrip', '#add']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, id + ' is on screen');
    }
  } finally {
    await browser.close();
  }
});

await test('a trip made without signing in is still there in a new tab, and both tabs stay in step', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const first = await context.newPage();
    await hostJournal(first, guestAPI);
    await first.goto(origin + '/journal.html?lang=en');
    await createTrip(first, 'Guest trip');
    await first.locator('#status').filter({ hasText: 'Saved on this device' }).waitFor();
    // The trip is kept, so leaving needs no warning.
    assert.equal(await first.evaluate(() => {
      const leaving = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    }), false);

    const second = await context.newPage();
    await hostJournal(second, guestAPI);
    await second.goto(origin + '/journal.html?lang=en');
    await second.locator('#title').filter({ hasText: 'Guest trip' }).waitFor();

    await createTrip(second, 'Made in the second tab');
    await first.locator('#trips option').filter({ hasText: 'Made in the second tab' }).waitFor({ state: 'attached' });
    await createTrip(first, 'Made in the first tab');
    const saved = await guestTitles(first);
    assert.deepEqual(saved.sort(), ['Guest trip', 'Made in the first tab', 'Made in the second tab']);
  } finally {
    await browser.close();
  }
});

await test('a draft left in a tab by an earlier version moves into the browser', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await page.evaluate(key => {
      sessionStorage.setItem(key, JSON.stringify({ trips: [{ id: 'old', title: 'Started last week', start: '2026-06-14', end: '2026-06-14', stops: [] }] }));
    }, draftKey);
    await page.reload();
    await page.locator('#title').filter({ hasText: 'Started last week' }).waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
    assert.deepEqual(await guestTitles(page), ['Started last week']);
  } finally {
    await browser.close();
  }
});

await test('saving an address without a pin finds the pin, and says so when it cannot', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, guestAPI);
    const asked: string[] = [];
    let places = [{ display_name: 'Dizengoff 99, Tel Aviv', lat: '32.0795', lon: '34.7740' }];
    await page.route('https://nominatim.openstreetmap.org/**', route => {
      asked.push(new URL(route.request().url()).searchParams.get('q') ?? '');
      return route.fulfill({ json: places });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Tel Aviv', '2026-06-14');

    await page.locator('#add').click();
    await page.locator('#editForm [name=name]').fill('Dinner');
    await page.locator('#editForm [name=address]').fill('Dizengoff 99, Tel Aviv');
    await page.locator('#editForm .form-actions .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    assert.deepEqual(asked, ['Dizengoff 99, Tel Aviv']);
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 1);

    // An address that is already saved is not looked up again.
    await page.getByRole('button', { name: 'Dinner', exact: true }).click();
    await page.locator('#editForm [name=notes]').fill('Window table');
    await page.locator('#editForm .form-actions .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    assert.equal(asked.length, 1);

    places = [];
    await page.locator('#add').click();
    await page.locator('#editForm [name=name]').fill('Somewhere');
    await page.locator('#editForm [name=address]').fill('No such street 1');
    await page.locator('#editForm .form-actions .primary').click();
    await page.locator('#edit .form-error').filter({ hasText: 'This address was not found on the map.' }).waitFor();
    assert.equal(await page.locator('#editForm [name=name]').inputValue(), 'Somewhere');
    await page.locator('#editForm .form-actions .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    assert.equal(asked.length, 2);
    assert.equal(await page.locator('#stops .stopname').count(), 1);
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 1);
    await showDayDetails(page);
    await page.locator('#unlocatedList').getByText('Somewhere', { exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a form opened for a trip that was deleted elsewhere saves nothing onto another trip', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const tripA = { id: 'a', title: 'Trip A', start: '2026-06-14', end: '2026-06-14', stops: [] };
    const tripB = { id: 'b', title: 'Trip B', start: '2026-07-01', end: '2026-07-01', stops: [] };
    let trips = [tripA, tripB],
      rev = 'r1',
      writes = 0,
      release = () => {},
      held: Promise<void> | null = null;
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        writes++;
        return route.fulfill({ json: { rev: 'r3' } });
      }
      const answer = { schemaVersion: journalSchemaVersion, trips, rev };
      if (held) await held;
      await route.fulfill({ json: answer });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    await page.locator('#trips').selectOption({ label: 'Trip A' });

    // The refresh is in flight when the traveler opens trip settings, and reports that Trip A is gone.
    trips = [tripB];
    rev = 'r2';
    held = new Promise(resolve => { release = resolve; });
    const read = page.waitForResponse(response => response.url().endsWith('/api/journal'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#settings').click();
    assert.equal(await page.locator('#tripForm [name=title]').inputValue(), 'Trip A');
    release();
    await read;
    await page.locator('#title').filter({ hasText: 'Trip B' }).waitFor();

    await page.locator('#tripForm [name=title]').fill('Trip A renamed');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: 'no longer the one open in your journal' }).waitFor();
    assert.equal(writes, 0);
    assert.equal(await page.locator('#title').textContent(), 'Trip B');
  } finally {
    await browser.close();
  }
});

await test('a form whose trip changed elsewhere says so before it saves over the change', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let trip = { id: 'a', title: 'Trip A', start: '2026-06-14', end: '2026-06-14', stops: [] as unknown[] },
      rev = 'r1',
      release = () => {},
      held: Promise<void> | null = null;
    const writes: string[] = [];
    await hostJournal(page, async route => {
      if (route.request().method() === 'POST') {
        writes.push(route.request().postData() ?? '');
        return route.fulfill({ json: { rev: 'r3' } });
      }
      const answer = { schemaVersion: journalSchemaVersion, trips: [trip], rev };
      if (held) await held;
      await route.fulfill({ json: answer });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();

    trip = { ...trip, stops: [{ id: 's', date: '2026-06-14', name: 'Added in ChatGPT' }] };
    rev = 'r2';
    held = new Promise(resolve => { release = resolve; });
    const read = page.waitForResponse(response => response.url().endsWith('/api/journal'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#settings').click();
    release();
    await read;
    await page.locator('#unlocatedList').getByText('Added in ChatGPT', { exact: true }).waitFor({ state: 'attached' });

    await page.locator('#tripForm [name=title]').fill('Trip A renamed');
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: 'Your journal changed while this form was open' }).waitFor();
    assert.equal(writes.length, 0);
    await page.locator('#tripForm .primary').click();
    await page.locator('#config').waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    assert.match(writes[0], /Trip A renamed/);
    assert.match(writes[0], /Added in ChatGPT/);
  } finally {
    await browser.close();
  }
});

await test('an end date before the start date is explained inside trip settings', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#newTrip').click();
    await page.locator('#tripForm [name=title]').fill('Backwards');
    await page.locator('#tripForm [name=end]').fill('2026-05-03');
    await page.locator('#tripForm [name=start]').evaluate((input: HTMLInputElement) => { input.value = '2026-05-12'; });
    await page.locator('#tripForm .primary').click();
    await page.locator('#config .form-error').filter({ hasText: 'The end date cannot be before the start date.' }).waitFor();
    assert.equal(await page.locator('#config').getAttribute('open'), '');
    assert.deepEqual(dialogs, []);
  } finally {
    await browser.close();
  }
});

await test('stops saved elsewhere appear when the traveler returns to the tab', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const trip = { id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-14', stops: [] as unknown[] };
    let rev = 'r1';
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev } }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal(await page.locator('#stops .stopname').count(), 0);

    trip.stops = [{ id: 'a', date: '2026-06-14', name: 'Added in ChatGPT', xy: [32.07, 34.78] }];
    rev = 'r2';
    const read = page.waitForResponse(response => response.url().endsWith('/api/journal'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await read;
    await page.getByRole('button', { name: 'Added in ChatGPT', exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

await test('a draft found by someone who did not sign in from its tab is shown and joins their journal only if they say so', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const bucket = new MemoryBucket();
    let signedIn = false,
      writes = 0;
    const host = (page: Page) => hostJournal(page, async route => {
      const request = route.request();
      if (request.method() === 'POST') writes++;
      const response = await journalAPI(new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postData()
      }), bucket, 'web', signedIn ? 'traveler' : null);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    const earlier = await context.newPage();
    await host(earlier);
    await earlier.goto(origin + '/journal.html?lang=en');
    await createTrip(earlier, 'Left by an earlier visitor');
    await earlier.close();

    // Someone opens the site later in the same browser, already signed in.
    signedIn = true;
    const page = await context.newPage();
    await host(page);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#confirmText').filter({ hasText: 'Left by an earlier visitor' }).waitFor();
    await page.locator('#confirmNo').click();
    await page.locator('#status').filter({ hasText: 'left out of your journal' }).waitFor();
    assert.equal(writes, 0);
    assert.equal(await page.locator('#trips option').filter({ hasText: 'Left by an earlier visitor' }).count(), 0);
    assert.equal((await readGuestRecord(page))?.trips.length, 1);

    // Returning to the tab checks the journal again without asking twice.
    const read = page.waitForResponse(response => response.url().endsWith('/api/journal'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await read;
    assert.equal(await page.locator('#confirmBox').getAttribute('open'), null);

    await page.reload();
    await page.locator('#confirmText').filter({ hasText: 'Left by an earlier visitor' }).waitFor();
    await page.locator('#confirmYes').click();
    await page.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 1);
    assert.deepEqual(await guestTitles(page), []);
  } finally {
    await browser.close();
  }
});

await test('Sign out is offered only while the account journal is open', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let signedIn = true;
    await hostJournal(page, route => signedIn
      ? route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [], rev: 'r1' } })
      : route.fulfill({ status: 401, json: { error: 'Authentication required' } }));
    await page.goto(origin + '/journal.html?lang=en');
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    await openMenu(page);
    await signOut.waitFor();
    assert.equal(await page.locator('#login').isVisible(), false);

    signedIn = false;
    await page.reload();
    await page.getByRole('link', { name: 'Sign in with ChatGPT', exact: true }).waitFor();
    await openMenu(page);
    assert.equal(await signOut.isVisible(), false);
  } finally {
    await browser.close();
  }
});

await test('the mobile sheet keeps the date reel on one row and the day actions on another in either language', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ hasTouch: true });
    const trip = { id: 'toolbar', title: 'Toolbar trip', start: '2026-06-14', end: '2026-06-16', stops: [] };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    for (const lang of ['he', 'en']) {
      await page.goto(origin + '/journal.html?lang=' + lang);
      const toolbar = page.locator('.toolbar');
      const overview = page.locator('#menu #wholeTrip');
      await page.locator('#dayReel').waitFor();
      for (const width of [320, 375, 390, 430]) {
        await page.setViewportSize({ width, height: 852 });
        const [left, right] = await page.locator('#settings, #newTrip').evaluateAll(buttons =>
          buttons.map(button => {
            const { left, right, top } = button.getBoundingClientRect();
            return { left, right, top };
          }).sort((a, b) => a.left - b.left));
        assert.equal(left.top, right.top);
        assert.ok(right.left >= left.right, `${lang} ${width}px: trip settings and new trip sit side by side`);
        for (const pressed of [false, true]) {
          assert.equal(await overview.getAttribute('aria-pressed'), String(pressed));
          const days = await page.locator('.daybar').evaluate(bar => {
            const sheet = bar.getBoundingClientRect();
            const parts = [...bar.querySelectorAll('#dayReel, .date-menu')].map(part => part.getBoundingClientRect());
            const reel = bar.querySelector('#dayReel')!.getBoundingClientRect();
            const faces = [...bar.querySelectorAll('#dayReel > div')].filter(face => {
              const box = face.getBoundingClientRect();
              return box.top < reel.bottom - 1 && box.bottom > reel.top + 1 && getComputedStyle(face).visibility !== 'hidden';
            });
            return {
              count: parts.length,
              oneRow: Math.max(...parts.map(box => box.top)) < Math.min(...parts.map(box => box.bottom)),
              inside: parts.every(box => box.left >= sheet.left - 1 && box.right <= sheet.right + 1),
              dates: faces.length,
              named: getComputedStyle(bar.querySelector('.date-control')!, '::before').content
            };
          });
          const whole = lang === 'he' ? 'כל הטיול' : 'Whole trip';
          assert.deepEqual(days, { count: 2, oneRow: true, inside: true, dates: pressed ? 0 : 1, named: pressed ? JSON.stringify(whole) : 'none' }, `${lang} ${width}px: day row`);
          const boxes = await toolbar.locator('button:visible').evaluateAll(buttons => buttons.map(button => {
            const { top, left, right } = button.getBoundingClientRect();
            const label = [...button.children].find(child => child.localName === 'span' && child.checkVisibility()) ?? button;
            const range = document.createRange();
            range.selectNodeContents(label);
            // Bidirectional glyph runs can share a baseline while having different font ascents.
            const runs = [...range.getClientRects()].filter(rect => rect.width && rect.height);
            const overlap = Math.min(...runs.map(rect => rect.bottom)) - Math.max(...runs.map(rect => rect.top));
            const oneLine = runs.length > 0 && overlap > Math.min(...runs.map(rect => rect.height)) / 2;
            const fits = runs.every(rect => rect.left >= left - 1 && rect.right <= right + 1);
            return { id: button.id, top, left, right, oneLine, fits };
          }));
          // The whole-trip view has no single day to add a stop to or to put in order.
          assert.deepEqual(boxes.map(box => box.id), pressed ? ['import'] : ['add', 'import', 'organize']);
          for (const box of boxes) assert.ok(box.oneLine && box.fits, `${lang} ${width}px: ${box.id} label must fit on one line`);
          assert.equal(await toolbar.getByRole('button', { name: lang === 'he' ? 'מקורות וייבוא' : 'Sources and import', exact: true }).count(), 1);
          // On the narrowest phone the button shows its short name, in the journal's language.
          const shown = width < 360 ? ['מקורות', 'Sources'] : ['מקורות וייבוא', 'Sources and import'];
          assert.equal(await toolbar.locator('#import').innerText(), shown[lang === 'he' ? 0 : 1]);
          if (!pressed) assert.equal(await toolbar.getByRole('button', { name: lang === 'he' ? 'הצע סדר הליכה' : 'Suggest walking order', exact: true }).count(), 1);
          assert.ok(boxes.every(box => box.top === boxes[0].top));
          const bounds = await toolbar.boundingBox();
          assert.ok(bounds);
          assert.ok(boxes.every(box => box.left >= bounds.x - 1 && box.right <= bounds.x + bounds.width + 1));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${lang} ${width}px: nothing spills past the window`);
          assert.equal(await page.locator('nav #mapStyle').count(), 0);
          await openMenu(page);
          assert.equal(await page.locator('#menu #mapStyle').isVisible(), true);
          assert.equal(await overview.innerText(), pressed ? (lang === 'he' ? 'חזרה ליום' : 'Back to the day') : whole);
          await overview.click();
          await page.locator('#menu').waitFor({ state: 'hidden' });
        }
      }
      await page.setViewportSize({ width: 960, height: 852 });
      assert.equal(await toolbar.locator('#import').innerText(), lang === 'he' ? 'מקורות וייבוא' : 'Sources and import');
    }
  } finally {
    await browser.close();
  }
});

await test('the date reel turns through the days, and the day count follows it beside the walking summary', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ hasTouch: true });
    const trip = { id: 'ordinal', start: '2026-10-20', end: '2026-11-19', stops: [{ id: 'a', name: 'Market', date: '2026-10-22', xy: [51.92, 4.48] }] };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    const reel = page.locator('#dayReel');
    const progress = page.locator('#dayProgress');
    const shown = () => reel.evaluate(wheel => {
      const opening = wheel.getBoundingClientRect();
      return [...wheel.children].filter(face => {
        const box = face.getBoundingClientRect();
        return box.top < opening.bottom - 2 && box.bottom > opening.top + 2 && getComputedStyle(face).visibility !== 'hidden';
      }).map(face => (face as HTMLElement).innerText.trim());
    });
    const listed = () => page.locator('#tripDate').evaluate(menu => (menu as HTMLSelectElement).selectedOptions[0].text.split(' · ')[0]);
    for (const lang of ['he', 'en']) {
      await page.goto(origin + '/journal.html?lang=' + lang);
      const dayLabel = (day: number) => lang === 'he' ? `יום ${day} מתוך 31` : `Day ${day} of 31`;
      for (const width of [375, 393]) {
        await page.setViewportSize({ width, height: 852 });
        await page.locator('#tripDate').selectOption('2026-10-22');
        assert.equal(await progress.innerText(), dayLabel(3));
        assert.ok((await reel.getAttribute('aria-valuetext'))?.includes(dayLabel(3)));
        assert.deepEqual([await reel.getAttribute('aria-valuenow'), await reel.getAttribute('aria-valuemax')], ['3', '31']);
        assert.deepEqual(await shown(), [await listed()]);
        const date = await reel.locator('> div').nth(2).locator('span').boundingBox();
        const wheel = await reel.boundingBox();
        assert.ok(date && wheel && date.x >= wheel.x && date.x + date.width <= wheel.x + wheel.width);
        assert.deepEqual(await page.locator('#tripDate option').evaluateAll(options =>
          options.filter(option => option.textContent.includes('·')).map(option => (option as HTMLOptionElement).value)), ['2026-10-22']);
        const counter = await progress.boundingBox();
        const summary = await page.locator('#dayStats summary').boundingBox();
        assert.ok(counter && summary && counter.y < summary.y + summary.height && summary.y < counter.y + counter.height);
        assert.ok(lang === 'he' ? counter.x + counter.width <= summary.x : counter.x >= summary.x + summary.width);
        await reel.evaluate(el => { el.scrollTop += el.clientHeight; });
        await progress.filter({ hasText: dayLabel(4) }).waitFor();
        assert.equal(await page.locator('#tripDate').inputValue(), '2026-10-23');
        assert.deepEqual(await shown(), [await listed()]);
        for (const [key, day] of [['ArrowUp', 5], ['ArrowDown', 4], ['PageUp', 11], ['PageDown', 4]] as const) {
          await reel.press(key);
          assert.equal(await progress.innerText(), dayLabel(day));
          assert.equal(await reel.getAttribute('aria-valuenow'), String(day));
        }
        await reel.press('Space');
        await page.waitForTimeout(300);
        assert.equal(await progress.innerText(), dayLabel(4), 'Space leaves the day as it is');
        await reel.press('End');
        assert.equal(await progress.innerText(), dayLabel(31));
        assert.equal(await page.locator('#tripDate').inputValue(), '2026-11-19');
        await toggleWholeTrip(page);
        assert.equal(await progress.isVisible(), false);
        assert.deepEqual(await shown(), []);
        assert.equal(await page.locator('.date-control').evaluate(control => getComputedStyle(control, '::before').content),
          JSON.stringify(lang === 'he' ? 'כל הטיול' : 'Whole trip'));
        await reel.click();
        assert.equal(await page.locator('#wholeTrip').getAttribute('aria-pressed'), 'false');
        assert.equal(await progress.innerText(), dayLabel(31));
        assert.deepEqual(await shown(), [await listed()]);
      }
      await page.setViewportSize({ width: 1200, height: 852 });
      assert.equal(await progress.isVisible(), true);
      assert.deepEqual(await shown(), [await listed()]);
    }
  } finally {
    await browser.close();
  }
});

await test('a one-day trip announces the whole-trip view and reopens the day from the reel or date list', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 553 } });
    const date = '2026-06-14';
    const trip = { id: 'park', title: 'Harbor day', start: date, end: date,
      stops: [{ id: 'visit', name: 'South park', date, xy: [51.92, 4.48] }] };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    await page.goto(origin + '/journal.html?lang=en');
    const reel = page.getByRole('spinbutton'), dates = page.locator('#tripDate');
    await reel.waitFor();
    for (const [lang, whole] of [['en', 'Whole trip'], ['he', 'כל הטיול']]) {
      await page.locator('#languageSwitch').selectOption(lang);
      const day = await reel.getAttribute('aria-valuetext');
      assert.ok(day && day !== whole);
      for (const control of ['Enter', 'Space', 'ArrowDown', 'Home', 'End', 'list']) {
        await toggleWholeTrip(page);
        assert.equal(await reel.getAttribute('aria-valuetext'), whole);
        assert.equal(await dates.inputValue(), '');
        if (control === 'list') await dates.selectOption(date);
        else await reel.press(control);
        assert.equal(await page.locator('#wholeTrip').getAttribute('aria-pressed'), 'false');
        assert.equal(await reel.getAttribute('aria-valuetext'), day);
        assert.equal(await dates.inputValue(), date);
        assert.equal(await page.locator('#stops .stopname').innerText(), 'South park');
      }
    }
  } finally {
    await browser.close();
  }
});

await test('the mobile bar fits on one row and sign-out, in the menu, requires confirmation in both languages', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const trip = { id: 'a', title: 'My trip', start: '2026-06-14', end: '2026-06-14', stops: [] };
    let signedIn = true;
    await hostJournal(page, route => signedIn
      ? route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } })
      : route.fulfill({ status: 401 }));
    const signOutUrl = origin + '/signout-with-chatgpt?return_to=%2Fjournal.html';
    await page.route(signOutUrl, route => route.fulfill({ contentType: 'text/html', body: 'Signed out' }));
    const oneRow = async (parts: string, count: number, note: string) => {
      const width = page.viewportSize()!.width;
      const bounds = await page.locator(parts).evaluateAll(elements => elements.filter(element => element.checkVisibility()).map(element => {
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      }));
      assert.equal(bounds.length, count, note);
      assert.ok(bounds.every(box => box.right > box.left && box.left >= 0 && box.right <= width), note + ' fits');
      assert.ok(Math.max(...bounds.map(box => box.top)) < Math.min(...bounds.map(box => box.bottom)), note + ' shares one row');
      // Neighbors do not overlap.
      const ordered = bounds.sort((a, b) => a.left - b.left);
      assert.ok(ordered.every((box, index) => !index || box.left >= ordered[index - 1].right), note + ' leaves each control its own place');
    };
    for (const language of ['he', 'en']) {
      const journalUrl = origin + '/journal.html?lang=' + language;
      signedIn = true;
      await page.goto(journalUrl);
      await page.locator('#title').filter({ hasText: 'My trip' }).waitFor();
      for (const width of [320, 375, 430]) {
        await page.setViewportSize({ width, height: 812 });
        await oneRow('.brand, #share, #login, #languageSwitch, #menuButton', 4, `${language} ${width}px signed-in bar`);
      }
      await page.setViewportSize({ width: 375, height: 812 });
      const signOut = page.getByRole('button', { name: language === 'he' ? 'יציאה מהחשבון' : 'Sign out', exact: true });
      await openMenu(page);
      const box = await signOut.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, 'sign-out tap target');
      assert.equal(await signOut.innerText(), language === 'he' ? 'יציאה מהחשבון' : 'Sign out');

      await signOut.press('Enter');
      const dialog = page.getByRole('alertdialog');
      const cancel = dialog.getByRole('button', { name: language === 'he' ? 'ביטול' : 'Cancel', exact: true });
      await cancel.waitFor();
      assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
      await cancel.press('Enter');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(page.url(), journalUrl);
      // The question closed the menu, so the keyboard returns to the button that opens it.
      assert.equal(await signOut.isVisible(), false);
      assert.equal(await page.locator('#menuButton').evaluate(element => element === document.activeElement), true);
      await openMenu(page);
      await signOut.click();
      await dialog.locator('#confirmYes').click();
      await page.waitForURL(signOutUrl);

      // A guest sees a short Sign in instead, and the bar still fits.
      signedIn = false;
      await page.goto(journalUrl);
      await page.locator('#login').waitFor();
      assert.equal(await page.locator('#login').innerText(), language === 'he' ? 'כניסה' : 'Sign in');
      for (const width of [320, 375, 430]) {
        await page.setViewportSize({ width, height: 812 });
        await oneRow('.brand, #share, #login, #languageSwitch, #menuButton', 5, `${language} ${width}px guest bar`);
      }
      await page.setViewportSize({ width: 375, height: 812 });
    }
  } finally {
    await browser.close();
  }
});

const hostBucket = (page: Page, bucket: MemoryBucket, signedIn: () => boolean, onWrite = () => {}) => hostJournal(page, async route => {
  const request = route.request();
  if (request.method() === 'POST') onWrite();
  const response = await journalAPI(new Request(request.url(), {
    method: request.method(),
    headers: await request.allHeaders(),
    body: request.postData()
  }), bucket, 'web', signedIn() ? 'traveler' : null);
  await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
});
const storedTitles = guestTitles;

await test('a trip made in another tab while sign-in asks about the draft stays in the browser', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const bucket = new MemoryBucket();
    let writes = 0;
    const guest = await context.newPage();
    await hostBucket(guest, bucket, () => false);
    await guest.goto(origin + '/journal.html?lang=en');
    await createTrip(guest, 'Trip A');

    const account = await context.newPage();
    await hostBucket(account, bucket, () => true, () => writes++);
    await account.goto(origin + '/journal.html?lang=en');
    await account.locator('#confirmText').filter({ hasText: 'Trip A' }).waitFor();

    await createTrip(guest, 'Trip B');
    assert.deepEqual(await storedTitles(guest), ['Trip A', 'Trip B']);

    await account.locator('#confirmYes').click();
    await account.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 1);
    assert.equal(await account.locator('#title').textContent(), 'Trip A');
    assert.deepEqual((await loadState(bucket, 'traveler')).trips.map(trip => trip.title), ['Trip A']);
    // Only the trip that was shown and uploaded left the browser.
    assert.deepEqual(await storedTitles(account), ['Trip B']);
  } finally {
    await browser.close();
  }
});

await test('a draft edited in another tab during sign-in requires consent to its new contents', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const bucket = new MemoryBucket();
    let writes = 0;
    const guest = await context.newPage();
    await hostBucket(guest, bucket, () => false);
    await guest.goto(origin + '/journal.html?lang=en');
    await createTrip(guest, 'Trip A');

    const account = await context.newPage();
    await hostBucket(account, bucket, () => true, () => writes++);
    await account.goto(origin + '/journal.html?lang=en');
    await account.locator('#confirmText').filter({ hasText: 'Trip A' }).waitFor();

    await guest.locator('#settings').click();
    await guest.locator('#tripForm [name=title]').fill('Trip A edited');
    await guest.locator('#tripForm .primary').click();
    await guest.locator('#config').waitFor({ state: 'hidden' });
    await account.locator('#confirmYes').click();
    await account.locator('#status').filter({ hasText: 'journal changed during sign-in' }).waitFor();
    assert.equal(writes, 0);
    assert.deepEqual((await loadState(bucket, 'traveler')).trips, []);
    assert.deepEqual(await storedTitles(account), ['Trip A edited']);

    await openConnectedAccounts(account);
    await account.locator('#reload').click();
    await account.locator('#confirmText').filter({ hasText: 'Trip A edited' }).waitFor();
    await account.locator('#confirmYes').click();
    await account.locator('#status').filter({ hasText: 'is now in your journal' }).waitFor();
    assert.equal(writes, 1);
    assert.deepEqual((await loadState(bucket, 'traveler')).trips.map(trip => trip.title), ['Trip A edited']);
    assert.deepEqual(await storedTitles(account), []);
  } finally {
    await browser.close();
  }
});

await test('an address lookup that answers after its stop was canceled saves nothing onto the next stop', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, guestAPI);
    let answer = () => {};
    const asked = new Promise<void>(resolve => {
      void page.route('https://nominatim.openstreetmap.org/**', async route => {
        const held = new Promise<void>(release => { answer = release; });
        resolve();
        await held;
        await route.fulfill({ json: [{ display_name: 'First address', lat: '32.0795', lon: '34.7740' }] });
      });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Tel Aviv', '2026-06-14');

    await page.locator('#add').click();
    await page.locator('#editForm [name=name]').fill('First stop');
    await page.locator('#editForm [name=address]').fill('First address');
    await page.locator('#editForm .form-actions .primary').click();
    await asked;
    await page.locator('#edit [data-close]').click();

    await page.locator('#add').click();
    await page.locator('#editForm [name=name]').fill('Second stop');
    const answered = page.waitForResponse(response => response.url().startsWith('https://nominatim.openstreetmap.org/'));
    answer();
    await answered;
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#edit').getAttribute('open'), '');
    assert.equal(await page.locator('#editForm [name=coords]').inputValue(), '');
    assert.equal(await page.locator('#stops .stopname').count(), 0);
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 0);
  } finally {
    await browser.close();
  }
});

await test('deleting the last guest trip in one tab removes it from the other tab too', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const first = await context.newPage(),
      second = await context.newPage();
    for (const page of [first, second]) await hostJournal(page, guestAPI);
    await first.goto(origin + '/journal.html?lang=en');
    await createTrip(first, 'Deleted in the first tab');
    await second.goto(origin + '/journal.html?lang=en');
    await second.locator('#title').filter({ hasText: 'Deleted in the first tab' }).waitFor();

    await first.locator('#settings').click();
    await first.locator('#deleteTrip').click();
    await first.locator('#confirmYes').click();
    await first.locator('#config').waitFor({ state: 'hidden' });
    await second.locator('#welcome').waitFor();
    assert.equal(await second.locator('#trips option').count(), 0);

    await createTrip(second, 'Made afterwards');
    assert.deepEqual(await storedTitles(second), ['Made afterwards']);
  } finally {
    await browser.close();
  }
});

await test('a form left open in one guest tab does not undo a change saved in another', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const first = await context.newPage(),
      second = await context.newPage();
    for (const page of [first, second]) await hostJournal(page, guestAPI);
    await first.goto(origin + '/journal.html?lang=en');
    await createTrip(first, 'Original title', '2026-06-14');
    await second.goto(origin + '/journal.html?lang=en');
    await second.locator('#title').filter({ hasText: 'Original title' }).waitFor();

    await first.locator('#settings').click();
    await second.locator('#settings').click();
    await second.locator('#tripForm [name=title]').fill('Renamed in the second tab');
    await second.locator('#tripForm .primary').click();
    await second.locator('#config').waitFor({ state: 'hidden' });
    await first.locator('#title').filter({ hasText: 'Renamed in the second tab' }).waitFor();

    await first.locator('#tripForm [name=end]').fill('2026-06-16');
    await first.locator('#tripForm .primary').click();
    await first.locator('#config .form-error').filter({ hasText: 'Your journal changed while this form was open' }).waitFor();
    assert.deepEqual(await storedTitles(first), ['Renamed in the second tab']);
  } finally {
    await browser.close();
  }
});

await test('two tabs that each hold a draft from the earlier version both keep their trips', async t => {
  const browser = await chromium.launch();
  try {
    const titles = ['First tab trip', 'Second tab trip'];
    for (const order of ['first tab first', 'second tab first', 'together']) {
      await t.test(order, async () => {
        const context = await browser.newContext();
        try {
          const tabs = [await context.newPage(), await context.newPage()];
          for (const [index, page] of tabs.entries()) {
            await hostJournal(page, guestAPI);
            await page.goto(origin + '/privacy.html');
            const trip = { id: String(index), title: titles[index], start: '2026-06-14', end: '2026-06-14', stops: [] };
            await page.evaluate(({ key, trip }) => sessionStorage.setItem(key, JSON.stringify({ trips: [trip] })), { key: draftKey, trip });
          }
          const open = (page: Page) => page.goto(origin + '/journal.html?lang=en');
          if (order === 'together') {
            await Promise.all(tabs.map(open));
          } else {
            const first = order === 'first tab first' ? 0 : 1;
            await open(tabs[first]);
            await tabs[first].locator('#title').filter({ hasText: titles[first] }).waitFor();
            await open(tabs[1 - first]);
          }
          for (const page of tabs) {
            await page.waitForFunction(() => document.querySelectorAll('#trips option').length === 2);
            assert.deepEqual((await page.locator('#trips option').allTextContents()).sort(), titles);
            assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
          }
          assert.deepEqual(await storedTitles(tabs[0]), titles);
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});

await test('a signed-in journal opens in a browser that blocks storage', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const blocked = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
      Storage.prototype.getItem = blocked;
      Storage.prototype.setItem = blocked;
      Storage.prototype.removeItem = blocked;
    });
    await hostJournal(page, route => route.fulfill({
      json: { schemaVersion: journalSchemaVersion, trips: [{ id: 'a', title: 'Saved in the account', start: '2026-06-14', end: '2026-06-14', stops: [] }], rev: 'r1' }
    }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Saved in the account' }).waitFor();
    await page.locator('#status[data-tone="warning"]').filter({ hasText: 'draft in this browser could not be read' }).waitFor();
    assert.equal(await page.locator('#retryLoad').isVisible(), false);
  } finally {
    await browser.close();
  }
});

await test('two guest tabs that save at the same moment both keep their trip', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const tabs = [await context.newPage(), await context.newPage()];
    for (const page of tabs) {
      await hostJournal(page, guestAPI);
      await page.goto(origin + '/journal.html?lang=en');
    }
    const expected: string[] = [];
    for (let round = 0; round < 6; round++) {
      // Each tab must have seen the other's last save before the next pair of saves starts.
      for (const page of tabs) await page.waitForFunction(count => document.querySelectorAll('#trips option').length === count, expected.length);
      const titles = tabs.map((_, tab) => 'Round ' + round + ' tab ' + tab);
      for (const [tab, page] of tabs.entries()) {
        await page.locator('#newTrip').click();
        await page.locator('#tripForm [name=title]').fill(titles[tab]);
      }
      // Both tabs press Save on the same clock tick.
      const moment = Date.now() + 400;
      await Promise.all(tabs.map(page => page.evaluate(at => new Promise<void>(resolve => setTimeout(() => {
        document.querySelector<HTMLButtonElement>('#tripForm .primary')!.click();
        resolve();
      }, at - Date.now())), moment)));
      for (const page of tabs) {
        const settled = page.locator('#config:not([open]), #config .form-error');
        await settled.first().waitFor({ state: 'attached' });
        // The tab that saved second is told the journal changed, and saving again adds its trip.
        if (await page.locator('#config').getAttribute('open') !== null) await page.locator('#tripForm .primary').click();
        await page.locator('#config').waitFor({ state: 'hidden' });
      }
      expected.push(...titles);
      assert.deepEqual(await storedTitles(tabs[0]), [...expected].sort());
    }
  } finally {
    await browser.close();
  }
});

await test('a failed tab-draft migration retains both originals and reload can retry it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Already in the browser');
    const stored = await readGuestRecord(page);
    const legacy = JSON.stringify({ trips: [{ id: 'old', title: 'Still in its tab', start: '2026-06-14', end: '2026-06-14', stops: [] }] });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('fail-guest-migration') !== 'yes') return;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name === 'hayiti-guest') throw new DOMException('Storage full', 'QuotaExceededError');
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await page.evaluate(({ key, draft }) => {
      sessionStorage.setItem(key, draft);
      sessionStorage.setItem('fail-guest-migration', 'yes');
    }, { key: draftKey, draft: legacy });

    await page.reload();
    await page.locator('#retryLoad').waitFor();
    assert.equal(await page.locator('#newTrip').isDisabled(), true);
    assert.deepEqual(await readGuestRecord(page), stored);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), legacy);

    await page.evaluate(() => sessionStorage.removeItem('fail-guest-migration'));
    await page.reload();
    await page.locator('#trips option').filter({ hasText: 'Still in its tab' }).waitFor({ state: 'attached' });
    assert.deepEqual(await storedTitles(page), ['Already in the browser', 'Still in its tab']);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
  } finally {
    await browser.close();
  }
});

await test('choosing Sign in covers the trips shown then, and a trip added afterwards is asked about', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const bucket = new MemoryBucket();
    let signedIn = false,
      writes = 0;
    const page = await context.newPage(),
      other = await context.newPage();
    await hostBucket(page, bucket, () => signedIn, () => writes++);
    await hostBucket(other, bucket, () => false);
    await page.goto(origin + '/journal.html?lang=en');
    await createTrip(page, 'Shown at sign-in');
    await other.goto(origin + '/journal.html?lang=en');
    await other.locator('#title').filter({ hasText: 'Shown at sign-in' }).waitFor();

    await chooseSignIn(page);
    await createTrip(other, 'Added during sign-in');
    signedIn = true;
    await page.reload();
    await page.locator('#confirmText').filter({ hasText: 'Added during sign-in' }).waitFor();
    assert.equal(writes, 0);
    await page.locator('#confirmNo').click();
    await page.locator('#status').filter({ hasText: 'left out of your journal' }).waitFor();
    assert.deepEqual(await storedTitles(page), ['Added during sign-in', 'Shown at sign-in']);
  } finally {
    await browser.close();
  }
});

await test('two tabs that upgrade at the same moment both keep the trips from the earlier version', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const tabs = [await context.newPage(), await context.newPage()];
    for (const page of tabs) {
      await hostJournal(page, guestAPI);
      await page.goto(origin + '/journal.html?lang=en');
    }
    for (let round = 0; round < 5; round++) {
      await patchGuestRecord(tabs[0], { trips: [], importedTabs: [] });
      for (const [tab, page] of tabs.entries()) {
        await page.evaluate(({ key, draft }) => sessionStorage.setItem(key, draft), {
          key: draftKey,
          draft: JSON.stringify({ trips: [{ id: 'tab' + tab, title: 'Legacy trip ' + tab, start: '2026-06-14', end: '2026-06-14', stops: [] }] })
        });
      }
      await Promise.all(tabs.map(page => page.reload()));
      for (const page of tabs) {
        for (const title of ['Legacy trip 0', 'Legacy trip 1']) await page.locator('#trips option').filter({ hasText: title }).waitFor({ state: 'attached' });
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
      }
      assert.deepEqual(await storedTitles(tabs[0]), ['Legacy trip 0', 'Legacy trip 1']);
    }
  } finally {
    await browser.close();
  }
});

await test('a signed-in journal opens in a browser that blocks only tab storage', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() { throw new DOMException('Storage blocked', 'SecurityError'); }
      });
    });
    await hostJournal(page, route => route.fulfill({
      json: { schemaVersion: journalSchemaVersion, trips: [{ id: 'a', title: 'Saved in the account', start: '2026-06-14', end: '2026-06-14', stops: [] }], rev: 'r1' }
    }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Saved in the account' }).waitFor();
    await page.locator('#status[data-tone="warning"]').filter({ hasText: 'draft in this browser could not be read' }).waitFor();
    assert.equal(await page.locator('#retryLoad').isVisible(), false);
  } finally {
    await browser.close();
  }
});

await test('the hosted journal draws the street map and makes route files from the packaged app', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const trip = { id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-14', stops: [{ id: 'a', date: '2026-06-14', name: 'Dinner', xy: [32.07, 34.78] }] };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        version: 8,
        sources: { places: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Injected <img src="x">' } },
        layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } }]
      }
    }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#map canvas.maplibregl-canvas').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), null);
    // The credit line is the journal's own text. Text that arrives with the map never becomes page markup.
    await page.locator('.leaflet-control-attribution').filter({ hasText: 'OpenFreeMap' }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.leaflet-control-attribution img').count(), 0);
    assert.doesNotMatch(await page.locator('.leaflet-control-attribution').innerText(), /Injected/);
    await page.locator('#languageSwitch').selectOption('he');
    await page.locator('#languageSwitch').selectOption('en');

    await page.locator('#share').click();
    await page.waitForFunction(() => document.querySelector<HTMLAnchorElement>('#downloadTrip')?.href.startsWith('blob:'));
    const bytes = await page.evaluate(async () => {
      const response = await fetch(document.querySelector<HTMLAnchorElement>('#downloadTrip')!.href);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    const html = strFromU8(Object.values(unzipSync(Uint8Array.from(bytes)))[0]);
    const packaged = await readFile(new URL('../../dist/web/Hayiti.html', import.meta.url), 'utf8');
    assert.match(html, /<script type="application\/json" id="hayiti-route">/);
    assert.ok(html.replace(/<script type="application\/json" id="hayiti-route">.*?<\/script>/, '') === packaged, 'the route file is the packaged app plus its route');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

await test('the hosted journal opens without the street map library and draws the streets once it downloads', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(),
      errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const trip = { id: 'ta', title: 'Tel Aviv', start: '2026-06-14', end: '2026-06-14', stops: [{ id: 'a', date: '2026-06-14', name: 'Dinner', xy: [32.07, 34.78] }] };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e8efe9' } }] }
    }));
    let reachable = false;
    await page.route(origin + '/vendor/maplibre-gl.js', route => reachable ? route.fallback() : route.abort());
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Tel Aviv' }).waitFor();
    await page.locator('#map[data-note]').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), 'The street map could not load. Pins and routes still appear.');
    assert.equal(await page.locator('.leaflet-marker-icon').count(), 1);
    assert.equal(await page.locator('#newTrip').isEnabled(), true);
    assert.deepEqual(errors, []);

    reachable = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#map canvas.maplibregl-canvas').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-note'), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

await test('the traveler can apply multiple days of street routes in one account save', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const a = [51.92, 4.48], turn = [51.921, 4.48], b = [51.921, 4.485];
    const start = '2026-05-03', end = '2026-05-04';
    const trip = { id: 'route-trip', title: 'Week away', start, end, home: 'Home', homeXY: a,
      stops: [{ id: 'market', name: 'Market', date: start, xy: b }, { id: 'station', name: 'Station', date: end, xy: b }]
    };
    const written: unknown[] = [];
    await hostJournal(page, async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'v1' } });
      written.push(route.request().postDataJSON());
      return route.fulfill({ json: { rev: 'v2' } });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: 'Week away' }).waitFor();
    await page.locator('#import').click();
    await page.locator('[data-tab="files"]').click();
    await page.locator('#file').setInputFiles({
      name: 'street-routes.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'hayiti-routes/1', tripId: trip.id,
        days: trip.stops.map(to => ({ date: to.date, routes: [{ a: 'base', b: to.id, type: 'walk', line: [a, turn, b] }] }))
      }))
    });
    await page.locator('#preview').filter({ hasText: '2 route segments to update' }).waitFor();
    assert.equal(written.length, 0);
    await page.getByRole('button', { name: 'Save routes' }).click();
    await page.locator('#sources').waitFor({ state: 'hidden' });
    assert.equal(written.length, 1);
    const saved = written[0] as { rev: string; trips: { edges: { b: string; line: number[][] }[] }[] };
    assert.equal(saved.rev, 'v1');
    assert.deepEqual(saved.trips[0].edges.map(edge => [edge.b, edge.line]), [['market', [a, turn, b]], ['station', [a, turn, b]]]);
  } finally {
    await browser.close();
  }
});

await test('the hosted journal welcomes a new traveler with the way to build a trip in ChatGPT', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await hostJournal(page, guestAPI);
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#welcome').waitFor();
    assert.deepEqual(await page.locator('#welcome h3:visible').allTextContents(), ['Build your trip in ChatGPT']);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.locator('#dayProgress').isVisible(), false);
    assert.deepEqual(await page.locator('#welcome a:visible').allTextContents(), ['Open ChatGPT']);
  } finally {
    await browser.close();
  }
});

await test('taxi dashes and the walking path are both visible on a shared street in either travel order', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const home = [51.92, 4.48], market = [51.92, 4.49];
    const dates = ['2026-05-03', '2026-05-04'];
    const trip = {
      id: 'round-trip', title: 'Round trip', start: dates[0], end: dates[1], home: 'Home', homeXY: home,
      stops: dates.flatMap(date => [
        { id: date + '-out', date, name: 'Market', xy: market, rank: 1 },
        { id: date + '-back', date, name: 'Back home', xy: home, rank: 2 }
      ]),
      edges: dates.flatMap((date, index) => [
        { a: 'base', b: date + '-out', type: index === 0 ? 'taxi' : 'walk', line: [home, market] },
        { a: date + '-out', b: date + '-back', type: index === 0 ? 'walk' : 'taxi', line: [market, home] }
      ])
    };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    await page.goto(origin + '/journal.html?lang=en');
    await page.locator('#title').filter({ hasText: trip.title }).waitFor();
    for (const date of dates) {
      await page.locator('#tripDate').selectOption(date);
      // Sample the top painted line across several dash periods, away from the pins at each end.
      await page.waitForFunction(() => {
        const lines = [...document.querySelectorAll<SVGPathElement>('#map .leaflet-pane path[stroke]')];
        const walk = lines.find(line => !line.hasAttribute('stroke-dasharray'));
        const taxi = lines.find(line => line.hasAttribute('stroke-dasharray'));
        const matrix = walk?.getScreenCTM();
        if (!walk || !taxi || !matrix) return false;
        const visible = new Set<Element>();
        const length = walk.getTotalLength();
        for (let distance = length / 4; distance < length * .75; distance++) {
          const point = walk.getPointAtLength(distance).matrixTransform(matrix);
          const topLine = document.elementsFromPoint(point.x, point.y).find(el => el === walk || el === taxi);
          if (topLine) visible.add(topLine);
        }
        return visible.size === 2;
      }, undefined, { timeout: 5000 });
    }
  } finally {
    await browser.close();
  }
});

await test('an unlocated in-person purchase shows its address action in daily details in both languages', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const date = '2026-06-14';
    const trip = {
      id: 'purchases', title: 'Purchases', start: date, end: date,
      stops: [
        { id: 'in-store', date, kind: 'visit', sources: ['card'] },
        { id: 'online', name: 'Online order', date, kind: 'remote', sources: ['card'] }
      ]
    };
    await hostJournal(page, route => route.fulfill({ json: { schemaVersion: journalSchemaVersion, trips: [trip], rev: 'r1' } }));
    for (const [lang, name] of [['he', 'קנייה'], ['en', 'Purchase']]) {
      await page.goto(origin + '/journal.html?lang=' + lang);
      await showDayDetails(page);
      const row = page.locator('#unlocatedList .detail-row');
      await row.getByText(name, { exact: true }).waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await page.locator('#stops li.stop').count(), 0);
      assert.equal(await page.locator('#map .pin').count(), 0);
      assert.match(await row.innerText(), lang === 'he' ? /חסר מיקום לסיכה/ : /Purchase location missing/);
      await row.getByRole('button', { name: lang === 'he' ? 'הוספת כתובת · קנייה' : 'Add address · Purchase', exact: true }).click();
      assert.equal(await page.locator('#editForm input[name=address]').evaluate(field => field === document.activeElement), true);
      const label = page.locator('#editForm input[name=name]');
      assert.equal(await label.inputValue(), '');
      assert.equal(await label.getAttribute('placeholder'), name);
      assert.equal(await label.getAttribute('required'), null);
    }
  } finally {
    await browser.close();
  }
});

await test('approximating a hosted pin requires an area point and clears its street address', async () => {
  const browser = await chromium.launch();
  try {
    for (const lang of ['en', 'he']) {
      const page = await browser.newPage();
      const date = '2026-06-14';
      const trip = cleanTrip({
        id: 'private-purchase', title: 'Private purchase', start: date, end: date,
        stops: [
          { id: 'shop', date, name: 'Canal Street Shop', address: '17 Canal Street', xy: [51.922, 4.481] },
          { id: 'museum', date, name: 'Museum', xy: [51.924, 4.484], rank: 1 }
        ],
        edges: [{ a: 'shop', b: 'museum', type: 'walk', line: [[51.922, 4.481], [51.924, 4.484]], m: 350 }]
      });
      const bucket = new MemoryBucket();
      const revision = await storeState(bucket, 'traveler', [trip], '');
      await hostJournal(page, async route => {
        const request = route.request();
        const response = await journalAPI(new Request(request.url(), {
          method: request.method(), headers: await request.allHeaders(), body: request.postData()
        }), bucket, 'web', 'traveler');
        await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
      });
      await page.goto(origin + '/journal.html?lang=' + lang);
      await page.getByRole('button', { name: 'Canal Street Shop', exact: true }).click();
      await page.locator('#editForm input[name=approx]').check();
      await page.locator('#editForm .primary').click();
      await page.locator('#edit .form-error').filter({ hasText: lang === 'en' ? 'Choose a different point' : 'יש לבחור נקודה אחרת' }).waitFor();
      assert.deepEqual(await loadState(bucket, 'traveler'), { trips: [trip], rev: revision });

      await page.locator('#editForm input[name=coords]').fill('51.923, 4.482');
      await page.locator('#editForm .primary').click();
      await page.locator('#edit').waitFor({ state: 'hidden' });
      const saved = await loadState(bucket, 'traveler');
      assert.equal(saved.trips[0].stops[0].address, '');
      assert.equal(saved.trips[0].stops[0].name, 'Canal Street Shop');
      assert.equal(saved.trips[0].stops[0].approx, true);
      assert.deepEqual(saved.trips[0].stops[0].xy, [51.923, 4.482]);
      assert.deepEqual(saved.trips[0].edges, []);
      await page.reload();
      await page.getByRole('button', { name: 'Canal Street Shop', exact: true }).click();
      assert.equal(await page.locator('#editForm input[name=address]').inputValue(), '');
      assert.equal(await page.locator('#editForm input[name=approx]').isChecked(), true);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

await test('editing private notes on an already approximate hosted stop keeps its saved name and address', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const date = '2026-06-14';
    const trip = cleanTrip({
      id: 'approximate-visit', title: 'Market day', start: date, end: date,
      stops: [{ id: 'market', date, name: 'Carmel Market', address: 'Market neighborhood', xy: [32.068, 34.769], approx: true }]
    });
    const bucket = new MemoryBucket();
    await storeState(bucket, 'traveler', [trip], '');
    await hostJournal(page, async route => {
      const request = route.request();
      const response = await journalAPI(new Request(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postData()
      }), bucket, 'web', 'traveler');
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto(origin + '/journal.html?lang=en');
    await page.getByRole('button', { name: 'Carmel Market', exact: true }).click();
    await page.locator('#editForm textarea[name=notes]').fill('Lunch with friends');
    await page.locator('#editForm .primary').click();
    await page.locator('#edit').waitFor({ state: 'hidden' });
    const saved = (await loadState(bucket, 'traveler')).trips[0].stops[0];
    assert.equal(saved.name, 'Carmel Market');
    assert.equal(saved.address, 'Market neighborhood');
    assert.equal(saved.notes, 'Lunch with friends');
    assert.deepEqual(saved.xy, trip.stops[0].xy);
    assert.equal(saved.approx, true);
  } finally {
    await browser.close();
  }
});
