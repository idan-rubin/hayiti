import { element as $, errorMessage } from './dom.ts';
import { member, reportSources, statesBySource, validOutcome, isRecord } from '../domain/core.ts';
import type { Trip, Stop, Source, CheckStatus, Edge, GooglePin, GooglePinResult, Point, MergeResult } from '../domain/core.ts';
import type { ImportResult } from '../domain/importers.ts';
import { language, locale, bindLanguageControl } from './language.ts';
import { displayTripTitle, messages, t, quantity } from './journal-messages.ts';
import { enableSharing } from './share-ui.ts';
import { routeStops, dayDetails, isMappedStop, indexEdges, suggest, walkingStats } from '../domain/daily-route.ts';
import { createDateReel } from './date-reel.ts';
import { createSheet, sheetLayout } from './sheet.ts';
import { fitPadding } from './map-fit.ts';
import { cleanTrip, cleanStop, mergeGooglePins, removeGooglePin, restoreGooglePin, mergeStops, combineEvidence, journalCharacterLimit, unidentifiedMerchant } from '../domain/core.ts';
import { importEvidencePackage, prepareTripBackup, importCsv, importIcs, pastedStop } from '../domain/importers.ts';
import { checkGuestBackup, discardGuest, onGuestChange, guestMergeRequested, requestGuestMerge, hasLegacyGuestTrips } from './guest-draft.ts';
import { prepareApproximateLocation, updateRoutesForStopEdit } from '../domain/stop-location.ts';
import { prepareRouteImport } from '../domain/route-update.ts';
import { JournalSession, localToday } from './journal-session.ts';
import { preparePhoto } from './photos.ts';
import { ask, clearError, showError } from './confirm.ts';
import { projectMapPoints, wrapLongitude } from './map-longitudes.ts';
import { drawGooglePins, assignGooglePinDay, type PinActions } from './google-pins.ts';
import { addStreetMap, isBasemap, type StreetMapProblem } from './street-map.ts';
import sampleTrip from '../../public/sample-trip.json' with { type: 'json' };
const hebrewLabels = Object.fromEntries(Object.entries(messages).map(([he, en]) => [en, he]));
bindLanguageControl(hebrewLabels, refreshLanguage);
const portable = document.documentElement.hasAttribute('data-portable');
const hostedView = !portable && location.hash.startsWith('#route=');
if (hostedView) document.body.classList.add('hosted-view', 'route-copy');
const embeddedRoute = portable ? document.getElementById('hayiti-route') : null;
const sharedRoute = hostedView || embeddedRoute;
const session = new JournalSession();
let draftPhotos: string[] = [],
  photoBusy = false,
  fileEpoch = 0;
function dom<K extends keyof HTMLElementTagNameMap>(tag: K, str?: string, cls?: string) {
  const e = document.createElement(tag);
  if (str !== undefined) e.textContent = str;
  if (cls) e.className = cls;
  return e;
}
const label = {
  card: 'כרטיס אשראי',
  email: 'מייל',
  calendar: 'יומן',
  ticket: 'כרטיס לאירוע',
  whatsapp: 'WhatsApp',
  manual: 'ידני',
  taxi: 'קבלת מונית',
  transfer: 'העברה',
  diary: 'יומן אישי',
  photo: 'תמונה'
};
function formats(region: string) {
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(region, {
    ...options,
    timeZone: 'UTC'
  });
  return {
    full: format({
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    }),
    short: format({
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    }),
    range: format({
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }),
    distance: new Intl.NumberFormat(region, {
      maximumFractionDigits: 1
    })
  };
}
const dateFormats = {
  he: formats('he-IL'),
  en: formats('en-US')
};
const dateLabel = (iso: string, style: 'full' | 'short' | 'range' = 'full') => dateFormats[language][style].format(new Date(iso + 'T12:00:00Z'));
const rangeDate = (iso: string) => language === 'he' ? iso.split('-').reverse().join('.') : dateLabel(iso, 'range');
let selected = '',
  draftId = '',
  pick = false,
  creating = false;
type Tone = '' | 'warning' | 'error';
let currentStatus = () => '',
  currentTone: Tone = '',
  currentStanding = false;
