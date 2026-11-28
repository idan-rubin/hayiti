import { language } from './language.ts';

export type SheetStop = 'peek' | 'half' | 'full';

const order: SheetStop[] = ['peek', 'half', 'full'];

/** Must match the sheet's media query in journal.css. */
export const sheetLayout = '(max-width: 559px), (max-width: 820px) and (min-height: 541px)';

/**
 * On a narrow screen with height to spare the panel is a sheet over the map. It rests at one of three heights, chosen with the handle:
 * a tap raises or lowers it, a drag settles on the nearest height, and the up and down arrow keys step through all three.
 * On a wide screen the panel sits beside the route and this height is unused.
 * `behind` is what a full sheet covers. `onSettle` runs after the traveler moves the sheet, with the height it left.
 */
export function createSheet(panel: HTMLElement, handle: HTMLButtonElement, behind: HTMLElement, peek: () => number, preview: () => number, onSettle: (from: SheetStop) => void) {
  const narrow = matchMedia(sheetLayout);
  const portrait = matchMedia('(orientation: portrait) and (min-height: 541px) and (max-width: 820px)');
  let stop: SheetStop = 'half',
    drag: { y: number, height: number, moved: boolean } | null = null,
    dragged = false;
  // The full sheet leaves the bar above it uncovered. The lowest stop is as tall as the caller says the trip's heading is.
  const heights = () => {
    const full = Math.max(240, innerHeight - 64);
    // Fit the first visits at rest when possible, leaving at least a quarter of the portrait screen for the map.
    const day = portrait.matches ? Math.min(preview(), innerHeight * .75) : 0;
    return { peek: Math.min(full, Math.max(96, peek())), half: Math.ceil(Math.max(innerHeight * .55, day)), full };
  };
  const setHeight = (pixels: number) => document.documentElement.style.setProperty('--sheet', pixels + 'px');
  function rest(next: SheetStop) {
    const raised = stop === 'peek' && next !== 'peek';
    stop = next;
    document.body.dataset.sheet = next;
    // In a short window the lowered sheet is no scroller, and a browser may hand back the offset it had before.
    if (raised) panel.scrollTop = 0;
    setHeight(heights()[next]);
    // A full sheet covers the map, so the keyboard skips the controls and pins behind it.
    behind.inert = narrow.matches && next === 'full';
    handle.setAttribute('aria-expanded', String(next === 'full'));
    handle.setAttribute('aria-label', next === 'full'
      ? language === 'he' ? 'הקטנת הרשימה כדי לראות את המפה' : 'Lower the list to see the map'
      : language === 'he' ? 'הגדלת הרשימה' : 'Raise the list');
  }
  function settle(next: SheetStop) {
    const from = stop;
    rest(next);
    onSettle(from);
  }
  handle.addEventListener('pointerdown', event => {
    drag = { y: event.clientY, height: panel.getBoundingClientRect().height, moved: false };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    const raised = drag.y - event.clientY;
    if (Math.abs(raised) > 6) drag.moved = true;
    if (!drag.moved) return;
    const { peek, full } = heights();
    panel.dataset.dragging = '';
    setHeight(Math.max(peek, Math.min(full, drag.height + raised)));
  });
  function release() {
    if (!drag) return;
    dragged = drag.moved;
    drag = null;
    delete panel.dataset.dragging;
    if (!dragged) return;
    const height = panel.getBoundingClientRect().height;
    const nearest = Object.entries(heights()).sort((a, b) => Math.abs(a[1] - height) - Math.abs(b[1] - height))[0][0];
    settle(nearest as SheetStop);
  }
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  handle.addEventListener('click', () => {
    // The click that ends a drag has already been answered.
    if (dragged) dragged = false;
    else settle(stop === 'half' ? 'full' : 'half');
  });
  function raiseForFocus(target: EventTarget | null) {
    if (!narrow.matches || stop !== 'peek' || !(target instanceof HTMLElement) || target === handle || !panel.contains(target)) return;
    // Measured from the top of the sheet, so the answer is the same while the sheet is still on its way down.
    const box = target.getBoundingClientRect(), top = panel.getBoundingClientRect().top;
    if (box.top >= top && box.bottom <= top + heights().peek) return;
    settle('half');
    // The list has room for the row once the sheet has finished rising.
    setTimeout(() => {
      if (document.activeElement === target) target.scrollIntoView({ block: 'nearest' });
    }, 260);
  }
  panel.addEventListener('focusin', event => raiseForFocus(event.target));
  handle.addEventListener('keydown', event => {
    const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(stop) + step))];
    if (next !== stop) settle(next);
  });
  addEventListener('resize', () => rest(stop));
  narrow.addEventListener('change', () => raiseForFocus(document.activeElement));
  rest(stop);
  return {
    get stop() {
      return stop;
    },
    get narrow() {
      return narrow.matches;
    },
    /**
     * How much of the map the sheet covers, known before its transition ends.
     * A full sheet hides the whole map, so this is the half height the handle lowers it to next.
     */
    get cover() {
      return narrow.matches ? heights()[stop === 'full' ? 'half' : stop] : 0;
    },
    rest,
    refreshHeight() {
      if (!drag?.moved) setHeight(heights()[stop]);
    },
    relabel: () => rest(stop)
  };
}