let heldStatus: [() => string, Tone, boolean] | null = null;
function msg(message: string | (() => string), tone: Tone = '', standing = false) {
  heldStatus = null;
  currentStatus = typeof message === 'function' ? message : () => t(message);
  currentTone = tone;
  currentStanding = standing;
  $('status').textContent = currentStatus();
  $('status').dataset.tone = tone;
  $('status').toggleAttribute('data-standing', standing);
}
// A hint answers the last action. The status it covered returns when the traveler moves on.
function hint(message: () => string, tone: Tone = '') {
  const held = heldStatus ?? [currentStatus, currentTone, currentStanding];
  msg(message, tone);
  heldStatus = held;
}
function endHint() {
  if (heldStatus) msg(...heldStatus);
}
const fail = (message: string) => showError(message, text => msg(() => text, 'error'));
const button = (title: string, fn: () => void) => {
  const b = dom('button', title);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
const map = L.map('map', {
  zoomControl: true,
  scrollWheelZoom: true,
  trackResize: false,
  zoomSnap: .25,
  maxZoom: 19
}).setView([30, 15], 2);
// Taxi dashes sit above walking paths (400) and below stop markers (600), in either travel order.
map.createPane('taxiRoutes').style.zIndex = '410';
const overlay = L.layerGroup().addTo(map);
const rows = new Map<string, HTMLElement>(),
  marks = new Map<string, MapMarker>();
let popupFor = '';
let openPopup: MapPopup | undefined;
map.on('popupopen', event => { openPopup = event.popup; });
map.on('popupclose', event => {
  if (openPopup === event.popup) openPopup = undefined;
});
let overviewTripId = '';
let routeBounds = L.latLngBounds([]),
  fitFrame = 0;
const heading = () => {
  const dates = $('dayReel').parentElement!,
    status = $('status');
  // A short window moves a standing status below the list, where it is no part of the heading.
  if (dates.hidden && status.offsetHeight) {
    const style = getComputedStyle(status);
    if (style.order === '0') return status.offsetTop + status.offsetHeight + parseFloat(style.marginBlockEnd);
  }
  const last = dates.hidden ? $('range') : dates.parentElement!;
  return last.offsetTop + last.offsetHeight;
};
// Room under the heading for the day's summary, three ordinary stops and the day's actions, in rem as the stylesheet
// sets them. Measuring the day's own stops instead would move the dates under the finger that turns them.
const firstStopsRoom = 16;
// Must match the short window's media query in journal.css, where the whole panel scrolls in place of the list.
const shortWindow = matchMedia('(max-height: 540px)');
const sheet = createSheet($('panel'), $('sheetHandle'), map.getContainer().parentElement!, heading, () =>
  heading() + firstStopsRoom * parseFloat(getComputedStyle(document.documentElement).fontSize), from => {
  fitRoute();
  if (from === 'peek' && shortWindow.matches) keepInView();
});
new ResizeObserver(() => {
  if (!sheet.narrow || sheet.stop === 'full') return;
  sheet.refreshHeight();
  fitPopupPadding();
  if (openPopup) updatePopup(openPopup);
}).observe($('status'), { box: 'border-box' });
const mapSection = map.getContainer().parentElement!,
  mapControls = document.querySelector<HTMLElement>('.map-controls')!;
const sheetWidth = matchMedia(sheetLayout);
function placeMapStyle() {
  const menu = $('menu'), picker = $('mapStyle');
  const focused = document.activeElement === picker;
  if (sheetWidth.matches) {
    menu.insertBefore(mapControls, $('export'));
    if (focused) (menu.matches(':popover-open') ? picker : $('menuButton')).focus({ preventScroll: true });
  } else {
    if (focused && menu.matches(':popover-open')) menu.hidePopover();
    mapSection.insertBefore(mapControls, mapSection.querySelector('.legend'));
    if (focused) picker.focus({ preventScroll: true });
  }
}
placeMapStyle();
sheetWidth.addEventListener('change', () => {
  placeMapStyle();
  fitRoute();
  keepInView();
});
// The map fills the window behind the bar, the map controls and the panel. A route is fitted to what they leave clear.
function coveredEdges() {
  const box = map.getContainer().getBoundingClientRect();
  const bottomOf = (element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    return rect?.height ? rect.bottom - box.top + 6 : 0;
  };
  const top = Math.max(bottomOf(document.querySelector('header nav')), mapControls.parentElement === mapSection ? bottomOf(mapControls) : 0);
  // The legend and the map credit lie over the foot of the map. On a narrow screen they ride above the sheet.
  const above = (element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    return rect?.height ? box.bottom - rect.top + 6 : 0;
  };
  const foot = Math.max(above(document.querySelector('.legend')), above(map.getContainer().querySelector('.leaflet-control-attribution')));
  if (sheet.narrow) return { top, left: 0, right: 0, bottom: Math.max(sheet.cover, foot) };
  const panel = $('panel').getBoundingClientRect();
  if (!panel.width) return { top, left: 0, right: 0, bottom: foot };
  // The panel follows the reading direction, so it covers the left edge in English and the right edge in Hebrew.
  const onRight = panel.left - box.left > box.right - panel.right;
  const beside = (onRight ? box.right - panel.left : panel.right - box.left) + 6;
  return { top, left: onRight ? 0 : beside, right: onRight ? beside : 0, bottom: foot };
}
// Leaflet keeps the pairs a popup was bound with and reads them when it opens. Every popup shares these two,
// and a fit updates them in place, so a popup bound before a resize or a rotation keeps clear of the panel after it.
const popupOptions: PopupOptions = { autoPanPaddingTopLeft: [8, 8], autoPanPaddingBottomRight: [8, 8] };
function fitPopupPadding() {
  const container = map.getContainer(), covered = coveredEdges();
  const clearHeight = container.clientHeight - covered.top - covered.bottom;
  const compact = sheet.narrow && clearHeight < 8 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  container.toggleAttribute('data-compact-popup', compact);
  const verticalGap = compact ? 2 : 8;
  popupOptions.autoPanPaddingTopLeft.splice(0, 2, covered.left + 8, covered.top + verticalGap);
  popupOptions.autoPanPaddingBottomRight.splice(0, 2, covered.right + 8, covered.bottom + verticalGap);
  container.style.setProperty('--popup-room-width', (container.clientWidth - covered.left - covered.right - 16) + 'px');
  container.style.setProperty('--popup-room-height', (clearHeight - 2 * verticalGap) + 'px');
  return covered;
}
function updatePopup(popup: MapPopup) {
  // Leaflet rebuilds the popup content when it measures and pans it. Keep focus on the same control.
  const element = popup.getElement();
  const controls = 'a, button, select';
  const focused = Array.from(element.querySelectorAll(controls)).indexOf(document.activeElement!);
  popup.update();
  if (focused >= 0) element.querySelectorAll<HTMLElement>(controls)[focused]?.focus({ preventScroll: true });
}
function fitRoute() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const {
      clientWidth: width,
      clientHeight: height
    } = map.getContainer();
    if (!width || !height) return;
    const covered = fitPopupPadding();
    map.stop();
    map.invalidateSize({
      pan: false,
      animate: false
    });
    if (!routeBounds.isValid()) {
      map.setView([30, 15], 2, {
        animate: false
      });
    } else if (routeBounds.getSouthWest().equals(routeBounds.getNorthEast())) {
      map.setView(routeBounds.getCenter(), 15, {
        animate: false
      });
      // A single place sits in the middle of the clear part of the map.
      map.panBy([(covered.right - covered.left) / 2, (covered.bottom - covered.top) / 2], {
        animate: false
      });
    } else {
      const clear = Math.min(width - covered.left - covered.right, height - covered.top - covered.bottom);
      const margin = Math.max(18, Math.min(36, Math.round(clear * .12)));
      // On a phone turned on its side the bar and the sheet can cover more than the map has, so the padding gives way.
      const [left, right] = fitPadding(width, covered.left, covered.right, margin);
      const [top, bottom] = fitPadding(height, covered.top, covered.bottom, margin);
      map.fitBounds(routeBounds, {
        paddingTopLeft: [left, top],
        paddingBottomRight: [right, bottom],
        maxZoom: 16,
        animate: false
      });
    }
    // Opening after the fit lets the map pan just enough to show the whole popup.
    const mark = marks.get(popupFor);
    popupFor = '';
    if (mark) {
      map.closePopup();
      mark.openPopup();
    } else if (openPopup) {
      updatePopup(openPopup);
    }
  });
}
new ResizeObserver(fitRoute).observe(map.getContainer());
function points(v: string): Point | null {
  if (!v?.trim()) return null;
  const a = v.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (a.length !== 2 || !a.every(Number.isFinite) || Math.abs(a[0]) > 85 || Math.abs(a[1]) > 180) throw Error(t('המיקום צריך לכלול קו רוחב וקו אורך תקינים'));
  return [a[0], a[1]];
}
function dateRange(t: Trip) {
  const days = [];
  for (let ms = Date.parse(t.start + 'T12:00Z'); ms <= Date.parse(t.end + 'T12:00Z'); ms += 864e5) days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
}
function renderSelection() {
  selected = '';
  render();
}
const ui = (en: string, he: string) => language === 'en' ? en : he;
let streetMapProblem: StreetMapProblem = null;
function showStreetMapNote() {
  const container = map.getContainer();
  if (!streetMapProblem) delete container.dataset.note;
  else container.dataset.note = streetMapProblem === 'unsupported'
    ? ui('This browser cannot draw the street map. Pins and routes still appear.', 'הדפדפן הזה אינו יכול לצייר את מפת הרחובות. הסיכות והמסלולים עדיין מוצגים.')
    : $('mapStyle').value === 'streets'
      ? ui('The street map could not load. Pins and routes still appear.', 'מפת הרחובות לא נטענה. הסיכות והמסלולים עדיין מוצגים.')
      : ui('The map background could not load. Pins and routes still appear.', 'רקע המפה לא נטען. הסיכות והמסלולים עדיין מוצגים.');
}
const basemap = addStreetMap(map, () => language, problem => {
  streetMapProblem = problem;
  showStreetMapNote();
});
$('mapStyle').onchange = () => {
  const value = $('mapStyle').value;
  if (isBasemap(value)) basemap.select(value);
  if ($('menu').matches(':popover-open')) $('menu').hidePopover();
};
const sourceNames = {
  finances: 'Finances',
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive'
};
const outcomeText: Record<CheckStatus | 'unchecked', [string, string]> = {
  unchecked: ['Not checked for this trip', 'טרם נבדק לטיול הזה'],
  checked: ['Checked for these dates', 'נבדק לתאריכי הטיול'],
  disconnected: ['Connect this source in ChatGPT to include its stops.', 'כדי להוסיף תחנות מהמקור הזה, אפשר לחבר אותו ב־ChatGPT.'],
  no_accounts: ['Finances is connected. Link a credit card or a checking account used for debit purchases to find stops from payments.', 'Finances מחובר. כדי למצוא תחנות לפי חיובים, יש לקשר כרטיס אשראי או חשבון עו״ש המשמש לרכישות בדביט.'],
  no_transactions: ['No transactions in the accounts checked for these dates. You can still add a stop by hand or use receipts from Gmail.', 'לא נמצאו עסקאות בחשבונות שנבדקו בתאריכים האלה. עדיין אפשר להוסיף תחנה ידנית או להיעזר בקבלות מ־Gmail.'],
  no_places: ['Purchases found, but none could be placed on the map.', 'נמצאו רכישות, אך לא זוהה עבורן מקום במפה.'],
  syncing: ['Still syncing. Check again later.', 'הסנכרון עדיין מתבצע. כדאי לבדוק שוב בהמשך.'],
  failed: ['Couldn’t finish the check. Retry this source in ChatGPT.', 'הבדיקה לא הושלמה. אפשר לנסות שוב ב־ChatGPT.'],
  partial: ['Only part of the requested data was checked.', 'רק חלק מהנתונים המבוקשים נבדקו.'],
  unavailable: ['Unavailable in this session. You can still add stops manually.', 'המקור אינו זמין בשיחה הזאת. אפשר להוסיף תחנות ידנית.']
};
const types = {
  email: ['✉', '#225e9c'],
  calendar: ['▦', '#714b9a'],
  card: ['▤', '#197256'],
  transfer: ['⇄', '#197256'],
  ticket: ['◆', '#8d561b'],
  manual: ['✎', '#56616b'],
  diary: ['✎', '#56616b'],
  taxi: ['T', '#8d561b'],
  photo: ['▣', '#73506e'],
  whatsapp: ['✆', '#276a58']
};
const glyphs: Partial<Record<Source, string>> = {
  photo: '<path d="M2 6h4l2-3h4l2 3h4v11H2z"/><circle cx="10" cy="11" r="3"/>',
  email: '<rect x="2" y="4" width="16" height="12" rx="2"/><path d="m3 5 7 5 7-5"/>',
  calendar: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M6 2v4m8-4v4M3 8h14m-10 4h2m2 0h2"/>',
  card: '<rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 8h16M5 12h4"/>'
};
function pinSymbol(key: Source) {
  return glyphs[key] ? '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' + glyphs[key] + '</svg>' : types[key][0];
}
function showConnections() {
  const { trip } = session;
  const chip = $('connections');
  const rows = $('checkRows');
  // Only a signed-in journal is visible to ChatGPT. Every other journal imports the stops file it returns.
  const viaFile = portable || session.mode !== 'account';
  $('connected').querySelector('h3')!.textContent = t(viaFile ? 'ייבוא נתונים מ־ChatGPT' : 'הצלבה דרך ChatGPT');
  $('connected').querySelector('p')!.textContent = portable
    ? t('העתק את בקשת הסנכרון לשיחה שלך. אפשר לייבא כאן את קובץ התחנות שמתקבל.')
    : viaFile
      ? ui('You are not signed in, so ChatGPT cannot add stops to this trip directly. Copy the sync request into your conversation, then import the stops file it returns under Files. Sign in with ChatGPT to have stops added for you.',
        'לא נכנסת לחשבון, ולכן ChatGPT לא יכול להוסיף תחנות לטיול הזה ישירות. אפשר להעתיק את בקשת הסנכרון לשיחה ולייבא את קובץ התחנות שמתקבל בלשונית ״קבצים״. אחרי כניסה עם ChatGPT התחנות יתווספו עבורך.')
      : t('עם חיבור ״הייתי״ בשיחה, ChatGPT יכול לקרוא את המקורות שאישרת ולהוסיף את התחנות לטיול הזה. בחר אילו מקורות לכלול בבקשה. לפני שמירה, אשר רק מקומות ופרטי ביקור שברצונך להעביר ליומן.');
  const controls = [...$('connected').querySelectorAll('label.check')];
  rows.replaceChildren();
  let disconnected = 0,
    attention = 0;
  for (const key of reportSources) {
    const name = sourceNames[key];
    const item = trip?.checks?.[key];
    const status = item?.status || 'unchecked';
    if (status === 'disconnected') disconnected++;
    if (['failed', 'partial', 'no_accounts', 'unavailable', 'syncing'].includes(status)) attention++;
    const row = dom('div', undefined, 'check-row');
    row.dataset.status = status;
    const control = controls.find(label => label.querySelector('input')?.value === name);
    row.append(control || dom('strong', name), dom('span', ui(...(outcomeText[status] || outcomeText.unchecked))));
    if (!item && key === 'finances') row.append(dom('small', ui('Purchase lookup needs a linked credit card or debit account.', 'לחיפוש רכישות נדרש חשבון מקושר המשמש לרכישות באשראי או בדביט.')));
    if (item) row.append(dom('small', ui('Last checked ', 'בדיקה אחרונה ') + new Date(item.at).toLocaleString(locale())));
    rows.append(row);
  }
  const financeStatus = trip?.checks.finances?.status;
  chip.dataset.notice = disconnected || attention ? 'attention' : 'info';
  if (disconnected) {
    chip.textContent = disconnected === 1
      ? ui('1 source disconnected', 'מקור אחד מנותק')
      : ui(disconnected + ' sources disconnected', disconnected + ' מקורות מנותקים');
  } else if (financeStatus === 'no_accounts') {
    chip.textContent = ui('Link a payment account', 'חיבור חשבון לתשלומים');
  } else if (attention) {
    chip.textContent = ui('Review connections', 'בדיקת חיבורים');
  } else if (financeStatus === 'no_transactions') {
    chip.textContent = ui('No transactions for these dates', 'אין עסקאות בתאריכים האלה');
  } else if (financeStatus === 'no_places') {
    chip.textContent = ui('Purchases without a location', 'חיובים ללא מיקום');
  } else {
    chip.textContent = ui('Connections', 'חיבורים');
    delete chip.dataset.notice;
  }
  chip.hidden = !!sharedRoute || !chip.dataset.notice;
  const label = t('מקורות וייבוא');
  const sourceButton = $('import');
  sourceButton.setAttribute('aria-label', chip.hidden ? label : label + ' · ' + chip.textContent);
  sourceButton.title = chip.hidden ? '' : chip.textContent;
}
function fitTitle() {
  const title = $('title'),
    row = title.parentElement!,
    arrow = row.lastElementChild as HTMLElement,
    before = title.style.fontSize;
  title.style.fontSize = '';
  title.style.whiteSpace = 'nowrap';
  const room = row.getBoundingClientRect().width - (arrow.offsetWidth ? arrow.offsetWidth + parseFloat(getComputedStyle(row).columnGap) : 0);
  const full = parseFloat(getComputedStyle(title).fontSize);
  const tooWide = () => title.getBoundingClientRect().width > room;
  // The system font spaces its letters differently at each size, so the width is measured at every step.
  for (let size = full - .5; tooWide() && size >= full * .75; size -= .5) title.style.fontSize = size + 'px';
  if (tooWide()) title.style.fontSize = '';
  title.style.whiteSpace = '';
  return title.style.fontSize !== before;
}
new ResizeObserver(() => {
  if (fitTitle()) sheet.relabel();
}).observe($('title').parentElement!);
let shownTripId = '';
function render() {
  const { trip, day } = session;
  if (trip?.id !== overviewTripId) overviewTripId = '';
  showConnections();
  $('range').textContent = trip ? rangeDate(trip.start) + t(' עד ') + rangeDate(trip.end) + (trip.home ? t(' · יציאה מ') : '') : t('אפשר להתחיל מטיול חדש או לייבא טיול קיים.');
  // The traveler's own words keep their direction beside a label in the other one.
  if (trip?.home) $('range').append(dom('bdi', trip.home));
  const copiesByTitle = new Map<string, number>();
  $('trips').replaceChildren(...session.trips.map(item => {
    const title = displayTripTitle(item.title);
    if (!session.recoveredTripIds?.has(item.id)) return new Option(title, item.id);
    const copy = (copiesByTitle.get(title) ?? 0) + 1;
    copiesByTitle.set(title, copy);
    const label = ui('Recovered copy', 'עותק משוחזר');
    return new Option(title + ' (' + label + (copy > 1 ? ' ' + copy : '') + ')', item.id);
  }));
  if (trip) $('trips').value = trip.id;
  $('title').textContent = $('trips').selectedOptions[0]?.text ?? t('הטיולים שלי');
  $('trips').hidden = session.trips.length < 2;
  fitTitle();
  for (const id of ['add', 'export', 'settings', 'organize'] as const) $(id).disabled = !trip;
  const days = trip ? dateRange(trip) : [];
  setDates(days, day, days.map(date => {
    const count = trip?.stops.filter(stop => stop.date === date && stop.kind !== 'origin' && isMappedStop(stop)).length ?? 0;
    const details = dayDetails(trip, date).length;
    return [count ? stopCount(count) : '', details ? quantity(details, details === 1 ? ' רשומה' : ' רשומות', 'entry', 'entries') : ''].filter(Boolean).join(' · ');
  }), days.map(date => {
    // A saved place or a note is something recorded for the day, though neither is a stop on its route.
    const pins = trip?.googlePins?.filter(pin => pin.date === date).length ?? 0;
    return [pins ? quantity(pins, ' סיכות Google', 'Google Pin', 'Google Pins') : '', trip?.dayNotes?.[date] ? ui('Note', 'הערה') : ''].filter(Boolean).join(' · ');
  }));
  document.body.classList.toggle('no-trip', !trip);
  $('welcome').hidden = !!trip || !!sharedRoute || !journalReady || session.mode === 'portable-recovery';
  draw();
  if ((trip?.id ?? '') !== shownTripId) {
    shownTripId = trip?.id ?? '';
    document.querySelector<HTMLElement>('.listbody')!.scrollTop = 0;
    $('panel').scrollTop = 0;
  }
}
const stopCount = (count: number) => count === 1 ? t('תחנה אחת') : count + t(' תחנות');
const { setDates, showWholeTrip } = createDateReel($('dayReel'), $('tripDate'), $('dayProgress'), dateLabel, next => {
  if (next === session.day && !overviewTripId) return;
  overviewTripId = '';
  session.select(session.trip, next);
  selected = '';
  endHint();
  draw();
  // Not startList(): scrolling the panel would move the reel under the finger.
  document.querySelector<HTMLElement>('.listbody')!.scrollTop = 0;
});
function distanceLabel(meters: number) {
  return meters < 1000 ? Math.max(1, Math.round(meters / 10) * 10) + t(' מ׳') : dateFormats[language].distance.format(meters / 1000) + t(' ק״מ');
}
function showDailyStats(stats: ReturnType<typeof walkingStats>) {
  const { trip } = session;
  const stopLabel = stopCount(stats.stopCount);
  $('count').textContent = stopLabel;
  $('dayStats').hidden = !trip;
  if (!trip) return;
  const meters = stats.estimatedWalkingMeters;
  const excluded = stats.unknownLegs;
  $('statStops').textContent = stopLabel;
  const onlyRide = meters === null && stats.taxiLegs > 0 && !excluded;
  $('walkSummary').textContent = meters !== null ? t('כ־') + distanceLabel(meters) + t(' הליכה') + (excluded ? t(' · אומדן חלקי') : language === 'he' ? ' משוערת' : '') : onlyRide ? t('אין מקטע הליכה מתועד') : t('אין מספיק מידע לאומדן הליכה');
  const minutesAt = (kph: number) => Math.max(1, Math.round((meters ?? 0) * 60 / (1000 * kph)));
  const low = minutesAt(4),
    high = minutesAt(3);
  $('walkTime').textContent = meters === null ? '' : t('כ־') + (low === high ? low : low + '–' + high) + t(' דק׳ הליכה בקצב של 3–4 קמ״ש.');
  const coverage = [];
  if (stats.walkingLegs) coverage.push(stats.walkingLegs === 1 ? t('מקטע הליכה אחד באומדן') : stats.walkingLegs + t(' מקטעי הליכה באומדן'));
  if (stats.taxiLegs) coverage.push(stats.taxiLegs === 1 ? t('נסיעה אחת במונית') : stats.taxiLegs + t(' נסיעות במונית'));
  if (excluded) coverage.push(excluded === 1 ? t('מקטע אחד הושמט בגלל מידע חסר על ההליכה') : excluded + t(' מקטעים הושמטו בגלל מידע חסר על ההליכה'));
  $('walkCoverage').textContent = coverage.join(' · ') || t('נדרשים לפחות שני מקומות ומקטע הליכה ביניהם כדי לחשב מרחק.');
  const leg = stats.longest;
  $('longestWalk').textContent = stats.walkingLegs > 1 && leg ? t('מקטע ההליכה הארוך במסלול המשוער הוא מ') + displayStopName(leg.from) + t(' ל') + displayStopName(leg.to) + t(', כ־') + distanceLabel(leg.meters) + '.' : '';
}
function startList() {
  const list = document.querySelector<HTMLElement>('.listbody')!;
  if (getComputedStyle(list).overflowY !== 'visible') list.scrollTop = 0;
  else $('panel').scrollTop = Math.max(0, $('dayReel').closest<HTMLElement>('.daybar')!.offsetTop - $('sheetHandle').offsetHeight);
}
function openMapDay(date: string) {
  overviewTripId = '';
  session.select(session.trip, date);
  renderSelection();
  startList();
  viewList(false);
}

$('wholeTrip').onclick = () => {
  if (!session.trip) return;
  overviewTripId = overviewTripId ? '' : session.trip.id;
  endHint();
  renderSelection();
  startList();
};
const displayStopName = (name: string) => name === unidentifiedMerchant ? ui('Purchase', 'קנייה') : name;
function appendStopRow(s: Stop, i: number, list: Stop[], number: string) {
  const name = displayStopName(s.name);
  const li = dom('li', undefined, 'stop');
  li.classList.toggle('activeStop', selected === s.id);
  rows.set(s.id, li);
  const locate = button(number, () => reveal(s.id, 'pin'));
  locate.className = 'num';
  locate.setAttribute('aria-label', ui('Show on map: ', 'הצגה במפה: ') + name);
  li.append(locate);
  const col = dom('div');
  const open = sharedRoute ? dom('strong', name) : button(name, () => {
    if (s.id === 'base') {
      openSettings(false);
      return;
    }
    openStop(s);
  });
  open.className = 'stopname';
  col.append(open);
  const hints = [s.time, s.address, s.band, s.approx ? t('מיקום משוער') : ''].filter(Boolean);
  col.append(dom('div', hints.join(' · '), 'meta'));
  const evidence = [...(s.sources || []).map(k => t(label[k])), s.count ? quantity(s.count, ' חיובים', 'charge', 'charges') : '', s.photos?.length ? quantity(s.photos.length, ' תמונות', 'photo', 'photos') : ''].filter(Boolean).join(' · ');
  if (evidence) col.append(dom('span', evidence, 'src'));
  if (s.notes) col.append(dom('div', s.notes, 'meta'));
  const actions = dom('div', undefined, 'tools');
  if (s.kind !== 'origin') {
    for (const [sign, delta] of [['↑', -1], ['↓', 1]] as const) {
      const b = button(sign, () => void move(s, delta));
      b.setAttribute('aria-label', delta < 0 ? t('הקדמת ') + name : t('דחיית ') + name);
      b.disabled = !list[i + delta] || list[i + delta].kind === 'origin';
      actions.append(b);
    }
  }
  li.append(col, actions);
  $('stops').append(li);
}
// On the whole-trip map every day has its own color, so pins that share a number can be told apart.
const dayColors = 7;
// Routes are drawn in the stylesheet's colors, so a line on the map matches its pins and the legend.
const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function addStopMarker(s: Stop, xy: Point, number: string, tone: number | null) {
  const overview = tone !== null;
  const name = displayStopName(s.name);
  const keys = (s.sources || []).filter(k => Object.hasOwn(types, k));
  const primary = keys[0];
  const badge = s.kind !== 'origin' && primary ? '<span class="pin-source" style="background:' + types[primary][1] + '">' + pinSymbol(primary) + '</span>' : '';
  const description = [name, ...(overview ? [dateLabel(s.date)] : []), ...keys.map(k => k === 'card' ? ui('Transaction', 'עסקה') : t(label[k]))].join(' · ');
  const icon = L.divIcon({
    className: 'pin ' + (s.kind === 'origin' ? 'home ' : overview ? 'day-' + tone + ' ' : '') + (s.approx ? 'soft' : ''),
    html: s.kind === 'origin' ? '⌂' : number + badge,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
  const mark = L.marker(xy, {
    icon,
    title: description,
    alt: description
  }).addTo(overlay);
  mark.bindPopup(() => {
    const content = dom('div', undefined, 'stop-popup'), details = dom('div');
    details.append(dom('strong', name), dom('div', [s.time, s.address].filter(Boolean).join(' · ')));
    if (keys.length) details.append(dom('div', keys.map(k => types[k][0] + ' ' + (k === 'card' ? ui('Transaction', 'עסקה') : t(label[k]))).join(' · '), 'popup-sources'));
    content.append(details);
    if (overview) content.append(button(dateLabel(s.date), () => openMapDay(s.date)));
    else if (!sharedRoute) content.append(button(ui('Edit details', 'עריכת הפרטים'), () => {
      map.closePopup();
      if (s.id === 'base') openSettings(false);
      else openStop(s);
    }));
    return content;
  }, popupOptions);
  if (!overview) {
    mark.on('click', () => reveal(s.id, 'row'));
    marks.set(s.id, mark);
  }
}

function drawLeg(previous: Point, stop: Point, edge: Edge | undefined, locate: (p: Point) => Point, color: string) {
  if (edge?.type !== 'same') {
    const line = (edge?.line?.length ? edge.line : [previous, stop]).map(locate);
    const taxi = edge?.type === 'taxi';
    L.polyline(line, {
      pane: taxi ? 'taxiRoutes' : 'overlayPane',
      color: taxi ? themeColor('--clay') : color,
      weight: edge?.type === 'walk' ? 5 : 3,
      dashArray: taxi ? '9 9' : edge?.type === 'walk' ? null : '5 7',
      opacity: taxi ? 1 : .85
    }).addTo(overlay);
    routeBounds.extend(line);
  }
}
/** `tone` is the day's color on the whole-trip map, and null when a single day is shown. */
function drawRouteDay(list: Stop[], edges: Map<string, Edge>, locate: (p: Point) => Point, tone: number | null, showBase: boolean) {
  const color = themeColor(tone === null ? '--leaf' : '--day-' + tone);
  for (const [i, stop] of list.entries()) {
    const number = stop.kind === 'origin' ? '⌂' : String(i + (list[0]?.kind === 'origin' ? 0 : 1));
    if (tone === null) appendStopRow(stop, i, list, number);
    if (!stop.xy) continue;
    const xy = locate(stop.xy);
    routeBounds.extend(xy);
    if (stop.id !== 'base' || showBase) addStopMarker(stop, xy, number, tone);
    const previous = list[i - 1];
    if (previous?.xy) drawLeg(previous.xy, stop.xy, edges.get(previous.id + '|' + stop.id), locate, color);
  }
}
function appendOverviewDay(date: string, stops: number, googlePins: number, tone: number) {
  const entry = button(dateLabel(date), () => openMapDay(date));
  entry.className = 'overview-day day-' + tone;
  entry.dataset.day = date;
  const counts = [];
  if (stops) counts.push(stopCount(stops));
  if (googlePins) counts.push(quantity(googlePins, ' סיכות Google', 'Google Pin', 'Google Pins'));
  if (counts.length) entry.append(dom('small', counts.join(' · ')));
  const row = dom('li');
  row.append(entry);
  $('stops').append(row);
}

function draw() {
  const { trip, day } = session;
  const overview = !!trip && overviewTripId === trip.id;
  const edges = indexEdges(trip);
  const details = !overview && !sharedRoute && trip ? dayDetails(trip, day) : [];
  const pins = (trip?.googlePins ?? []).filter(pin => overview || pin.date === day);
  const pinsPerDay = new Map<string, number>();
  for (const pin of pins) if (pin.date) pinsPerDay.set(pin.date, (pinsPerDay.get(pin.date) ?? 0) + 1);

  const days = overview
    ? [...new Set([...trip.stops.filter(isMappedStop).map(stop => stop.date), ...pinsPerDay.keys()])].sort()
    : [day];
  const routes = days.map(date => {
    const stops = routeStops(trip, date, t('נקודת מוצא'));
    // A saved-place-only day has no journey back to the default home base.
    return { date, stops: overview && stops.length === 1 && stops[0].id === 'base' ? [] : stops };
  });
  const visiblePoints = pins.map(pin => pin.xy);
  for (const { stops } of routes) {
    for (const [i, stop] of stops.entries()) {
      if (!stop.xy) continue;
      visiblePoints.push(stop.xy);
      const previous = stops[i - 1];
      const edge = previous?.xy && edges.get(previous.id + '|' + stop.id);
      if (edge) for (const xy of edge.line) visiblePoints.push(xy);
    }
  }
  // Empty days keep the rest of the trip in view.
  if (!visiblePoints.length && trip) {
    for (const stop of trip.stops) if (isMappedStop(stop) && stop.xy) visiblePoints.push(stop.xy);
    if (trip.homeXY) visiblePoints.push(trip.homeXY);
  }
  const locate = projectMapPoints(visiblePoints);
  $('stops').replaceChildren();
  overlay.clearLayers();
  routeBounds = L.latLngBounds([]);
  rows.clear();
  marks.clear();
  popupFor = '';
  document.body.classList.toggle('trip-overview', overview);
  $('wholeTrip').hidden = !trip;
  $('wholeTrip').setAttribute('aria-pressed', String(overview));
  $('wholeTrip').textContent = overview ? ui('Back to the day', 'חזרה ליום') : ui('Whole trip', 'כל הטיול');
  showWholeTrip(overview ? ui('Whole trip', 'כל הטיול') : '');
  $('listTitle').textContent = overview ? ui('Trip days', 'ימי הטיול') : t('תחנות בדרך');
  if (overview) {
    $('dayStats').hidden = true;
    $('count').textContent = '';
  }
  let baseDrawn = false;
  const tripDays = overview ? dateRange(trip) : [];
  for (const { date, stops } of routes) {
    // A day keeps its color wherever it falls in the trip, including after other days gain or lose stops.
    const tone = overview ? Math.max(0, tripDays.indexOf(date)) % dayColors : null;
    if (tone !== null) {
      appendOverviewDay(date, stops.filter(stop => stop.kind !== 'origin').length, pinsPerDay.get(date) ?? 0, tone);
    } else {
      showDailyStats(walkingStats(stops, edges));
    }
    drawRouteDay(stops, edges, locate, tone, !baseDrawn);
    if (stops.some(stop => stop.id === 'base' && stop.xy)) baseDrawn = true;
  }

  if (trip) {
    const saved = (pin: GooglePin) => {
      if (session.trip !== trip || !trip.googlePins?.includes(pin)) {
        throw Error(ui('This trip changed. Open the Google Pin again.', 'הטיול השתנה. יש לפתוח שוב את סיכת Google.'));
      }
    };
    const actions: PinActions | undefined = sharedRoute ? undefined : {
      assignDay(pin, date) {
        void change(() => {
          saved(pin);
          assignGooglePinDay(pin, date);
        });
      },
      async remove(pin) {
        if (!await ask(ui('Remove this Google Pin from the trip? Future imports will keep it removed.', 'להסיר את סיכת Google מהטיול? גם ייבוא חוזר לא יחזיר אותה.'), ui('Remove pin', 'הסרת הסיכה'))) return;
        void change(() => {
          saved(pin);
          removeGooglePin(trip, pin.id);
        });
      }
    };
    for (const xy of drawGooglePins(trip, overview ? null : day, overlay, actions, locate, popupOptions)) routeBounds.extend(xy);
  }
  if (!routeBounds.isValid()) for (const xy of visiblePoints) routeBounds.extend(locate(xy));
  fitRoute();
  if (!$('stops').childElementCount && $('welcome').hidden) {
    const empty = overview ? ui('No days with stops yet.', 'עדיין אין ימים עם תחנות.') :
      details.length ? ui('No stops with a map pin for this day.', 'אין תחנות עם סיכה ביום הזה.') :
      pins.length ? ui('No route stops for this day.', 'אין תחנות במסלול של היום הזה.') :
      trip ? t('עדיין אין תחנות ליום הזה.') : t('כאן יופיעו תחנות הטיול לפי יום.');
    $('stops').append(dom('li', empty, 'empty'));
  }
  $('dayNote').textContent = overview ? '' : trip?.dayNotes?.[day] || '';
  $('dayNote').hidden = !$('dayNote').textContent;
  renderDayDetails(details);
  // Measure the new heading, stops and actions together before the scheduled map fit.
  sheet.relabel();
}

function reviewExplanation(stop: Stop) {
  if (stop.reviewReason) return stop.reviewReason;
  if (stop.sources.length === 1 && stop.sources[0] === 'card') {
    return ui('Charge recorded, in-person purchase unconfirmed', 'קיים חיוב, אך הרכישה במקום לא אושרה');
  }
  if (!stop.address && !stop.xy) {
    if (stop.sources.includes('calendar')) return ui('No location was recorded for this calendar event.', 'לא תועד מיקום לאירוע שבלוח השנה.');
    return ui('No location was recorded.', 'מיקום הביקור לא תועד.');
  }
  return ui('This entry was flagged for review without a recorded reason.', 'הרשומה סומנה לבירור בלי פירוט הסיבה.');
}

function missingLocationReason(stop: Stop) {
  if (stop.address) return ui('Address has no map pin', 'הכתובת טרם סומנה במפה');
  if (stop.sources.includes('card')) return ui('Purchase location missing', 'חסר מיקום לסיכה');
  return ui('Visit address missing', 'כתובת הביקור חסרה');
}
function dayDetailRow(stop: Stop) {
  const remote = stop.kind === 'remote';
  const unlocated = !remote && stop.kind !== 'uncertain';
  const label = displayStopName(stop.name);
  // Older remote entries sometimes include a secondary note after a spaced bullet.
  const parts = remote ? label.split(/\s+[·•]\s+/u) : [label];
  const reason = remote ? parts.slice(1).join(' · ') || ui('No visit recorded', 'לא תועד ביקור במקום')
    : unlocated ? missingLocationReason(stop) : reviewExplanation(stop);
  const item = dom('li', undefined, 'detail-row');
  const content = dom('div', undefined, 'detail-info');
  content.append(dom('bdi', parts[0], 'detail-name'));
  if (stop.time) content.append(dom('bdi', stop.time, 'detail-time'));
  content.append(dom('bdi', reason, 'detail-reason'));
  const actionLabel = unlocated
    ? stop.address ? ui('Locate address', 'איתור הכתובת') : ui('Add address', 'הוספת כתובת')
    : ui('Edit details', 'עריכת פרטים');
  const action = button(actionLabel, () => {
    openStop(stop);
    if (unlocated && stop.address) $('findPlace').click();
    else if (unlocated) ef.address.focus();
  });
  action.className = 'detail-action';
  action.setAttribute('aria-label', actionLabel + ' · ' + parts[0]);
  item.append(content, action);
  return item;
}
function renderDayDetails(entries: Stop[]) {
  const unlocated = entries.filter(s => s.kind !== 'uncertain' && s.kind !== 'remote');
  const pending = entries.filter(s => s.kind === 'uncertain');
  const remote = entries.filter(s => s.kind === 'remote');
  const groups = [
    [unlocated, $('unlocatedEntries'), $('unlocatedHeading'), $('unlocatedList'), ui('Places without a pin', 'מקומות ללא סיכה')],
    [pending, $('reviewEntries'), $('reviewHeading'), $('reviewList'), ui('Visits to confirm', 'ביקורים לבירור')],
    [remote, $('remoteEntries'), $('remoteHeading'), $('otherList'), ui('Remote activity', 'פעילות מרחוק')]
  ] as const;
  for (const [records, section, heading, list, label] of groups) {
    section.hidden = !records.length;
    heading.textContent = label + ' (' + records.length + ')';
    list.replaceChildren(...records.map(dayDetailRow));
  }
  const details = $('other');
  const currentDay = JSON.stringify([session.trip?.id, session.day]);
  if (details.dataset.day !== currentDay) {
    details.dataset.day = currentDay;
    delete details.dataset.choice;
  }
  if (!details.dataset.choice) {
    const mappedVisits = session.trip?.stops.some(stop => stop.date === session.day && stop.kind !== 'origin' && isMappedStop(stop));
    details.open = !!entries.length && !mappedVisits;
  }
  details.hidden = !entries.length;
  const title = t('מידע נוסף לאותו יום') + ' (' + entries.length + ')';
  $('otherSummary').textContent = title;
  $('reviewDay').hidden = !entries.length;
  $('reviewDay').textContent = title;
}
$('otherSummary').onclick = () => {
  const details = $('other');
  details.dataset.choice = details.open ? 'closed' : 'open';
};
$('reviewDay').onclick = () => {
  viewList(true);
  $('other').dataset.choice = 'open';
  $('other').open = true;
  $('otherSummary').focus();
};
function showRow(id: string) {
  // Only the list scrolls, and the panel around it stays where it is. On a screen with little height
  // the whole panel scrolls instead, and the day's actions at its foot lie over the last of it.
  const row = rows.get(id),
    list = row?.closest<HTMLElement>('.listbody');
  if (!row || !list) return;
  const ownScroll = getComputedStyle(list).overflowY !== 'visible';
  const scroller = ownScroll ? list : $('panel');
  const foot = document.querySelector<HTMLElement>('.toolbar');
  const shown = scroller.getBoundingClientRect(),
    box = row.getBoundingClientRect();
  const top = ownScroll ? shown.top : shown.top + $('sheetHandle').offsetHeight;
  const bottom = ownScroll || !foot?.offsetHeight ? shown.bottom : foot.getBoundingClientRect().top;
  // If a long note cannot fit, show the stop's name and controls at the top of its row.
  if (box.top < top || box.height > bottom - top) scroller.scrollTop += box.top - top;
  else if (box.bottom > bottom) scroller.scrollTop += box.bottom - bottom;
}
function keepInView() {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== $('sheetHandle') && $('panel').contains(focused) && focused.getClientRects().length) {
    focused.scrollIntoView({ block: 'nearest' });
  } else {
    showRow(selected);
  }
}
shortWindow.addEventListener('change', keepInView);
function reveal(id: string, target: 'row' | 'pin') {
  selected = id;
  for (const [key, row] of rows) row.classList.toggle('activeStop', key === id);
  if (target === 'row') {
    showRow(selected);
    return;
  }
  // On a phone a full sheet covers the map, which is fitted again as the sheet lowers.
  popupFor = id;
  map.closePopup();
  viewList(false);
}
// Temporary memory edits need a backup before leaving this document.
const tabOnly = () => session.mode === 'memory' || (session.mode === 'guest' && session.guestPersistence === 'memory');
const isolatedGuest = () => session.mode === 'guest' && session.guestPersistence !== 'shared';
let earlierGuestDraft: 'local' | 'tab' | undefined;
const saveTone = (): Tone => isolatedGuest() || (tabOnly() && session.trips.length) ? 'warning' : '';
function noTimeCopy() {
  if (isolatedGuest()) {
    const temporary = session.guestPersistence === 'tab'
      ? ui('Temporary trips are saved only in this tab. Back them up or sign in to keep them.',
        'טיולים זמניים נשמרים רק בלשונית הזאת. גבו אותם או היכנסו לחשבון כדי לשמור אותם.')
      : ui('Temporary trips are only in memory. Back them up before reloading, closing this tab or signing in.',
        'טיולים זמניים נשמרים רק בזיכרון. גבו אותם לפני רענון, סגירת הלשונית או כניסה לחשבון.');
    if (earlierGuestDraft === 'tab') {
      const recovery = session.guestPersistence === 'tab' && session.trips.length
        ? ui('Allow site storage, back up and delete the temporary trips here, then reload this tab to open the earlier draft.',
          'אפשרו לאתר לשמור נתונים, גבו את הטיולים הזמניים ומחקו אותם. לאחר מכן רעננו את הלשונית כדי לפתוח את הטיוטה הקודמת.')
        : ui('Allow site storage and reload this tab to open the earlier draft.',
          'אפשרו לאתר לשמור נתונים ורעננו את הלשונית כדי לפתוח את הטיוטה הקודמת.');
      return ui('An earlier draft is still saved in this tab.', 'טיוטה קודמת עדיין שמורה בלשונית הזאת.') + ' ' + temporary + ' ' + recovery;
    }
    const notice = earlierGuestDraft === 'local'
      ? ui('An earlier draft is still saved in this browser.', 'טיוטה קודמת עדיין שמורה בדפדפן הזה.')
      : ui('This tab can’t access the browser’s saved journal.', 'אין ללשונית הזאת גישה ליומן השמור בדפדפן.');
    return notice + ' ' + ui('Allow site storage and open Hayiti in a new tab to check for saved trips.',
      'אפשרו לאתר לשמור נתונים ופתחו את Hayiti בלשונית חדשה כדי לראות אילו טיולים שמורים.') + ' ' + temporary;
  }
  return t(portable ? session.mode === 'portable' ? 'נשמר בדפדפן הזה.' : 'השינויים בזיכרון הלשונית. לשמירה יש להוריד גיבוי.' : session.mode === 'account' ? 'השינויים נשמרו ביומן האישי.' : 'נשמר במכשיר הזה');
}
let viewRequest = 0,
  loadedHosted = false;
async function loadHostedRoute() {
  const epoch = ++viewRequest;
  if (!loadedHosted) msg(() => ui('Loading the shared route…', 'טוען את המסלול המשותף…'));
  const res = await fetch('/api/route-links', {
    method: loadedHosted ? 'HEAD' : 'GET',
    cache: 'no-store',
    headers: {
      'X-Hayiti-View': location.hash.slice(7)
    },
    referrerPolicy: 'no-referrer'
  });
  if (epoch !== viewRequest) return;
  if (!res.ok) {
    // Only a revoked link removes a route that is already on screen. Other failures are retried on the next check.
    if (loadedHosted && res.status !== 404) return;
    session.showSnapshot(null);
    loadedHosted = false;
    document.body.classList.remove('route-ready');
    renderSelection();
    map.closePopup();
    $('routeGone').hidden = res.status !== 404;
    msg(res.status === 404 ? 'הקישור בוטל או אינו זמין.' : 'לא ניתן לטעון את המסלול כרגע.', 'error');
    return;
  }
  if (loadedHosted) return;
  $('routeGone').hidden = true;
  const snapshot = cleanTrip(await res.json());
  if (epoch !== viewRequest) return;
  session.showSnapshot(snapshot);
  loadedHosted = true;
  document.body.classList.add('route-ready');
  msg('מסלול משותף · לצפייה בלבד', '', true);
  renderSelection();
}
if (hostedView) {
  const check = () => {
    if (!document.hidden) loadHostedRoute().catch(() => {
      if (!loadedHosted) msg('לא ניתן לטעון את המסלול כרגע.', 'error');
    });
  };
  setInterval(check, 15000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', e => {
    if (e.persisted) check();
  });
}
window.addEventListener('hashchange', () => {
  if (hostedView || location.hash.startsWith('#route=')) location.reload();
});
let journalReady = false;
// A draft kept in the browser can outlive the person who made it. It joins an account without a question only
// when the traveler chose Sign in from the tab showing it. Anyone else is shown the trips and asked.
const mergeAnswers = new Map<string, boolean>();
async function approveGuestMerge(draft: Trip[]) {
  if (guestMergeRequested(draft)) return true;
  // The answer covers the trips that were shown. A draft another tab changes afterwards is asked about again.
  const shown = JSON.stringify(draft);
  const answered = mergeAnswers.get(shown);
  if (answered !== undefined) return answered;
  const titles = draft.map(trip => '• ' + displayTripTitle(trip.title)).join('\n');
  const answer = await ask(ui(
    (draft.length === 1 ? 'This browser has a trip made before signing in:' : 'This browser has trips made before signing in:') + '\n' + titles
      + '\n\n' + (draft.length === 1 ? 'Add it to your journal?' : 'Add them to your journal?') + ' If you did not make ' + (draft.length === 1 ? 'it' : 'them') + ', choose Cancel.',
    (draft.length === 1 ? 'בדפדפן הזה שמור טיול שנוצר לפני הכניסה:' : 'בדפדפן הזה שמורים טיולים שנוצרו לפני הכניסה:') + '\n' + titles
      + '\n\n' + (draft.length === 1 ? 'להוסיף אותו ליומן שלך? אם לא יצרת אותו, בחרו בביטול.' : 'להוסיף אותם ליומן שלך? אם לא יצרת אותם, בחרו בביטול.')
  ), ui('Add to my journal', 'הוספה ליומן שלי'));
  mergeAnswers.set(shown, answer);
  return answer;
}
// A quiet load is the automatic check when the traveler returns to the tab. It redraws only when the journal changed.
async function load(afterConflict = false, quiet = false) {
  if (hostedView) return loadHostedRoute();
  if (embeddedRoute) {
    session.showSnapshot(cleanTrip(JSON.parse(embeddedRoute.textContent ?? 'null')));
    document.body.classList.add('route-copy');
    msg('עותק של המסלול לצפייה', '', true);
    renderSelection();
    return;
  }

  const revision = session.revision;
  const result = await session.load(portable, title => {
    const suffix = ui(' (before sign-in)', ' (לפני הכניסה)');
    return displayTripTitle(title).slice(0, 100 - suffix.length) + suffix;
  }, approveGuestMerge, afterConflict);
  if (result.kind === 'unchanged') return;
  if (quiet && (result.kind === 'account' || result.kind === 'draft-left-out') && session.revision === revision) return result.kind;
  // The request to keep a draft ends once it is in the account, or once sign-in was abandoned.
  if (result.kind === 'merged' || result.kind === 'account' || result.kind === 'guest') requestGuestMerge(false);
  const unreadable = result.kind === 'unreadable-draft';
  const unavailable = result.kind === 'guest-unavailable';
  const waitingInTab = !portable && !unreadable && !unavailable && hasLegacyGuestTrips('tab');
  if (isolatedGuest()) earlierGuestDraft = waitingInTab ? 'tab' : hasLegacyGuestTrips('local') ? 'local' : undefined;
  journalReady = !unreadable && !unavailable;
  $('retryLoad').hidden = !unavailable && result.kind !== 'portable-missing';
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-requires-journal]')) control.disabled = unreadable || unavailable;
  if (unreadable) tab('connected');
  $('range').hidden = unreadable || unavailable;
  $('discardDraft').hidden = !unreadable;
  $('login').hidden = result.kind !== 'guest' && result.kind !== 'signed-out' && !unavailable;
  $('logout').hidden = session.mode !== 'account';
  renderSelection();
  switch (result.kind) {
    case 'guest-unavailable':
      msg(() => ui('This browser could not read the saved draft. Your saved data has not been changed. Choose Try again. ',
        'לא ניתן לקרוא את הטיוטה השמורה בדפדפן הזה. הנתונים השמורים לא שונו. בחרו בניסיון נוסף. ') + result.reason, 'error');
      break;
    case 'draft-unavailable':
      msg(() => ui('Your account journal is open, but the draft in this browser could not be read. It has not been merged. ',
        'היומן בחשבון פתוח, אך לא ניתן לקרוא את הטיוטה בדפדפן הזה. היא לא מוזגה. ') + result.reason, 'warning');
      break;
    case 'unreadable-draft':
      msg(() => t(result.reason) + ui(' Choose Discard unreadable draft to continue.',
        ' כדי להמשיך, בחרו ב״מחיקת טיוטה שלא ניתן לקרוא״.'));
      break;
    case 'portable-missing':
      msg(() => session.trips.length
        ? ui('The saved portable journal is missing. Back up the trips still open in this tab. Saving a trip will restore the journal.',
          'היומן השמור בדפדפן חסר. גבו את הטיולים שעדיין פתוחים בלשונית הזאת. שמירת טיול תשחזר את היומן.')
        : ui('The saved portable journal is missing. Import a trip backup through Sources, or choose New trip to start again.',
          'היומן השמור בדפדפן חסר. אפשר לייבא גיבוי דרך ״מקורות״ או לבחור ב״טיול חדש״ כדי להתחיל מחדש.'), 'warning');
      break;
    case 'portable':
      msg(session.mode === 'portable' ? 'עותק אישי בדפדפן הזה' : 'אפשר ליצור טיול. לשמירה בדפדפן זה יש להוריד גיבוי.', saveTone(), true);
      break;
    case 'signed-out':
      if (isolatedGuest()) msg(noTimeCopy, saveTone(), true);
      else msg(() => ui('You are signed out. Sign in with ChatGPT to open your journal.', 'יצאת מהחשבון. כדי לפתוח את היומן נכנסים שוב עם ChatGPT.'));
      break;
    case 'guest':
      msg(session.trips.length || session.guestPersistence !== 'shared' ? noTimeCopy : 'אפשר להתנסות כאן. לשמירה בין מכשירים נכנסים עם ChatGPT.', saveTone(), true);
      break;
    case 'account':
      msg('היומן האישי מעודכן.', '', true);
      break;
    case 'draft-left-out':
      msg(() => ui('The trips made in this browser before signing in were left out of your journal. Reload the page to be asked again.',
        'הטיולים שנוצרו בדפדפן הזה לפני הכניסה לא נוספו ליומן שלך. כדי להישאל שוב, טענו מחדש את הדף.'));
      break;
    case 'merge-conflict':
      msg(() => ui('Your journal changed during sign-in. Your trips are still in this browser. Choose Refresh journal to add them.',
        'היומן השתנה במהלך הכניסה. הטיולים עדיין שמורים בדפדפן הזה. כדי להוסיף אותם, בחרו ברענון היומן.'));
      break;
    case 'merge-not-sent':
      msg(() => ui('This tab couldn’t prepare the save. No trips were sent this time. Use Back up trip for each trip, then import the backups in a new tab.',
        'הלשונית לא הצליחה להכין את הטיולים לשמירה. הפעם לא נשלחו טיולים. גבו כל טיול בנפרד וייבאו את הגיבויים בלשונית חדשה.'));
      break;
    case 'unconfirmed':
      msg(() => ui('We couldn’t confirm the save. Your trips are still in this browser. Choose Refresh journal to check.',
        'לא התקבל אישור שמירה. הטיולים עדיין שמורים בדפדפן הזה. לבדיקה, בחרו ברענון היומן.'));
      break;
    case 'refused':
      msg(() => {
        const reason = t(result.reason).replace(/\.$/, '');
        return ui('Signed in, but your journal could not take the trips from this browser (' + reason + '). Back them up or delete them here, then choose Refresh journal to open your journal.',
          'הכניסה הצליחה, אבל היומן לא קיבל את הטיולים מהדפדפן הזה (' + reason + '). אפשר לגבות או למחוק אותם כאן, ואז לבחור ברענון היומן כדי לפתוח את היומן.');
      });
      break;
    case 'merged':
      msg(() => result.copies
        ? ui('Your changes from before signing in were kept as a separate copy of the trip.', 'השינויים שנעשו לפני הכניסה נשמרו כעותק נפרד של הטיול.')
        : result.trips === 1
          ? ui('The trip you started before signing in is now in your journal.', 'הטיול שהתחלת לפני הכניסה נוסף ליומן האישי.')
          : ui('The trips you started before signing in are now in your journal.', 'הטיולים שהתחלת לפני הכניסה נוספו ליומן האישי.'));
  }
  if (waitingInTab && !isolatedGuest()) {
    msg(() => ui('This tab still has trips from an earlier version waiting to be imported. Keep it open and choose Refresh journal to finish importing them.',
      'בלשונית הזאת עדיין יש טיולים מגרסה קודמת שממתינים לייבוא. השאירו אותה פתוחה ובחרו ברענון היומן כדי להשלים את הייבוא.'), 'warning');
  }
  return result.kind;
}

// The trip and journal version an open form was filled from. A refresh can replace or reselect the trip
// behind the form, and saving must never land on a different trip than the one shown.
let formTrip = { id: '', revision: '' };
function bindForm() {
  formTrip = { id: session.trip?.id ?? '', revision: session.revision };
}
function requireFormTrip() {
  if (session.trip?.id !== formTrip.id) {
    throw Error(ui('This trip is no longer the one open in your journal, so nothing was saved. Close this form and check your trips.',
      'הטיול הזה כבר אינו הטיול הפתוח ביומן, ולכן דבר לא נשמר. אפשר לסגור את הטופס ולבדוק את הטיולים.'));
  }
  if (session.revision !== formTrip.revision) {
    bindForm(); // The traveler is told once. Saving again applies the form to the version now shown.
    throw Error(ui('Your journal changed while this form was open, so nothing was saved. Check the trip, then choose Save again.',
      'היומן השתנה בזמן שהטופס היה פתוח, ולכן דבר לא נשמר. כדאי לבדוק את הטיול ואז לבחור שוב ב״שמירה״.'));
  }
}
// Trips edited in a tab-only journal since their last backup. Leaving the page with any of them asks first.
const unbacked = new Set<string>();
// `fromFile` marks a change that only loads a trip the traveler already has as a file.
async function change(edit: () => void, fromFile = false) {
  for (const dialog of document.querySelectorAll<HTMLElement>('dialog[open]')) clearError(dialog);
  try {
    const recovering = session.mode === 'portable-recovery';
    const result = await session.change(edit);
    if (result === 'ignored') return false;
    if (result === 'loading') {
      fail(ui('Please try this edit again when the journal is ready.', 'נסו לשמור את השינוי שוב כשהיומן יהיה מוכן.'));
      return false;
    }
    if (result === 'superseded') {
      fail(t('העריכה לא נשמרה. היומן השתנה. בדקו את הטיול הנוכחי לפני שתנסו שוב.'));
      return false;
    }
    if (result === 'saved-after-refresh') return true;
    if (recovering && result === 'saved') $('retryLoad').hidden = true;
    renderSelection();
    if (result === 'conflict') {
      const loaded = await load(true);
      // The traveler is about to be told the latest version loaded, so a retry applies to it.
      if (session.trip?.id === formTrip.id) bindForm();
      fail(t(loaded === 'account' ? 'הטיול השתנה במכשיר אחר. הגרסה העדכנית נטענה. אפשר לחזור על העריכה.'
        : 'העריכה לא נשמרה. היומן השתנה. בדקו את הטיול הנוכחי לפני שתנסו שוב.'));
      return false;
    }
    if (result === 'storage-error') {
      fail(ui('This browser could not save the edit. Back up your trip, then free storage or remove a photo and try again.',
        'הדפדפן לא הצליח לשמור את העריכה. גבו את הטיול, פנו מקום או הסירו תמונה ונסו שוב.'));
      return false;
    }
    if (tabOnly() && !fromFile && session.trip) unbacked.add(session.trip.id);
    for (const id of unbacked) if (!session.trips.some(trip => trip.id === id)) unbacked.delete(id);
    msg(noTimeCopy, saveTone(), true);
    return true;
  } catch (error) {
    renderSelection();
    fail(t(errorMessage(error)));
    return false;
  }
}
for (const id of ['login', 'hostedSignIn'] as const) $(id).addEventListener('click', event => {
  if (session.mode === 'guest' && session.guestPersistence === 'memory' && unbacked.size) {
    event.preventDefault();
    msg(() => ui('Back up each temporary trip before signing in. After signing in, import the backups to keep them in your journal.',
      'גבו כל טיול זמני לפני הכניסה לחשבון. לאחר הכניסה, ייבאו את הגיבויים כדי לשמור אותם ביומן.'), 'warning');
    return;
  }
  requestGuestMerge(true, session.mode === 'guest' ? session.trips : []);
});
window.addEventListener('beforeunload', event => {
  if (!tabOnly() || !unbacked.size) return;
  event.preventDefault();
});
// The guest draft is shared by every tab of this browser. A tab follows what another tab saved.
onGuestChange(() => {
  if (portable || sharedRoute) return;
  void session.adoptGuestDraft().then(changed => {
    if (!changed) return;
    renderSelection();
    if (!session.trips.length) start();
  }).catch(error => {
    msg(() => t(errorMessage(error)), 'error');
  });
});

$('trips').onchange = () => {
  session.select(session.trips.find(trip => trip.id === $('trips').value));
  endHint();
  renderSelection();
};
async function move(s: Stop, delta: number) {
  const { trip, day } = session;
  if (!trip) return;
  const moved = await change(() => {
    const list = routeStops(trip, day, t('נקודת מוצא')).filter(x => x.id !== 'base'),
      i = list.findIndex(x => x.id === s.id);
    if (!list[i + delta] || list[i + delta].kind === 'origin') return;
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    list.forEach((x, j) => x.rank = j);
    delete trip.dayNotes[day];
  });
  if (!moved) return;
  // The list was redrawn. Return focus to the same arrow, or its neighbor at the end of the list.
  const arrows = [...rows.get(s.id)?.querySelectorAll<HTMLButtonElement>('.tools button') ?? []];
  (arrows[delta < 0 ? 0 : 1]?.disabled ? arrows[delta < 0 ? 1 : 0] : arrows[delta < 0 ? 0 : 1])?.focus();
}
$('organize').onclick = async () => {
  const { trip, day } = session;
  if (!trip) return;
  const list = routeStops(trip, day, t('נקודת מוצא')).filter(x => x.id !== 'base');
  if (list.some(s => ['pickup', 'dropoff'].includes(s.kind))) {
    hint(() => t('ביום הזה יש נסיעת מונית מתועדת. אפשר להזיז תחנות בנפרד ולשמור על זמני האיסוף וההגעה.'));
    return;
  }
  if (list.filter(s => s.kind === 'visit').length < 2) {
    hint(() => ui('Add at least two stops to this day to get a suggested order.', 'כדי לקבל הצעה לסדר, יש להוסיף ליום הזה שתי תחנות לפחות.'));
    return;
  }
  try {
    const proposed = suggest(list, trip);
    if (proposed.every((s, i) => s.id === list[i].id)) {
      hint(() => ui('These stops are already in the suggested order.', 'התחנות כבר מסודרות לפי הסדר המוצע.'));
      return;
    }
    if (await ask(t('לשמור את הסדר המוצע?\n') + proposed.map(s => displayStopName(s.name)).join(language === 'he' ? ' ← ' : ' → '), ui('Save order', 'שמירת הסדר'))) await change(() => {
      if (!trip) return;
      proposed.forEach((s, i) => s.rank = i);
      delete trip.dayNotes[day];
    });
  } catch (e) {
    fail(t(errorMessage(e)));
  }
};
function field<K extends 'input' | 'select' | 'textarea'>(form: HTMLFormElement, name: string, tag: K): HTMLElementTagNameMap[K] {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLElement) || control.localName !== tag) throw Error('Missing ' + name);
  return control as HTMLElementTagNameMap[K];
}
const editForm = $('editForm'),
  tripForm = $('tripForm');
const ef = {
  name: field(editForm, 'name', 'input'),
  date: field(editForm, 'date', 'input'),
  address: field(editForm, 'address', 'input'),
  time: field(editForm, 'time', 'input'),
  coords: field(editForm, 'coords', 'input'),
  approx: field(editForm, 'approx', 'input'),
  source: field(editForm, 'source', 'select'),
  slot: field(editForm, 'slot', 'select'),
  kind: field(editForm, 'kind', 'select'),
  reviewReason: field(editForm, 'reviewReason', 'input'),
  linkStop: field(editForm, 'linkStop', 'select'),
  notes: field(editForm, 'notes', 'textarea')
};
const tf = {
  title: field(tripForm, 'title', 'input'),
  start: field(tripForm, 'start', 'input'),
  end: field(tripForm, 'end', 'input'),
  home: field(tripForm, 'home', 'input'),
  coords: field(tripForm, 'coords', 'input'),
  rules: field(tripForm, 'rules', 'textarea')
};
function openSettings(fresh: boolean) {
  const { trip } = session;
  creating = fresh;
  bindForm();
  $('deleteTrip').hidden = fresh || !trip;
  const t: Partial<Trip> = fresh ? {} : trip ?? {};
  tf.title.value = t.title || '';
  tf.title.required = fresh || !!t.title;
  tf.title.placeholder = fresh || t.title ? '' : displayTripTitle('');
  tf.start.value = t.start || localToday();
  tf.end.value = t.end || localToday();
  tf.home.value = t.home || '';
  tf.coords.value = t.homeXY?.join(', ') || '';
  tf.rules.value = t.rules || '';
  $('configTitle').textContent = fresh ? ui('New trip', 'טיול חדש') : ui('Trip settings', 'הגדרות טיול');
  $('moreTrip').open = !!(t.homeXY || t.rules);
  $('homeResults').replaceChildren();
  resetPinForm(homePin);
  showPin($('homeState'), tf.coords.value);
  $('config').showModal();
}
function showPin(target: HTMLElement, coordinates: string) {
  target.textContent = coordinates.trim() ? ui('Pin set', 'הסיכה נקבעה') : ui('No map pin yet', 'עדיין אין סיכה במפה');
}
tf.coords.oninput = () => showPin($('homeState'), tf.coords.value);
tf.start.onchange = () => {
  if (tf.end.value && tf.end.value < tf.start.value) tf.end.value = tf.start.value;
};
$('newTrip').onclick = () => openSettings(true);
$('settings').onclick = () => openSettings(false);
$('deleteTrip').onclick = async () => {
  const { trip } = session;
  if (!trip || creating || !await ask(t('למחוק לצמיתות את הטיול ואת כל התחנות שבו?'), t('מחיקת הטיול'))) return;
  if (await change(() => {
    requireFormTrip();
    session.trips = session.trips.filter(item => item.id !== formTrip.id);
    session.select(null);
  })) $('config').close();
};
$('tripForm').onsubmit = async e => {
  e.preventDefault();
  clearError($('config'));
  if (tf.end.value < tf.start.value) {
    fail(ui('The end date cannot be before the start date.', 'תאריך הסיום אינו יכול להיות לפני תאריך ההתחלה.'));
    return;
  }
  if (!await pinBeforeSave(homePin, creating ? '' : session.trip?.home ?? '', creating ? null : session.trip)) return;
  try {
    const fields = {
      title: tf.title.value,
      start: tf.start.value,
      end: tf.end.value,
      home: tf.home.value,
      homeXY: points(tf.coords.value),
      rules: tf.rules.value
    };
    const ok = await change(() => {
      if (creating) {
        const trip = cleanTrip({
          ...fields,
          stops: []
        });
        session.trips.push(trip);
        session.select(trip);
      } else {
        requireFormTrip();
        const { trip } = session;
        if (!trip) return;
        if (fields.home !== trip.home || JSON.stringify(fields.homeXY) !== JSON.stringify(trip.homeXY)) {
          for (const s of trip.stops.filter(s => s.kind === 'origin')) {
            const matchesHome = s.xy && trip.homeXY
              ? s.xy[0] === trip.homeXY[0] && s.xy[1] === trip.homeXY[1]
              : trip.home && (s.name === trip.home || s.address === trip.home);
            if (!matchesHome) continue;
            s.name = fields.home || t('נקודת מוצא');
            s.xy = fields.homeXY;
            s.address = '';
            trip.edges = trip.edges.filter(edge => edge.a !== s.id && edge.b !== s.id);
          }
          // A saved leg from the home base starts at the place it used to be.
          if (JSON.stringify(fields.homeXY) !== JSON.stringify(trip.homeXY)) trip.edges = trip.edges.filter(edge => edge.a !== 'base');
        }
        Object.assign(trip, fields);
      }
    });
    if (ok) $('config').close();
  } catch (ex) {
    fail(t(errorMessage(ex)));
  }
};
function hostedSizeWithPhotos(photos: string[]) {
  const { trip } = session;
  const saved = trip?.stops.find(stop => stop.id === draftId)?.photos ?? [];
  return JSON.stringify({ trips: session.trips }).length + JSON.stringify(photos).length - JSON.stringify(saved).length;
}
function updatePhotos() {
  const panel = $('photoPanel');
  panel.hidden = !draftPhotos.length;
  panel.replaceChildren(...draftPhotos.map((src, i) => {
    const figure = dom('figure'),
      image = dom('img');
    image.src = src;
    image.alt = t('תמונה מצורפת ') + (i + 1);
    figure.append(image, button(t('הסרת תמונה ') + (i + 1), () => {
      draftPhotos.splice(i, 1);
      if (!draftPhotos.length && ef.source.value === 'photo') ef.source.value = '';
      updatePhotos();
    }));
    return figure;
  }));
  const attached = draftPhotos.length ? quantity(draftPhotos.length, ' תמונות מצורפות', 'photo attached', 'photos attached') : '';
  const percent = session.mode === 'account' ? Math.min(100, Math.round(hostedSizeWithPhotos(draftPhotos) * 100 / journalCharacterLimit)) : 0;
  const usage = session.mode === 'account' ? ui(percent + '% of journal storage used', percent + '% משטח היומן בשימוש') : '';
  $('photoStatus').textContent = [attached, usage].filter(Boolean).join(' · ');
}
function relatedStops() {
  const { trip } = session;
  const select = ef.linkStop;
  select.replaceChildren(new Option(t('תחנה עצמאית'), ''));
  if (!trip) return;
  for (const s of trip.stops.filter(s => s.date === ef.date.value && s.id !== draftId && s.kind === 'visit').sort((a, b) => a.rank - b.rank)) {
    select.add(new Option(displayStopName(s.name) + (s.time ? ' · ' + s.time : ''), s.id));
  }
}
async function addPhoto(file: File | undefined) {
  if (!file) return;
  if (draftPhotos.length >= 3) {
    $('photoStatus').textContent = t('ניתן לצרף עד שלוש תמונות לתחנה');
    return;
  }
  const generation = fileEpoch;
  photoBusy = true;
  $('photoStatus').textContent = t('מכין את התמונה…');
  try {
    const content = await preparePhoto(file);
    if (generation !== fileEpoch) return;
    if (session.mode === 'account' && hostedSizeWithPhotos([...draftPhotos, content]) > journalCharacterLimit - 32000) {
      throw Error(t('אין די מקום לתמונה זו. אפשר לגבות את הטיול ולהסיר תמונות ישנות.'));
    }
    draftPhotos.push(content);
    if (!ef.source.value) ef.source.value = 'photo';
    updatePhotos();
  } catch (e) {
    if (generation === fileEpoch) $('photoStatus').textContent = t(errorMessage(e));
  } finally {
    if (generation === fileEpoch) photoBusy = false;
    $('photo').value = '';
  }
}
$('photo').onchange = () => addPhoto($('photo').files?.[0]);
ef.date.onchange = relatedStops;
function syncNameField() {
  const purchase = ef.source.value === 'card' && ['visit', 'uncertain', 'remote'].includes(ef.kind.value);
  ef.name.required = !purchase;
  ef.name.placeholder = purchase ? displayStopName(unidentifiedMerchant) : '';
}
ef.source.onchange = ef.kind.onchange = syncNameField;
const primarySource = (sources: Source[]) => sources.find(source => source !== 'photo') ?? sources[0];
function openStop(s: Partial<Stop> = {}) {
  const { trip, day } = session;
  if (!trip) return;
  fileEpoch++;
  photoBusy = false;
  bindForm();
  draftPhotos = [...(s.photos || [])];
  draftId = s.id || '';
  updatePhotos();
  ef.name.value = s.name === unidentifiedMerchant ? '' : s.name || '';
  ef.date.value = s.date || day;
  ef.date.min = trip.start;
  ef.date.max = trip.end;
  ef.address.value = s.address || '';
  ef.time.value = s.time || '';
  ef.source.value = primarySource(s.sources ?? []) ?? (s.id ? '' : 'manual');
  ef.slot.value = s.slot || '';
  ef.kind.value = s.kind || 'visit';
  ef.reviewReason.value = s.reviewReason || '';
  syncNameField();
  ef.coords.value = s.xy?.join(', ') || '';
  ef.approx.checked = !!s.xy && s.approx === true;
  ef.notes.value = s.notes || '';
  $('georesults').replaceChildren();
  $('removeStop').hidden = !draftId;
  $('moreStop').open = !!draftId;
  resetPinForm(stopPin);
  showPin($('pinState'), ef.coords.value);
  relatedStops();
  $('edit').showModal();
}
ef.coords.oninput = () => showPin($('pinState'), ef.coords.value);
const stopPin: PinForm = {
  address: ef.address,
  coords: ef.coords,
  state: $('pinState'),
  alternative: () => ui('Choose a point on the map.', 'אפשר לבחור נקודה במפה.'),
  opened: 0,
  looking: false,
  unpinned: ''
};
const homePin: PinForm = {
  address: tf.home,
  coords: tf.coords,
  state: $('homeState'),
  alternative: () => ui('Enter coordinates under More settings.', 'אפשר להזין קואורדינטות תחת ״הגדרות נוספות״.'),
  opened: 0,
  looking: false,
  unpinned: ''
};
// Closing a form ends its claim on a lookup that is still on its way.
$('edit').addEventListener('close', () => resetPinForm(stopPin));
$('config').addEventListener('close', () => resetPinForm(homePin));
$('add').onclick = () => openStop();
$('editForm').onsubmit = async e => {
  e.preventDefault();
  clearError($('edit'));
  if (photoBusy) {
    fail(t('התמונה עדיין בעיבוד'));
    return;
  }
  if (!ef.approx.checked && !await pinBeforeSave(stopPin, session.trip?.stops.find(x => x.id === draftId)?.address ?? '', session.trip)) return;
  try {
    const xy = points(ef.coords.value);
    const ok = await change(() => {
      requireFormTrip();
      const { trip } = session;
      if (!trip) return;
      const old = trip.stops.find(x => x.id === draftId);
      if (draftId && !old) throw Error(t('התחנה שנבחרה אינה זמינה'));
      const previous = old?.sources ?? [];
      const primary = primarySource(previous);
      let evidence: string[] = previous;
      if (ef.source.value !== (primary ?? '')) evidence = [ef.source.value, ...previous.filter(source => source !== primary)];
      if (draftPhotos.length) evidence = [...evidence, 'photo'];
      else if (old?.photos.length && ef.source.value !== 'photo') evidence = evidence.filter(source => source !== 'photo');
      const s = cleanStop({
        ...old,
        captureTime: old?.date === ef.date.value && old.time === ef.time.value ? old.captureTime : undefined,
        photoAnchor: old?.date === ef.date.value && old.xy?.toString() === xy?.toString() ? old.photoAnchor : undefined,
        // A photo-backed stop the traveler re-dates, re-times or moves is theirs from then on. Later imports
        // leave it in place, and a retry of the same photo finds it on its corrected day.
        edited: old?.edited || (old?.sources.includes('photo')
          && (old.date !== ef.date.value || old.time !== ef.time.value || old.xy?.toString() !== xy?.toString())) || undefined,
        photos: draftPhotos,
        id: draftId || undefined,
        name: ef.name.value,
        date: ef.date.value,
        address: ef.address.value,
        time: ef.time.value,
        xy,
        approx: xy !== null && ef.approx.checked,
        slot: ef.slot.value,
        kind: ef.kind.value,
        reviewReason: ef.reviewReason.value,
        notes: ef.notes.value,
        sources: evidence,
        rank: old?.date === ef.date.value ? old.rank : 1 + Math.max(0, ...trip.stops.filter(s => s.date === ef.date.value).map(s => s.rank))
      });
      prepareApproximateLocation(old, s);
      if (ef.linkStop.value) {
        const target = trip.stops.find(x => x.id === ef.linkStop.value && x.date === s.date);
        if (!target) throw Error(t('התחנה שנבחרה אינה זמינה'));
        combineEvidence(target, s);
        if (s.name !== target.name) {
          const note = t('אירוע מקושר: ') + displayStopName(s.name);
          if (!target.notes.includes(note)) target.notes = [target.notes, note].filter(Boolean).join(' · ');
        }
        if (old) {
          trip.stops = trip.stops.filter(x => x.id !== old.id);
          trip.edges = trip.edges.filter(e => e.a !== old.id && e.b !== old.id);
          delete trip.dayNotes[old.date];
        }
      } else if (old) {
        updateRoutesForStopEdit(trip, old, s);
        if (old.xy?.toString() !== s.xy?.toString() || old.date !== s.date) delete trip.dayNotes[old.date];
        Object.assign(old, s);
        // Assigning keeps what the edit left out. A capture time or anchor the edit dropped goes with it.
        if (!s.captureTime) delete old.captureTime;
        if (!s.photoAnchor) delete old.photoAnchor;
        if (!s.reviewReason) delete old.reviewReason;
      } else {
        mergeStops(trip, [s]);
      }
      session.select(trip, s.date);
    });
    if (ok) $('edit').close();
  } catch (ex) {
    $('moreStop').open = true; // The coordinates that failed to parse sit under the extra fields.
    fail(t(errorMessage(ex)));
  }
};
$('removeStop').onclick = async () => {
  if (!await ask(t('למחוק את התחנה מהטיול?'), t('מחיקת התחנה'))) return;
  const ok = await change(() => {
    requireFormTrip();
    const { trip, day } = session;
    if (!trip) return;
    trip.stops = trip.stops.filter(s => s.id !== draftId);
    trip.edges = trip.edges.filter(e => e.a !== draftId && e.b !== draftId);
    delete trip.dayNotes[day];
  });
  if (ok) $('edit').close();
};
function endPick() {
  pick = false;
  map.getContainer().classList.remove('pickmode');
  endHint();
  $('edit').showModal();
}
$('pick').onclick = () => {
  pick = true;
  map.getContainer().classList.add('pickmode');
  $('edit').close();
  hint(() => t('לחץ על המקום במפה. אפשר להתקרב לפני הבחירה.') + ui(' Press Escape to cancel.', ' Escape מבטל את הבחירה.'), 'warning');
  // Choosing a point needs as much of the map as the phone can show.
  viewList(false, 'peek');
};
map.on('click', e => {
  if (!pick) return;
  ef.coords.value = [e.latlng.lat, wrapLongitude(e.latlng.lng)].map(n => n.toFixed(6)).join(', ');
  showPin($('pinState'), ef.coords.value);
  endPick();
});
document.addEventListener('keydown', event => {
  if (!pick || event.key !== 'Escape') return;
  // The same key press would otherwise close the editor the moment it reopens.
  event.preventDefault();
  setTimeout(endPick);
});
interface Place {
  name: string;
  coordinates: string;
}
// Asks OpenStreetMap for matching places. Results in the region of the trip's existing pins rank first.
async function searchPlaces(query: string, trip: Trip | null): Promise<Place[]> {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&accept-language=' + locale() + '&q=' + encodeURIComponent(query);
  const pins = trip ? [...trip.stops.map(stop => stop.xy), trip.homeXY].filter(xy => !!xy) : [];
  if (pins.length) {
    const lat = pins.map(xy => xy[0]),
      lon = pins.map(xy => xy[1]),
      margin = .3;
    // Only a region tens of kilometres wide is sent, never a pin's own position.
    url += '&viewbox=' + [Math.min(...lon) - margin, Math.max(...lat) + margin, Math.max(...lon) + margin, Math.min(...lat) - margin].map(n => n.toFixed(1)).join(',');
  }
  const res = await fetch(url);
  if (!res.ok) throw Error('Address search unavailable');
  const payload: unknown = await res.json();
  if (!Array.isArray(payload)) throw Error('Address search unavailable');
  return payload.filter((a): a is {
    display_name: string;
    lat: string;
    lon: string;
  } => isRecord(a) && typeof a.display_name === 'string' && typeof a.lat === 'string' && typeof a.lon === 'string').map(a => ({
    name: a.display_name,
    coordinates: a.lat + ', ' + a.lon
  }));
}
async function findOnMap(query: string, trip: Trip | null, target: HTMLElement, trigger: HTMLButtonElement, choose: (coordinates: string) => void) {
  const q = query.trim();
  if (!q) {
    target.textContent = ui('Enter an address or a place name first.', 'יש להזין תחילה כתובת או שם מקום.');
    return;
  }
  target.textContent = t('מחפש ב־OpenStreetMap…');
  trigger.disabled = true;
  try {
    const results = await searchPlaces(q, trip);
    target.replaceChildren(...results.map(place => button(place.name, () => {
      choose(place.coordinates);
      target.textContent = t('המיקום נבחר.');
    })));
    if (!results.length) target.textContent = t('לא נמצאה כתובת. אפשר לבחור נקודה במפה.');
  } catch {
    target.textContent = t('חיפוש כתובת אינו זמין כרגע. אפשר לבחור נקודה במפה.');
  } finally {
    setTimeout(() => trigger.disabled = false, 1100);
  }
}
// The generation counter prevents late lookups from reaching a closed or reused form.
interface PinForm {
  address: HTMLInputElement;
  coords: HTMLInputElement;
  state: HTMLElement;
  alternative: () => string;
  opened: number;
  looking: boolean;
  /** The address the traveler chose to keep without a pin after being told none was found. */
  unpinned: string;
}
function resetPinForm(form: PinForm) {
  form.opened++;
  form.looking = false;
  form.unpinned = '';
}
/** Geocode an unpinned address before saving; a second save accepts an unresolved address. */
async function pinBeforeSave(form: PinForm, saved: string, trip: Trip | null) {
  if (form.looking) return false;
  const address = form.address.value.trim();
  if (!address || form.coords.value.trim() || address === saved || address === form.unpinned) return true;
  const opened = form.opened;
  form.looking = true;
  form.state.textContent = t('מחפש ב־OpenStreetMap…');
  let found: string | undefined,
    problem = '';
  try {
    found = (await searchPlaces(address, trip))[0]?.coordinates;
    if (!found) problem = ui('This address was not found on the map. ', 'הכתובת לא נמצאה במפה. ');
  } catch {
    problem = ui('Address search is unavailable right now. ', 'חיפוש הכתובת אינו זמין כרגע. ');
  }
  // The form was closed or reused while the answer was on its way. Nothing is saved without another Save.
  if (opened !== form.opened) return false;
  form.looking = false;
  if (form.address.value.trim() !== address) {
    showPin(form.state, form.coords.value);
    return false;
  }
  // The traveler set the pin while the lookup ran.
  if (form.coords.value.trim()) return true;
  if (!found) {
    form.unpinned = address;
    showPin(form.state, '');
    fail(problem + form.alternative() + ui(' Or choose Save again to keep it without a pin.', ' אפשר גם לבחור שוב ב״שמירה״ כדי לשמור בלי סיכה.'));
    return false;
  }
  form.coords.value = found;
  showPin(form.state, found);
  return true;
}
$('findPlace').onclick = () => findOnMap(ef.address.value.trim() || ef.name.value, session.trip, $('georesults'), $('findPlace'), coordinates => {
  ef.coords.value = coordinates;
  showPin($('pinState'), coordinates);
});
$('findHome').onclick = () => findOnMap(tf.home.value, creating ? null : session.trip, $('homeResults'), $('findHome'), coordinates => {
  tf.coords.value = coordinates;
  showPin($('homeState'), coordinates);
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) b.onclick = () => b.closest('dialog')?.close();
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => clearError(dialog));
  dialog.addEventListener('input', () => clearError(dialog));
}
enableSharing(() => session.trip, portable, () => session.day, () => session.mode === 'account');
$('logout').onclick = async () => {
  // The question closes the menu that holds Sign out. Moving to the button that opens the menu first
  // gives the question a place to return the keyboard to when it is answered.
  $('menu').hidePopover();
  $('menuButton').focus();
  const confirmed = ask(ui('Sign out of hayiti?', 'לצאת מהחשבון?'), t('יציאה מהחשבון'));
  $('confirmNo').focus();
  if (await confirmed) window.open('/signout-with-chatgpt?return_to=%2Fjournal.html', '_top');
};
$('export').onclick = () => {
  const { trip } = session;
  if (!trip) return;
  const blob = new Blob([JSON.stringify({
    format: 'hayiti/1',
    trip
  })], {
    type: 'application/json'
  });
  const u = URL.createObjectURL(blob),
    a = dom('a');
  a.href = u;
  a.download = 'Hayiti-' + trip.start + '.json';
  a.click();
  unbacked.delete(trip.id);
  setTimeout(() => URL.revokeObjectURL(u), 1000);
};
$('import').onclick = () => {
  $('sources').showModal();
  tab(session.trip ? 'connected' : 'files');
};
function tab(name: string | undefined) {
  for (const n of ['files', 'connected', 'paste'] as const) $(n).hidden = n !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.classList.toggle('selected', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.onclick = () => tab(b.dataset.tab);
$('copyPrompt').onclick = async () => {
  const { trip } = session;
  const selectedNames = new Set([...$('connected').querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value));
  const requested = reportSources.filter(source => selectedNames.has(sourceNames[source]));
  const checks = requested.map(source => sourceNames[source]).join(', ');
  if (!trip || !checks) {
    $('promptResult').textContent = t('בחר טיול ומקור אחד לפחות.');
    return;
  }
  let prompt = t('שחזר את המסלול שלי מ־') + trip.start + t(' עד ') + trip.end + t(' לפי ') + checks + t('. הצלֵב מקומות ותאריכי אירועים, שמור בנפרד רכישות מרחוק וסמן אי־ודאות. השתמש בכללי הטיול שלי. באמצעות אפליקציית ״הייתי״ קרא תחילה list_trips ו-get_day והצג לי תחנות מוצעות לאישור. רק אחרי שאאשר, שמור את התחנות שבחרתי באמצעות add_trip_stops בטיול ') + trip.id + t('. העבר רק את פרטי המסלול הנחוצים, ללא מספרי חשבון, קודי כרטיס או גוף המייל. אם החיבור לאפליקציית ״הייתי״ אינו זמין, החזר קובץ JSON לייבוא במבנה {"format":"hayiti-stops/1","stops":[{"name":"שם","date":"YYYY-MM-DD","sources":["email"],"refs":["מזהה מקור יציב"]}]}.');
  if (portable || session.mode !== 'account') prompt = t('לפי ') + checks + t(' חשב את תחנות הטיול שלי מ־') + trip.start + t(' עד ') + trip.end + t('. החזר קובץ JSON במבנה {"format":"hayiti-stops/1","stops":[{"name":"שם","date":"YYYY-MM-DD","address":"","sources":["email"],"refs":["מזהה יציב"]}]}. לכל תחנה צרף רק מקור משלה (card/email/calendar/ticket/whatsapp) ומיקום מאומת במערך xy בסדר קו רוחב, קו אורך. הימנע מקודי כרטיס ומספרי חשבונות.');
  prompt += ui(' Report the actual outcome for each requested source over these dates. For Finances, check for linked credit or debit purchase accounts before searching transactions. Distinguish missing access, no accounts, syncing, incomplete searches, errors, zero transactions, and purchases without a place. Never infer disconnection from missing results.', ' יש לדווח מה נבדק בכל מקור ובאילו תאריכים. ב־Finances יש לבדוק תחילה אם קיים חשבון מקושר לרכישות באשראי או בדביט. יש להבחין בין מקור מנותק, חוסר בחשבונות, סנכרון, חיפוש חלקי, שגיאה, אפס עסקאות ורכישות ללא מקום מזוהה.');
  if (requested.includes('finances')) prompt += ui(' Record confirmed in-person purchases as visits, even without a branch or merchant name. Use the approved public place label or omit the name. Leave unverified coordinates empty.',
    ' רכישה שבוצעה במקום היא ביקור גם אם הסניף או שם העסק אינם ידועים. יש להשתמש בשם המקום שאישרתי לשיתוף או להשאיר את השם ריק. אם המיקום לא אומת, יש להשאיר את הקואורדינטות ריקות.');
  const outcomes = requested.map(source => source + ' (' + statesBySource[source].join(', ') + ')').join(', ');
  prompt += ui(' Include start, end, and sourceChecks in add_trip_stops or the import JSON, even when stops is empty. Report only sources you checked. Use these values for each source. ',
    ' יש לכלול start, end ו־sourceChecks בקריאה ל־add_trip_stops או בקובץ הייבוא, גם כאשר stops ריק. יש לדווח רק על מקורות שנבדקו. אלה הערכים המותרים לכל מקור. ') + outcomes + '.';
  try {
    await navigator.clipboard.writeText(prompt);
    $('promptResult').textContent = t('הבקשה הועתקה. אפשר להדביק אותה בשיחה עם החיבורים שלך.');
  } catch {
    $('promptResult').textContent = prompt;
  }
};
$('discardDraft').onclick = async () => {
  if (!await ask(t('למחוק את טיוטת הטיול שלא ניתן לקרוא מהדפדפן הזה לצמיתות?'), t('מחיקת טיוטה שלא ניתן לקרוא'))) return;
  try {
    await discardGuest();
    $('discardDraft').hidden = true;
    await load();
  } catch (error) {
    msg(errorMessage(error));
  }
};
$('reload').onclick = () => load().catch(e => msg(errorMessage(e)));
$('parseText').onclick = () => {
  const { trip, day } = session;
  if (!trip) return fail(t('בחר טיול תחילה'));
  if (!$('pasted').value.trim()) return;
  $('sources').close();
  openStop(pastedStop($('pasted').value, day, $('pasteSource').value));
};
$('file').onchange = () => {
  const file = $('file').files?.[0];
  if (file) void previewFile(file);
};
function googlePinSummary({ added, linked, skipped, datesOutsideTrip, unresolved, previouslyRemoved }: GooglePinResult) {
  const parts = [ui('Google Pins · ' + added + ' new · ' + linked + ' updated · ' + skipped + ' already saved',
    'סיכות Google · ' + added + ' חדשות · ' + linked + ' עודכנו · ' + skipped + ' כבר שמורות')];
  if (previouslyRemoved) parts.push(previouslyRemoved === 1
    ? ui('One previously removed pin left out', 'סיכה אחת שהוסרה בעבר נשארה מחוץ לטיול')
    : ui(previouslyRemoved + ' previously removed pins left out', previouslyRemoved + ' סיכות שהוסרו בעבר נשארו מחוץ לטיול'));
  if (datesOutsideTrip) {
    const dates = datesOutsideTrip === 1 ? ui('One date falls', 'תאריך אחד נמצא')
      : ui(datesOutsideTrip + ' dates fall', datesOutsideTrip + ' תאריכים נמצאים');
    parts.push(dates + ui(' outside the trip. Pins without a day appear in Whole trip.',
      ' מחוץ לטווח הטיול. סיכות ללא יום מופיעות במבט על כל הטיול.'));
  }
  if (unresolved) parts.push(unresolved === 1
    ? ui('One pin skipped because its location is unknown', 'סיכה אחת דולגה כי המיקום שלה אינו ידוע')
    : ui(unresolved + ' pins skipped because their locations are unknown', unresolved + ' סיכות דולגו כי המיקום שלהן אינו ידוע'));
  return parts.join(' · ');
}
function backupRouteSummary(count: number) {
  return quantity(count, ' מקטעי מסלול מהגיבוי', 'route segment from backup', 'route segments from backup');
}
async function previewFile(f: File, order?: 'day-first' | 'month-first') {
  const target = $('preview');
  target.replaceChildren();
  try {
    if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|gif|avif)$/i.test(f.name)) {
      if (!session.trip) throw Error(t('יש לבחור טיול לפני צירוף תמונה'));
      $('sources').close();
      openStop({
        sources: ['ticket']
      });
      await addPhoto(f);
      return;
    }
    if (f.size > 7500000 && !(portable && /\.json$/i.test(f.name))) throw Error(t('הקובץ גדול מדי'));
    const raw = await f.text();
    let result: ImportResult = {
        stops: [],
        omitted: 0
      },
      backup: ReturnType<typeof prepareTripBackup> | undefined;
    let backupValue: unknown;
    if (/\.json$/i.test(f.name)) {
      const o = JSON.parse(raw);
      if (isRecord(o) && o.format === 'hayiti-routes/1') {
        const active = session.trip;
        if (!active) throw Error(t('יש לבחור טיול תחילה'));
        const revision = session.revision;
        const plan = prepareRouteImport(active, o);
        if (plan.correctedRides) target.append(dom('p', ui('Taxi rides to reclassify', 'נסיעות מונית שסיווגן ישתנה') + ' · ' + plan.correctedRides));
        if (plan.reorderedDays) {
          target.append(dom('p', ui('Days with a new stop order', 'ימים עם סדר תחנות חדש') + ' · ' + plan.reorderedDays));
        }
        if (plan.updated || plan.unchanged || !plan.reorderedDays) {
          target.append(dom('p', quantity(plan.updated, ' מקטעים לעדכון', 'route segment to update', 'route segments to update') +
            ' · ' + quantity(plan.unchanged, ' מקטעים כבר שמורים', 'segment already saved', 'segments already saved')));
        }
        if (plan.updated || plan.reorderedDays) target.append(button(ui('Save routes', 'שמירת מסלולים'), async () => {
          const ok = await change(() => {
            const trip = session.trip;
            if (!trip || trip !== active || session.revision !== revision) throw Error(t('הטיול השתנה. יש לבחור את קובץ הייבוא מחדש.'));
            trip.stops = plan.stops;
            trip.edges = plan.edges;
          });
          if (ok) $('sources').close();
        }));
        return;
      }
      if (['hayiti/1', 'masluli/1'].includes(o.format)) {
        backupValue = o.trip;
        backup = prepareTripBackup(backupValue, session.trips);
      } else {
        result = importEvidencePackage(o, session.trip);
      }
    } else if (/\.csv$/i.test(f.name)) {
      result = await importCsv(raw, order);
      if (result.needsDateOrder) {
        target.append(dom('p', ui('Which date order does this file use?', 'מהו סדר התאריכים בקובץ?')),
          button(ui('Month / day / year', 'חודש / יום / שנה'), () => previewFile(f, 'month-first')),
          button(ui('Day / month / year', 'יום / חודש / שנה'), () => previewFile(f, 'day-first')));
        return;
      }
    } else if (/\.ics$/i.test(f.name)) result = await importIcs(raw, t);else {
      if (!session.trip) throw Error(t('יש לבחור טיול תחילה'));
      $('sources').close();
      openStop(pastedStop(raw, session.day, /\.eml$/i.test(f.name) ? 'email' : 'manual'));
      return;
    }
    if (backup && session.mode === 'guest') await checkGuestBackup();
    if (!backup && !session.trip) throw Error(t('יש ליצור טיול לפני ייבוא תחנות'));
    const active = session.trip;
    const valid = backup || !active ? [] : result.stops.filter(s => s.date >= active.start && s.date <= active.end);
    const pinPreview = backup?.pins ?? result.pinPreview;
    if (backup) {
      target.append(dom('p', displayTripTitle(backup.trip.title) + ' · ' + quantity(backup.recordCount, ' רשומות', 'record', 'records')));
      if (backup.routes) target.append(dom('p', backupRouteSummary(backup.routes)));
    } else {
      if (result.stops.length || !pinPreview) target.append(dom('p', (language === 'en' && valid.length === 1 ?
        '1 record within the trip dates · ' : valid.length + t(' רשומות בטווח הטיול · ')) +
        (result.omitted + result.stops.length - valid.length) + t(' דולגו')));
    }
    if (pinPreview) target.append(dom('p', googlePinSummary(pinPreview)));
    if (active && pinPreview?.previouslyRemoved && result.googlePins) {
      const ids = new Set(active.removedGooglePinIds);
      const candidates = new Map<string, Record<string, unknown>>();
      for (const pin of result.googlePins) {
        if (isRecord(pin) && typeof pin.id === 'string' && ids.has(pin.id)) candidates.set(pin.id, pin);
      }
      const details = dom('details');
      const label = dom('label', ui('Removed pin', 'סיכה שהוסרה'));
      const select = dom('select');
      label.htmlFor = select.id = 'restoreGooglePinSelection';
      for (const [id, pin] of candidates) select.add(new Option(String(pin.name), id));
      const actions = dom('div', undefined, 'actions');
      details.append(dom('summary', ui('Restore a removed pin', 'שחזור סיכה שהוסרה')), label, actions);
      actions.append(select, button(ui('Restore selected pin', 'שחזור הסיכה שנבחרה'), async () => {
          const ok = await change(() => {
            const trip = session.trip;
            if (!trip || trip.id !== active.id || trip.start !== active.start || trip.end !== active.end) {
              throw Error(t('הטיול השתנה. יש לבחור את קובץ הייבוא מחדש.'));
            }
            restoreGooglePin(trip, candidates.get(select.value));
          });
          if (ok) await previewFile(f, order);
        }));
      target.append(details);
    }
    const checks = Object.entries(isRecord(result.checks) ? result.checks : {}).filter(([key, status]) => validOutcome(key, status));
    if (!backup && !valid.length && !checks.length && !pinPreview?.added && !pinPreview?.linked) return;
    const action = backup ? t('טעינת הטיול') : pinPreview && !valid.length
      ? ui('Save Google Pins', 'שמירת סיכות Google') : t('מיזוג התחנות');
    target.append(button(action, async () => {
      let test: MergeResult | undefined, savedPins: GooglePinResult | undefined;
      let savedRoutes = 0;
      const ok = await change(() => {
        if (backup) {
          const restored = prepareTripBackup(backupValue, session.trips);
          const index = session.trips.findIndex(trip => trip.id === restored.trip.id);
          if (index < 0) session.trips.push(restored.trip);
          else session.trips[index] = restored.trip;
          session.select(restored.trip);
          test = restored.stops;
          savedPins = restored.pins;
          savedRoutes = restored.routes;
        } else {
          const { trip } = session;
          if (!trip || !active || trip.id !== active.id || trip.start !== active.start || trip.end !== active.end) {
            throw Error(t('הטיול השתנה. יש לבחור את קובץ הייבוא מחדש.'));
          }
          test = mergeStops(trip, valid);
          if (result.googlePins?.length) savedPins = mergeGooglePins(trip, result.googlePins);
          trip.checks ||= {};
          for (const [key, status] of checks) if (member(reportSources, key) && validOutcome(key, status)) trip.checks[key] = {
            status,
            start: trip.start,
            end: trip.end,
            at: new Date().toISOString()
          };
        }
      }, !!backup);
      if (ok) {
        $('sources').close();
        const done = test;
        if (done && session.trip?.id === (backup?.trip.id ?? active?.id)) msg(() => {
          const summaries = [];
          if (done.added || done.linked || done.skipped || !savedPins) {
            summaries.push(ui('Added: ' + done.added + ' · Matched: ' + done.linked + ' · Already present: ' + done.skipped,
              'נוספו ' + done.added + ' תחנות · הוצלבו ' + done.linked + ' · כבר קיימות ' + done.skipped));
          }
          if (savedPins) summaries.push(googlePinSummary(savedPins));
          if (savedRoutes) summaries.push(backupRouteSummary(savedRoutes));
          return summaries.join(' · ');
        });
      }
    }));
  } catch (e) {
    target.textContent = t(errorMessage(e));
  } finally {
    $('file').value = '';
  }
}
// On a phone the list is a sheet over the map. Showing the list raises it, and showing the map lowers a full sheet.
function viewList(value: boolean, mapHeight: 'half' | 'peek' = 'half') {
  if (sheet.narrow && (value || sheet.stop === 'full' || mapHeight === 'peek')) sheet.rest(value ? 'full' : mapHeight);
  if (!value) fitRoute();
}
$('edit').addEventListener('cancel', () => {
  fileEpoch++;
  photoBusy = false;
});
function localizeControls() {
  // The panel takes the side where reading starts, so the zoom buttons and the map credit take the other one.
  const corner = language === 'he' ? 'bottomleft' : 'bottomright';
  map.attributionControl.setPosition(corner);
  map.zoomControl.setPosition(corner);
  sheet.relabel();
  for (const [direction, hebrew, english] of [['in', 'התקרבות', 'Zoom in'], ['out', 'התרחקות', 'Zoom out']]) {
    const zoom = map.getContainer().querySelector<HTMLElement>('.leaflet-control-zoom-' + direction);
    if (!zoom) continue;
    zoom.title = language === 'he' ? hebrew : english;
    zoom.setAttribute('aria-label', zoom.title);
  }
}
function refreshLanguage() {
  localizeControls();
  basemap.relabel();
  showStreetMapNote();
  $('status').textContent = currentStatus();
  render();
}
$('trySample').onclick = () => void change(() => {
  const sample = cleanTrip(sampleTrip.trip);
  if (!session.trips.some(trip => trip.id === sample.id)) session.trips.push(sample);
  session.select(session.trips.find(trip => trip.id === sample.id));
}, true);
$('welcomeNew').onclick = () => openSettings(true);
function start() {
  $('retryLoad').hidden = true;
  load().catch(e => {
    msg(() => t(errorMessage(e)) + ui(' Choose Try again.', ' אפשר לבחור ב״ניסיון נוסף״.'), 'error');
    $('retryLoad').hidden = false;
  });
}
$('retryLoad').onclick = start;
// Stops that ChatGPT saved while the traveler was away appear when they come back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || portable || sharedRoute || session.mode !== 'account') return;
  if (document.querySelector('dialog[open]:not(#sources)')) return;
  load(false, true).catch(() => { /* The journal on screen stays as it is. Refresh journal reports failures. */ });
});
localizeControls();
showConnections();
start();
